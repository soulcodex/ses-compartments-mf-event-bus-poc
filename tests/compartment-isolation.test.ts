import { describe, it, expect } from "vitest";
import { createPluginCompartment } from "../src/platform/compartment-factory.js";
import { PlatformEventBus } from "../src/platform/event-bus.js";
import { initializeSES } from "../src/platform/lockdown.js";

initializeSES();

describe("compartment isolation", () => {
  const platformBus = new PlatformEventBus();

  it("compartment can use endowed bus", () => {
    expect(() =>
      createPluginCompartment({
        name: "catalog",
        platformBus,
        sourceCode: `bus.subscribe("cart:item-added", () => {});`,
      })
    ).not.toThrow();
  });

  it("compartment can use endowed logger", () => {
    expect(() =>
      createPluginCompartment({
        name: "catalog",
        platformBus,
        sourceCode: `logger.info("test");`,
      })
    ).not.toThrow();
  });

  it("compartment does not have process", () => {
    expect(() =>
      createPluginCompartment({
        name: "catalog",
        platformBus,
        sourceCode: `if (typeof process !== "undefined") throw new Error("process leaked");`,
      })
    ).not.toThrow();
  });

  it("compartment does not have fetch", () => {
    expect(() =>
      createPluginCompartment({
        name: "catalog",
        platformBus,
        sourceCode: `if (typeof fetch !== "undefined") throw new Error("fetch leaked");`,
      })
    ).not.toThrow();
  });

  it("variable in one compartment is not visible in another", () => {
    createPluginCompartment({
      name: "catalog",
      platformBus,
      sourceCode: `globalThis.__secret = "abc123";`,
    });

    expect(() =>
      createPluginCompartment({
        name: "cart",
        platformBus,
        sourceCode: `if (typeof __secret !== "undefined") throw new Error("variable leaked between compartments");`,
      })
    ).not.toThrow();
  });
});
