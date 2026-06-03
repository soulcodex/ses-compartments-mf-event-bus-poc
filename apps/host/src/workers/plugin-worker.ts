/**
 * plugin-worker.ts
 *
 * Generic Web Worker shell for a single SES compartment plugin.
 *
 * Lifecycle:
 *   1. Host sends  { type: "init", name, policy, pluginSource, logSinkEnabled }
 *   2. Worker calls lockdown(), creates a SES Compartment with a bridged scoped
 *      bus, evaluates the plugin source.
 *   3. When the plugin calls bus.publish(), the worker posts
 *      { type: "publish", topic, payload } back to the host.
 *   4. When the host routes an event to this worker it posts
 *      { type: "deliver", envelope } and the worker invokes the subscribed handler.
 *   5. Logger calls post  { type: "log", level, source, message }.
 */

import "ses";
import { PermissionDeniedError } from "@poc/shared";
import type { CompartmentPolicy } from "@poc/shared";
import type { EventEnvelope } from "@poc/shared";

// ---------------------------------------------------------------------------
// Message shapes
// ---------------------------------------------------------------------------

export type WorkerInboundMessage =
  | { type: "init"; name: string; policy: CompartmentPolicy; pluginSource: string }
  | { type: "deliver"; envelope: EventEnvelope };

export type WorkerOutboundMessage =
  | { type: "publish"; topic: string; payload: unknown; source: string }
  | { type: "log"; level: "info" | "error"; source: string; message: string }
  | { type: "ready"; name: string }
  | { type: "error"; source: string; message: string };

// ---------------------------------------------------------------------------
// Worker bootstrap
// ---------------------------------------------------------------------------

let lockedDown = false;

function ensureLockdown() {
  if (lockedDown) return;
  lockdown({ errorTaming: "unsafe", stackFiltering: "verbose" });
  lockedDown = true;
}

function post(msg: WorkerOutboundMessage) {
  self.postMessage(msg);
}

// topic → handler registered by plugin code
const subscriptions = new Map<string, (envelope: EventEnvelope) => void>();

self.addEventListener("message", (event: MessageEvent<WorkerInboundMessage>) => {
  const msg = event.data;

  // ------------------------------------------------------------------
  // init — bootstrap the compartment
  // ------------------------------------------------------------------
  if (msg.type === "init") {
    const { name, policy, pluginSource } = msg;

    ensureLockdown();

    // Scoped bus exposed to the plugin inside the compartment.
    // publish → postMessage to host.
    // subscribe → register a local handler; delivery comes via "deliver" messages.
    const scopedBus = harden({
      publish(topic: string, payload: unknown): void {
        if (!policy.canPublish.includes(topic as never)) {
          throw new PermissionDeniedError(
            `compartment "${name}" cannot publish "${topic}"`,
          );
        }
        post({ type: "publish", topic, payload, source: name });
      },

      subscribe(topic: string, handler: (envelope: EventEnvelope) => void): () => void {
        if (!policy.canSubscribe.includes(topic as never)) {
          throw new PermissionDeniedError(
            `compartment "${name}" cannot subscribe "${topic}"`,
          );
        }
        subscriptions.set(topic, harden(handler));
        return () => subscriptions.delete(topic);
      },
    });

    const logger = harden({
      info(...args: unknown[]) {
        post({ type: "log", level: "info", source: name, message: args.map(String).join(" ") });
      },
      error(...args: unknown[]) {
        post({ type: "log", level: "error", source: name, message: args.map(String).join(" ") });
      },
    });

    try {
      const compartment = new Compartment({ bus: scopedBus, logger });
      compartment.evaluate(pluginSource);
      post({ type: "ready", name });
    } catch (err) {
      post({ type: "error", source: name, message: String(err) });
    }

    return;
  }

  // ------------------------------------------------------------------
  // deliver — route an event envelope to the subscribed handler
  // ------------------------------------------------------------------
  if (msg.type === "deliver") {
    const { envelope } = msg;
    const handler = subscriptions.get(envelope.topic);
    if (handler) {
      try {
        handler(envelope);
      } catch (err) {
        post({ type: "error", source: envelope.topic, message: String(err) });
      }
    }
    return;
  }
});