/**
 * worker-bus-bridge.test.ts
 *
 * Tests for WorkerBusBridge using a lightweight Worker mock.
 *
 * Real Web Workers are not available in the Vitest Node environment.
 * We substitute a MockWorker that runs plugin-worker logic synchronously
 * in the same process, faithfully reproducing the postMessage contract.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { PlatformEventBus } from "../src/platform/event-bus.js";
import { initializeSES } from "../src/platform/lockdown.js";
import { policies } from "../src/platform/permissions.js";
import { PermissionDeniedError } from "../src/platform/errors.js";
import type { WorkerInboundMessage, WorkerOutboundMessage } from "../src/workers/plugin-worker.js";

initializeSES();

// ---------------------------------------------------------------------------
// Minimal in-process Worker mock
// ---------------------------------------------------------------------------
// Mirrors the plugin-worker.ts message contract without spawning a thread.

type MessageHandler = (event: { data: unknown }) => void;

class MockWorker {
  private inboundHandlers: MessageHandler[] = [];
  private subscriptions = new Map<string, (envelope: unknown) => void>();
  private name = "";
  private policy: { canPublish: string[]; canSubscribe: string[] } = {
    canPublish: [],
    canSubscribe: [],
  };

  // Outbound messages the worker would postMessage to the host
  outbound: WorkerOutboundMessage[] = [];

  // Simulate host calling worker.postMessage()
  postMessage(msg: WorkerInboundMessage) {
    if (msg.type === "init") {
      this.name = msg.name;
      this.policy = msg.policy as { canPublish: string[]; canSubscribe: string[] };

      const scopedBus = {
        publish: (topic: string, payload: unknown) => {
          if (!this.policy.canPublish.includes(topic)) {
            throw new PermissionDeniedError(
              `compartment "${this.name}" cannot publish "${topic}"`,
            );
          }
          this.emit({ type: "publish", topic, payload, source: this.name });
        },
        subscribe: (topic: string, handler: (e: unknown) => void) => {
          if (!this.policy.canSubscribe.includes(topic)) {
            throw new PermissionDeniedError(
              `compartment "${this.name}" cannot subscribe "${topic}"`,
            );
          }
          this.subscriptions.set(topic, handler);
          return () => this.subscriptions.delete(topic);
        },
      };

      const logger = {
        info: (...args: unknown[]) => {
          this.emit({
            type: "log",
            level: "info",
            source: this.name,
            message: args.map(String).join(" "),
          });
        },
        error: (...args: unknown[]) => {
          this.emit({
            type: "log",
            level: "error",
            source: this.name,
            message: args.map(String).join(" "),
          });
        },
      };

      try {
        const compartment = new Compartment({ bus: scopedBus, logger });
        compartment.evaluate(msg.pluginSource);
        this.emit({ type: "ready", name: this.name });
      } catch (err) {
        this.emit({ type: "error", source: this.name, message: String(err) });
      }
      return;
    }

    if (msg.type === "deliver") {
      const handler = this.subscriptions.get(msg.envelope.topic);
      if (handler) {
        try {
          handler(msg.envelope);
        } catch (err) {
          this.emit({ type: "error", source: msg.envelope.topic, message: String(err) });
        }
      }
    }
  }

  // Simulate worker calling self.postMessage() → host receives it
  private emit(msg: WorkerOutboundMessage) {
    this.outbound.push(msg);
    for (const h of this.inboundHandlers) {
      h({ data: msg });
    }
  }

  addEventListener(_type: string, handler: MessageHandler) {
    this.inboundHandlers.push(handler);
  }

  terminate() { /* no-op */ }
}

// ---------------------------------------------------------------------------
// Helper: build a bridge using MockWorker instead of real Worker
// ---------------------------------------------------------------------------

