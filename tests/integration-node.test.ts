import { describe, it, expect, vi } from "vitest";
import { PlatformEventBus } from "../src/platform/event-bus.js";
import { createPluginCompartment } from "../src/platform/compartment-factory.js";
import { initializeSES } from "../src/platform/lockdown.js";

initializeSES();

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
  try { bus.publish("cart:item-added", { itemId: "x", quantity: 1, cartSize: 0 }); } catch (e) { blockedPublish = true; }
  try { bus.subscribe("catalog:item-selected", () => {}); } catch (e) { blockedSubscribe = true; }
  globalThis.__maliciousResult = { blockedPublish, blockedSubscribe };
`;

describe("integration", () => {
  it("catalog -> cart -> catalog event flow works", async () => {
    const platformBus = new PlatformEventBus();

    const catalog = createPluginCompartment({
      name: "catalog",
      platformBus,
      sourceCode: catalogPluginSource,
    });

    createPluginCompartment({
      name: "cart",
      platformBus,
      sourceCode: cartPluginSource,
    });

    const selectItem = catalog.globalThis.selectItem as (id: string, qty: number) => void;
    selectItem("sku_123", 1);

    await new Promise((r) => setTimeout(r, 100));

    const confirmation = catalog.globalThis.__cartConfirmation as Record<string, unknown>;
    expect(confirmation).toBeDefined();
    expect(confirmation.itemId).toBe("sku_123");
    expect(confirmation.cartSize).toBe(1);
  });

  it("malicious plugin is blocked from forbidden publish and subscribe", async () => {
    const platformBus = new PlatformEventBus();

    const malicious = createPluginCompartment({
      name: "malicious",
      platformBus,
      sourceCode: maliciousPluginSource,
    });

    await new Promise((r) => setTimeout(r, 50));

    const result = malicious.globalThis.__maliciousResult as Record<string, boolean>;
    expect(result.blockedPublish).toBe(true);
    expect(result.blockedSubscribe).toBe(true);
  });
});
