import { describe, it, expect } from "vitest";
import { makeScopedBus } from "../src/platform/scoped-bus.js";
import { PlatformEventBus } from "../src/platform/event-bus.js";
import { policies } from "../src/platform/permissions.js";
import { PermissionDeniedError } from "../src/platform/errors.js";
import { initializeSES } from "../src/platform/lockdown.js";

initializeSES();

describe("permissions", () => {
  function makeBus(name: "catalog" | "cart" | "malicious" | "mutation") {
    const platformBus = new PlatformEventBus();
    return makeScopedBus({ compartmentName: name, policy: policies[name], platformBus });
  }

  it("catalog can publish catalog:item-selected", () => {
    const bus = makeBus("catalog");
    expect(() => bus.publish("catalog:item-selected", { itemId: "x", quantity: 1 })).not.toThrow();
  });

  it("catalog cannot publish cart:item-added", () => {
    const bus = makeBus("catalog");
    expect(() => bus.publish("cart:item-added", { itemId: "x", quantity: 1, cartSize: 0 }))
      .toThrow(PermissionDeniedError);
  });

  it("cart can subscribe to catalog:item-selected", () => {
    const bus = makeBus("cart");
    expect(() => bus.subscribe("catalog:item-selected", () => {})).not.toThrow();
  });

  it("cart cannot subscribe to cart:item-added", () => {
    const bus = makeBus("cart");
    expect(() => bus.subscribe("cart:item-added", () => {})).toThrow(PermissionDeniedError);
  });

  it("malicious cannot publish anything", () => {
    const bus = makeBus("malicious");
    expect(() => bus.publish("catalog:item-selected", { itemId: "x", quantity: 1 }))
      .toThrow(PermissionDeniedError);
  });

  it("malicious cannot subscribe to anything", () => {
    const bus = makeBus("malicious");
    expect(() => bus.subscribe("catalog:item-selected", () => {})).toThrow(PermissionDeniedError);
  });
});
