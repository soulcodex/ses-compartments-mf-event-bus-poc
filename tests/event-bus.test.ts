import { describe, it, expect, vi } from "vitest";
import { PlatformEventBus } from "../src/platform/event-bus.js";
import { initializeSES } from "../src/platform/lockdown.js";

initializeSES();

describe("PlatformEventBus", () => {
  it("delivers event to subscriber", async () => {
    const bus = new PlatformEventBus();
    const handler = vi.fn();
    bus.subscribe("catalog:item-selected", handler);
    bus.publish("catalog", "catalog:item-selected", { itemId: "x", quantity: 1 });
    await new Promise((r) => setTimeout(r, 20));
    expect(handler).toHaveBeenCalledOnce();
  });

  it("validates payload with Zod", () => {
    const bus = new PlatformEventBus();
    expect(() =>
      bus.publish("catalog", "catalog:item-selected", { itemId: "x", quantity: -1 })
    ).toThrow();
  });

  it("delivers hardened payload", async () => {
    const bus = new PlatformEventBus();
    let received: unknown;
    bus.subscribe("catalog:item-selected", (envelope) => {
      received = envelope.payload;
    });
    bus.publish("catalog", "catalog:item-selected", { itemId: "sku_1", quantity: 1 });
    await new Promise((r) => setTimeout(r, 20));
    expect(() => {
      (received as Record<string, unknown>).itemId = "mutated";
    }).toThrow();
  });

  it("unsubscribe stops delivery", async () => {
    const bus = new PlatformEventBus();
    const handler = vi.fn();
    const unsub = bus.subscribe("catalog:item-selected", handler);
    unsub();
    bus.publish("catalog", "catalog:item-selected", { itemId: "x", quantity: 1 });
    await new Promise((r) => setTimeout(r, 20));
    expect(handler).not.toHaveBeenCalled();
  });
});
