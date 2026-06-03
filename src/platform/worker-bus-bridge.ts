/**
 * worker-bus-bridge.ts
 *
 * Host-side factory that spawns one Web Worker per plugin compartment and
 * wires it into the existing PlatformEventBus.
 *
 * Responsibilities:
 *   - Spawn a Worker running plugin-worker.ts
 *   - Send it an "init" message with the plugin name, policy and source code
 *   - Forward "publish" messages from the worker into PlatformEventBus
 *   - Subscribe to the bus for topics the plugin wants and forward "deliver"
 *     messages back into the worker
 *   - Forward "log" messages to the host logger / log sinks
 *   - Expose terminate() so the host can kill a rogue worker instantly
 */

import { PlatformEventBus } from "./event-bus.js";
import { policies, type CompartmentName } from "./permissions.js";
import { hostLogger } from "./logger.js";
import type { EventTopic } from "./schemas.js";
import type { WorkerOutboundMessage } from "../workers/plugin-worker.js";

export type WorkerHandle = {
  /** Terminate the worker immediately. */
  terminate(): void;
  /** Resolves once the worker has evaluated the plugin source. */
  ready: Promise<void>;
};

export function spawnPluginWorker(args: {
  name: CompartmentName;
  platformBus: PlatformEventBus;
  pluginSource: string;
  workerUrl?: URL;
}): WorkerHandle {
  const { name, platformBus, pluginSource } = args;

  const policy = policies[name];

  // Rsbuild bundles the worker via the ?worker query; in Node tests we
  // skip actual Worker creation (Workers are a browser/Node18+ API and
  // Vitest provides its own environment).
  const workerUrl = args.workerUrl ?? new URL("../workers/plugin-worker.ts", import.meta.url);

  const worker = new Worker(workerUrl, { type: "module" });

  // ----------------------------------------------------------------
  // Ready promise — resolves on "ready", rejects on "error"
  // ----------------------------------------------------------------
  let resolveReady!: () => void;
  let rejectReady!: (reason: unknown) => void;
  const ready = new Promise<void>((res, rej) => {
    resolveReady = res;
    rejectReady = rej;
  });

  // ----------------------------------------------------------------
  // Unsubscribe callbacks for bus subscriptions owned by this worker
  // ----------------------------------------------------------------
  const unsubscribers: Array<() => void> = [];

  // ----------------------------------------------------------------
  // Handle messages from the worker
  // ----------------------------------------------------------------
  worker.addEventListener("message", (event: MessageEvent<WorkerOutboundMessage>) => {
    const msg = event.data;

    if (msg.type === "ready") {
      hostLogger.info(`worker "${msg.name}" ready`);
      resolveReady();
      return;
    }

    if (msg.type === "log") {
      // Re-emit through the host logger so UI log sinks pick it up
      if (msg.level === "error") {
        hostLogger.error(`[worker:${msg.source}] ${msg.message}`);
      } else {
        hostLogger.info(`[worker:${msg.source}] ${msg.message}`);
      }
      return;
    }

    if (msg.type === "publish") {
      // Worker plugin wants to publish — route through the real bus
      // (validation + sanitization happens inside PlatformEventBus)
      try {
        platformBus.publish(msg.source, msg.topic as EventTopic, msg.payload);
      } catch (err) {
        hostLogger.error(`worker "${name}" publish failed: ${String(err)}`);
        worker.postMessage({ type: "error", source: name, message: String(err) });
      }
      return;
    }

    if (msg.type === "error") {
      hostLogger.error(`worker "${msg.source}" error: ${msg.message}`);
      rejectReady(new Error(msg.message));
      return;
    }
  });

  worker.addEventListener("error", (event) => {
    hostLogger.error(`worker "${name}" uncaught error: ${event.message}`);
    rejectReady(new Error(event.message));
  });

  // ----------------------------------------------------------------
  // Subscribe to the bus for topics this worker's plugin can receive
  // and forward deliveries into the worker
  // ----------------------------------------------------------------
  for (const topic of policy.canSubscribe) {
    const unsub = platformBus.subscribe(topic, (envelope) => {
      worker.postMessage({ type: "deliver", envelope });
    });
    unsubscribers.push(unsub);
  }

  // ----------------------------------------------------------------
  // Bootstrap the worker
  // ----------------------------------------------------------------
  worker.postMessage({
    type: "init",
    name,
    policy,
    pluginSource,
  });

  return {
    ready,
    terminate() {
      for (const unsub of unsubscribers) unsub();
      worker.terminate();
      hostLogger.info(`worker "${name}" terminated`);
    },
  };
}
