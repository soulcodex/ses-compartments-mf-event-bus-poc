import { PlatformEventBus } from "@poc/shared";
import { policies, type CompartmentName } from "@poc/shared";
import { hostLogger } from "@poc/shared";
import type { EventTopic } from "@poc/shared";
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
  /**
   * A bundled Worker constructor produced by Rsbuild's ?worker import.
   * Must be provided by the call site so Rsbuild can emit a proper worker
   * chunk at build time. The bridge does not construct a URL itself —
   * resolving a raw .ts path at runtime produces a file the browser cannot
   * parse.
   *
   * Usage in main.ts:
   *   import PluginWorker from "../workers/plugin-worker.ts?worker";
   *   spawnPluginWorker({ ..., WorkerClass: PluginWorker });
   */
  WorkerClass: new () => Worker;
}): WorkerHandle {
  const { name, platformBus, pluginSource, WorkerClass } = args;

  const policy = policies[name];
  const worker = new WorkerClass();

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
      if (msg.level === "error") {
        hostLogger.error(`[worker:${msg.source}] ${msg.message}`);
      } else {
        hostLogger.info(`[worker:${msg.source}] ${msg.message}`);
      }
      return;
    }

    if (msg.type === "publish") {
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
  worker.postMessage({ type: "init", name, policy, pluginSource });

  return {
    ready,
    terminate() {
      for (const unsub of unsubscribers) unsub();
      worker.terminate();
      hostLogger.info(`worker "${name}" terminated`);
    },
  };
}