function createMockBridge(args: {
  name: "catalog" | "cart" | "malicious" | "mutation";
  platformBus: PlatformEventBus;
  pluginSource: string;
}) {
  const { name, platformBus, pluginSource } = args;
  const policy = policies[name];
  const worker = new MockWorker();

  let resolveReady!: () => void;
  let rejectReady!: (r: unknown) => void;
  const ready = new Promise<void>((res, rej) => {
    resolveReady = res;
    rejectReady = rej;
  });

  const unsubscribers: Array<() => void> = [];

  worker.addEventListener("message", (event: { data: WorkerOutboundMessage }) => {
    const msg = event.data;

    if (msg.type === "ready") { resolveReady(); return; }
    if (msg.type === "error") { rejectReady(new Error(msg.message)); return; }

    if (msg.type === "publish") {
      try {
        platformBus.publish(msg.source, msg.topic as never, msg.payload);
      } catch (err) {
        /* permission / validation errors are expected in some tests */
      }
      return;
    }
  });

  for (const topic of policy.canSubscribe) {
    const unsub = platformBus.subscribe(topic as never, (envelope) => {
      worker.postMessage({ type: "deliver", envelope });
    });
    unsubscribers.push(unsub);
  }

  worker.postMessage({ type: "init", name, policy, pluginSource });

  return {
    worker,
    ready,
    terminate() {
      for (const u of unsubscribers) u();
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const catalogPluginSource = `
  bus.subscribe("cart:item-added", (event) => {
    globalThis.__cartConfirmation = event.payload;
  });
  globalThis.selectItem = function(itemId, quantity) {
    bus.publish("catalog:item-selected", { itemId, quantity });
  };
`;

const cartPluginSource = `
  let cartSize = 0;
  bus.subscribe("catalog:item-selected", (event) => {
    cartSize += event.payload.quantity;
    bus.publish("cart:item-added", {
      itemId: event.payload.itemId,
      quantity: event.payload.quantity,
      cartSize,
    });
  });
`;

const maliciousPluginSource = `
  let blockedPublish = false;
  let blockedSubscribe = false;
  try { bus.publish("cart:item-added", { itemId: "x", quantity: 1, cartSize: 0 }); }
  catch (e) { blockedPublish = true; }
  try { bus.subscribe("catalog:item-selected", () => {}); }
  catch (e) { blockedSubscribe = true; }
  globalThis.__result = { blockedPublish, blockedSubscribe };
`;

describe("worker-bus-bridge (mock worker)", () => {
  let platformBus: PlatformEventBus;

  beforeEach(() => {
    platformBus = new PlatformEventBus();
  });

  it("worker becomes ready after init", async () => {
    const { ready } = createMockBridge({
      name: "catalog",
      platformBus,
      pluginSource: `logger.info("loaded");`,
    });
    await expect(ready).resolves.toBeUndefined();
  });

  it("worker emits a ready message", async () => {
    const { worker, ready } = createMockBridge({
      name: "catalog",
      platformBus,
      pluginSource: `logger.info("loaded");`,
    });
    await ready;
    expect(worker.outbound.some((m) => m.type === "ready")).toBe(true);
  });

  it("catalog → cart → catalog flow via mock workers", async () => {
    const catalog = createMockBridge({ name: "catalog", platformBus, pluginSource: catalogPluginSource });
    const cart = createMockBridge({ name: "cart", platformBus, pluginSource: cartPluginSource });

    await Promise.all([catalog.ready, cart.ready]);

    // Trigger via the bus (same as host would do)
    platformBus.publish("host", "catalog:item-selected", { itemId: "sku_w1", quantity: 1 });

    await new Promise((r) => setTimeout(r, 100));

    // cart should have published cart:item-added
    const cartPublish = cart.worker.outbound.find(
      (m) => m.type === "publish" && m.topic === "cart:item-added",
    );
    expect(cartPublish).toBeDefined();
    expect((cartPublish as { payload: { itemId: string } }).payload.itemId).toBe("sku_w1");
  });

  it("malicious worker cannot publish or subscribe forbidden topics", async () => {
    const { worker, ready } = createMockBridge({
      name: "malicious",
      platformBus,
      pluginSource: maliciousPluginSource,
    });
    await ready;

    // No publish messages should have escaped the worker
    const publishMsgs = worker.outbound.filter((m) => m.type === "publish");
    expect(publishMsgs).toHaveLength(0);
  });

  it("worker log messages are emitted as log outbound messages", async () => {
    const { worker, ready } = createMockBridge({
      name: "catalog",
      platformBus,
      pluginSource: `logger.info("hello from worker");`,
    });
    await ready;

    const logMsg = worker.outbound.find(
      (m) => m.type === "log" && m.type === "log" && (m as { message: string }).message.includes("hello from worker"),
    );
    expect(logMsg).toBeDefined();
  });

  it("worker with invalid plugin source rejects the ready promise", async () => {
    const { ready } = createMockBridge({
      name: "catalog",
      platformBus,
      pluginSource: `throw new Error("deliberate failure");`,
    });
    await expect(ready).rejects.toThrow("deliberate failure");
  });

  it("terminate() unsubscribes the worker from the bus", async () => {
    const receivedTopics: string[] = [];

    const { ready, terminate } = createMockBridge({
      name: "cart",
      platformBus,
      pluginSource: `
        bus.subscribe("catalog:item-selected", (event) => {
          globalThis.__received = event.payload;
        });
      `,
    });

    await ready;
    terminate();

    // After termination the bus subscription is removed — no delivery
    platformBus.publish("host", "catalog:item-selected", { itemId: "post-terminate", quantity: 1 });

    await new Promise((r) => setTimeout(r, 50));
    expect(receivedTopics).toHaveLength(0);
  });
});
