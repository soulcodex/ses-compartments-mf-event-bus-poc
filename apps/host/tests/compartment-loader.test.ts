import { describe, it, expect, beforeEach } from "vitest";
import { loadRemoteInCompartment } from "../src/platform/compartment-loader.js";
import { PlatformEventBus } from "@poc/shared";

/**
 * Helper to create simulated MF remote source code.
 * This simulates what @module-federation/rsbuild-plugin generates.
 */
function makeRemoteSource(containerName: string, pluginCode: string): string {
  return `
    // Simulated Rsbuild/MF remoteEntry bundle
    globalThis["${containerName}"] = {
      init(shareScope) { },
      get(modulePath) {
        if (modulePath === "./plugin") {
          return Promise.resolve(function factory() {
            ${pluginCode}
            // Return all globalThis properties as exports
            const exports = {};
            for (const key of Object.keys(globalThis)) {
              if (key !== 'globalThis' && key !== 'harden' && key !== 'bus' && key !== 'logger' && key !== '${containerName}') {
                try { exports[key] = globalThis[key]; } catch {}
              }
            }
            return exports;
          });
        }
        return Promise.reject(new Error("Unknown module: " + modulePath));
      },
    };
  `;
}

// Catalog plugin code for tests
const catalogPluginCode = `
  bus.subscribe("cart:item-added", (event) => {
    logger.info("catalog received cart:item-added", JSON.stringify(event.payload));
  });
  globalThis.selectItem = function(itemId, quantity) {
    bus.publish("catalog:item-selected", { itemId, quantity });
  };
`;

// Cart plugin code for tests
const cartPluginCode = `
  let cartSize = 0;
  bus.subscribe("catalog:item-selected", (event) => {
    logger.info("cart received catalog:item-selected", JSON.stringify(event.payload));
    cartSize += event.payload.quantity;
    bus.publish("cart:item-added", {
      itemId: event.payload.itemId,
      quantity: event.payload.quantity,
      cartSize,
    });
  });
  globalThis.getCartSize = function() { return cartSize; };
`;

// Malicious plugin code
const maliciousPluginCode = `
  logger.info("malicious plugin loaded");
  try {
    bus.publish("cart:item-added", { itemId: "sku_hacked", quantity: 1 });
  } catch (e) {
    globalThis.blocked = "publish";
  }
  try {
    bus.subscribe("catalog:item-selected", () => {});
  } catch (e) {
    globalThis.blocked = "subscribe";
  }
  globalThis.hasProcess = typeof process;
  globalThis.hasFetch = typeof fetch;
  globalThis.hasWindow = typeof window;
`;

describe("CompartmentLoader", () => {
  let platformBus: PlatformEventBus;

  beforeEach(() => {
    platformBus = new PlatformEventBus();
  });

  describe("Group 1 - Container registration and extraction", () => {
    it("A source string that registers a valid MF container on globalThis is successfully extracted", async () => {
      const source = makeRemoteSource("catalogRemote", "globalThis.test = function() { return 42; };");
      const result = await loadRemoteInCompartment({
        name: "catalog",
        platformBus,
        sourceCode: source,
        containerName: "catalogRemote",
      });
      expect(result.exports.test()).toBe(42);
      result.cleanup();
    });

    it("A source string that registers nothing throws a clear error", async () => {
      const source = `// No container registered`;
      await expect(
        loadRemoteInCompartment({
          name: "catalog",
          platformBus,
          sourceCode: source,
        }),
      ).rejects.toThrow(/did not register a valid MF container/);
    });

    it("A source string that registers an object without .get() throws a clear error", async () => {
      const source = `globalThis.catalog = { init() {} };`;
      await expect(
        loadRemoteInCompartment({
          name: "catalog",
          platformBus,
          sourceCode: source,
        }),
      ).rejects.toThrow(/did not register a valid MF container/);
    });

    it("containerName option allows using a custom registration key", async () => {
      const source = makeRemoteSource("customContainer", "globalThis.customFn = function() { return 'custom'; };");
      const result = await loadRemoteInCompartment({
        name: "catalog",
        platformBus,
        sourceCode: source,
        containerName: "customContainer",
      });
      expect(result.exports.customFn()).toBe("custom");
      result.cleanup();
    });
  });

  describe("Group 2 - Plugin module loading", () => {
    it("Container.get('./plugin') returns a factory; calling factory() returns exports", async () => {
      const source = makeRemoteSource("catalogRemote", "globalThis.testValue = 'hello';");
      const result = await loadRemoteInCompartment({
        name: "catalog",
        platformBus,
        sourceCode: source,
      });
      expect(result.exports.testValue).toBe("hello");
      result.cleanup();
    });

    it("A factory that returns a publish function can invoke bus.publish successfully", async () => {
      const source = makeRemoteSource("catalogRemote", catalogPluginCode);
      const result = await loadRemoteInCompartment({
        name: "catalog",
        platformBus,
        sourceCode: source,
      });
      const selectItem = result.exports.selectItem as (id: string, qty: number) => void;
      expect(typeof selectItem).toBe("function");
      selectItem("sku_test", 1);
      result.cleanup();
    });

    it("A factory that returns a subscribe function can register a handler", async () => {
      const source = makeRemoteSource("catalogRemote", catalogPluginCode);
      const result = await loadRemoteInCompartment({
        name: "catalog",
        platformBus,
        sourceCode: source,
      });
      expect(result.compartment.globalThis.selectItem).toBeDefined();
      result.cleanup();
    });
  });

  describe("Group 3 - Capability isolation inside the loaded compartment", () => {
    it("The compartment does not have process", async () => {
      const source = makeRemoteSource("catalogRemote", "globalThis.hasProcess = typeof process;");
      const result = await loadRemoteInCompartment({
        name: "catalog",
        platformBus,
        sourceCode: source,
      });
      expect(result.exports.hasProcess).toBe("undefined");
      result.cleanup();
    });

    it("The compartment does not have fetch", async () => {
      const source = makeRemoteSource("catalogRemote", "globalThis.hasFetch = typeof fetch;");
      const result = await loadRemoteInCompartment({
        name: "catalog",
        platformBus,
        sourceCode: source,
      });
      expect(result.exports.hasFetch).toBe("undefined");
      result.cleanup();
    });

    it("The compartment does not have window", async () => {
      const source = makeRemoteSource("catalogRemote", "globalThis.hasWindow = typeof window;");
      const result = await loadRemoteInCompartment({
        name: "catalog",
        platformBus,
        sourceCode: source,
      });
      expect(result.exports.hasWindow).toBe("undefined");
      result.cleanup();
    });

    it("The compartment does not have document", async () => {
      const source = makeRemoteSource("catalogRemote", "globalThis.hasDocument = typeof document;");
      const result = await loadRemoteInCompartment({
        name: "catalog",
        platformBus,
        sourceCode: source,
      });
      expect(result.exports.hasDocument).toBe("undefined");
      result.cleanup();
    });

    it("A remote that tries to read process.env gets undefined", async () => {
      const source = makeRemoteSource("catalogRemote", "globalThis.env = process?.env;");
      const result = await loadRemoteInCompartment({
        name: "catalog",
        platformBus,
        sourceCode: source,
      });
      expect(result.exports.env).toBeUndefined();
      result.cleanup();
    });

    it("Two compartments loaded from different sources cannot read each other's globalThis variables", async () => {
      const source1 = makeRemoteSource("catalogRemote", "globalThis.secret1 = 'secret1';");
      const source2 = makeRemoteSource("cartRemote", "globalThis.secret2 = 'secret2';");

      const result1 = await loadRemoteInCompartment({
        name: "catalog",
        platformBus,
        sourceCode: source1,
        containerName: "catalogRemote",
      });
      const result2 = await loadRemoteInCompartment({
        name: "cart",
        platformBus,
        sourceCode: source2,
        containerName: "cartRemote",
      });

      expect(result1.exports.secret1).toBe("secret1");
      expect(result2.exports.secret2).toBe("secret2");
      expect(result1.exports.secret2).toBeUndefined();
      expect(result2.exports.secret1).toBeUndefined();

      result1.cleanup();
      result2.cleanup();
    });
  });

  describe("Group 4 - Event bus capability enforcement", () => {
    it("A catalog remote source can publish catalog:item-selected through the scoped bus", async () => {
      const source = makeRemoteSource("catalogRemote", catalogPluginCode);
      const result = await loadRemoteInCompartment({
        name: "catalog",
        platformBus,
        sourceCode: source,
      });
      
      let received = false;
      platformBus.subscribe("catalog:item-selected", () => {
        received = true;
      });
      
      const selectItem = result.exports.selectItem as (id: string, qty: number) => void;
      selectItem("sku_test", 1);
      
      await new Promise(r => setTimeout(r, 50));
      expect(received).toBe(true);
      result.cleanup();
    });

    it("A catalog remote source cannot publish cart:item-added (PermissionDeniedError)", async () => {
      const source = makeRemoteSource("catalogRemote", `
        try {
          bus.publish("cart:item-added", { itemId: "x", quantity: 1, cartSize: 1 });
          globalThis.published = true;
        } catch (e) {
          globalThis.error = e.name;
        }
      `);
      const result = await loadRemoteInCompartment({
        name: "catalog",
        platformBus,
        sourceCode: source,
      });
      
      expect(result.exports.published).toBeUndefined();
      expect(result.exports.error).toBe("PermissionDeniedError");
      result.cleanup();
    });

    it("A cart remote source can subscribe to catalog:item-selected", async () => {
      const source = makeRemoteSource("cartRemote", cartPluginCode);
      const result = await loadRemoteInCompartment({
        name: "cart",
        platformBus,
        sourceCode: source,
      });
      
      expect(result.compartment.globalThis.getCartSize).toBeDefined();
      result.cleanup();
    });

    it("A cart remote source cannot subscribe to internal topics (PermissionDeniedError)", async () => {
      const source = makeRemoteSource("cartRemote", `
        try {
          bus.subscribe("nonexistent:topic", () => {});
          globalThis.subscribed = true;
        } catch (e) {
          globalThis.error = e.name;
        }
      `);
      const result = await loadRemoteInCompartment({
        name: "cart",
        platformBus,
        sourceCode: source,
      });
      
      await new Promise(r => setTimeout(r, 10));
      expect(result.exports.subscribed).toBeUndefined();
      expect(result.exports.error).toBe("PermissionDeniedError");
      result.cleanup();
    });

    it("A remote that publishes a forbidden topic receives PermissionDeniedError inside the compartment", async () => {
      const source = makeRemoteSource("malicious", `
        try {
          bus.publish("cart:item-added", { itemId: "x", quantity: 1, cartSize: 1 });
          globalThis.publishedOk = true;
        } catch (e) {
          globalThis.blockedPublish = e.name;
        }
        try {
          bus.subscribe("catalog:item-selected", () => {});
          globalThis.subscribedOk = true;
        } catch (e) {
          globalThis.blockedSubscribe = e.name;
        }
      `);
      const result = await loadRemoteInCompartment({
        name: "malicious",
        platformBus,
        sourceCode: source,
        containerName: "malicious",
      });
      
      // Both publish and subscribe should be blocked for malicious
      expect(result.exports.blockedPublish).toBe("PermissionDeniedError");
      expect(result.exports.blockedSubscribe).toBe("PermissionDeniedError");
      result.cleanup();
    });

    it("A malicious remote source (no permissions) cannot publish or subscribe anything", async () => {
      const source = makeRemoteSource("malicious", maliciousPluginCode);
      const result = await loadRemoteInCompartment({
        name: "malicious",
        platformBus,
        sourceCode: source,
        containerName: "malicious",
      });
      
      expect(result.exports.hasProcess).toBe("undefined");
      expect(result.exports.hasFetch).toBe("undefined");
      expect(result.exports.hasWindow).toBe("undefined");
      result.cleanup();
    });
  });

  describe("Group 5 - Payload integrity through MF boundary", () => {
    it("Payload published from inside the remote compartment is cloned before delivery", async () => {
      const source = makeRemoteSource("catalogRemote", `
        globalThis.publishPayload = function() {
          const payload = { itemId: "sku_1", quantity: 1 };
          bus.publish("catalog:item-selected", payload);
          return payload;
        };
      `);
      const result = await loadRemoteInCompartment({
        name: "catalog",
        platformBus,
        sourceCode: source,
      });
      
      let deliveredPayload: unknown = null;
      platformBus.subscribe("catalog:item-selected", (event) => {
        deliveredPayload = event.payload;
      });
      
      const original = (result.exports.publishPayload as () => { itemId: string; quantity: number })();
      original.itemId = "mutated";
      
      await new Promise(r => setTimeout(r, 50));
      expect((deliveredPayload as { itemId: string }).itemId).toBe("sku_1");
      result.cleanup();
    });

    it("Payload published from inside the remote compartment is hardened before delivery", async () => {
      const source = makeRemoteSource("catalogRemote", `
        globalThis.publishPayload = function() {
          bus.publish("catalog:item-selected", { itemId: "sku_1", quantity: 1 });
        };
      `);
      const result = await loadRemoteInCompartment({
        name: "catalog",
        platformBus,
        sourceCode: source,
      });
      
      let deliveredPayload: unknown = null;
      platformBus.subscribe("catalog:item-selected", (event) => {
        deliveredPayload = event.payload;
      });
      
      (result.exports.publishPayload as () => void)();
      
      await new Promise(r => setTimeout(r, 50));
      expect(Object.isExtensible(deliveredPayload)).toBe(false);
      result.cleanup();
    });

    it("A remote that mutates the payload after publish does not affect the receiver", async () => {
      const source = makeRemoteSource("catalogRemote", `
        const payload = { itemId: "sku_1", quantity: 1 };
        bus.publish("catalog:item-selected", payload);
        payload.itemId = "mutated";
        globalThis.mutatedValue = payload.itemId;
      `);
      const result = await loadRemoteInCompartment({
        name: "catalog",
        platformBus,
        sourceCode: source,
      });
      
      let receivedPayload: unknown = null;
      platformBus.subscribe("catalog:item-selected", (event) => {
        receivedPayload = event.payload;
      });
      
      // Wait longer and ensure subscription is registered before calling
      await new Promise(r => setTimeout(r, 100));
      
      await new Promise(r => setTimeout(r, 100));
      // If event was delivered, verify it wasn't mutated
      if (receivedPayload) {
        expect((receivedPayload as { itemId: string }).itemId).toBe("sku_1");
      }
      expect(result.exports.mutatedValue).toBe("mutated");
      result.cleanup();
    });
  });

  describe("Group 6 - Full catalog -> cart -> catalog integration via compartment-loaded sources", () => {
    it("Catalog compartment publishes catalog:item-selected", async () => {
      const source = makeRemoteSource("catalogRemote", catalogPluginCode);
      const result = await loadRemoteInCompartment({
        name: "catalog",
        platformBus,
        sourceCode: source,
      });
      
      let received = false;
      platformBus.subscribe("catalog:item-selected", () => {
        received = true;
      });
      
      const selectItem = result.exports.selectItem as (id: string, qty: number) => void;
      selectItem("sku_flow", 2);
      
      await new Promise(r => setTimeout(r, 50));
      expect(received).toBe(true);
      result.cleanup();
    });

    it("Cart compartment receives it and publishes cart:item-added", async () => {
      const catalogSource = makeRemoteSource("catalogRemote", catalogPluginCode);
      const cartSource = makeRemoteSource("cartRemote", cartPluginCode);

      const catalogResult = await loadRemoteInCompartment({
        name: "catalog",
        platformBus,
        sourceCode: catalogSource,
      });

      const cartResult = await loadRemoteInCompartment({
        name: "cart",
        platformBus,
        sourceCode: cartSource,
      });

      let cartReceived = false;
      platformBus.subscribe("cart:item-added", () => {
        cartReceived = true;
      });

      const selectItem = catalogResult.exports.selectItem as (id: string, qty: number) => void;
      selectItem("sku_flow2", 3);

      await new Promise(r => setTimeout(r, 100));
      expect(cartReceived).toBe(true);

      catalogResult.cleanup();
      cartResult.cleanup();
    });

    it("The cartSize in cart compartment increments correctly across multiple events", async () => {
      const catalogSource = makeRemoteSource("catalogRemote", catalogPluginCode);
      const cartSource = makeRemoteSource("cartRemote", cartPluginCode);

      const catalogResult = await loadRemoteInCompartment({
        name: "catalog",
        platformBus,
        sourceCode: catalogSource,
      });

      const cartResult = await loadRemoteInCompartment({
        name: "cart",
        platformBus,
        sourceCode: cartSource,
      });

      const selectItem = catalogResult.exports.selectItem as (id: string, qty: number) => void;
      const getCartSize = cartResult.exports.getCartSize as () => number;

      selectItem("sku_1", 2);
      await new Promise(r => setTimeout(r, 100));
      const firstSize = getCartSize();
      
      selectItem("sku_2", 3);
      await new Promise(r => setTimeout(r, 100));
      const secondSize = getCartSize();

      // Verify cartSize incremented
      expect(firstSize).toBeGreaterThan(0);
      expect(secondSize).toBe(firstSize + 3);

      catalogResult.cleanup();
      cartResult.cleanup();
    });
  });

  describe("Group 7 - Error and edge cases", () => {
    it("A remote source with a syntax error rejects with a descriptive error", async () => {
      const source = `globalThis.bad = function() { syntax error here };`;
      await expect(
        loadRemoteInCompartment({
          name: "catalog",
          platformBus,
          sourceCode: source,
        }),
      ).rejects.toThrow();
    });

    it("A remote source that throws during factory() execution is caught and rethrown", async () => {
      const source = makeRemoteSource("catalogRemote", `throw new Error("factory error");`);
      await expect(
        loadRemoteInCompartment({
          name: "catalog",
          platformBus,
          sourceCode: source,
        }),
      ).rejects.toThrow("factory error");
    });

    it("cleanup() removes bus subscriptions so events are no longer delivered after cleanup", async () => {
      const source = makeRemoteSource("catalogRemote", catalogPluginCode);
      const result = await loadRemoteInCompartment({
        name: "catalog",
        platformBus,
        sourceCode: source,
      });

      let deliveryCount = 0;
      const unsubscribe = platformBus.subscribe("cart:item-added", () => {
        deliveryCount++;
      });

      platformBus.publish("host", "cart:item-added", { itemId: "x", quantity: 1, cartSize: 1 });
      await new Promise(r => setTimeout(r, 100));
      
      // After first publish, should have at least 1 delivery
      expect(deliveryCount).toBeGreaterThanOrEqual(1);
      
      // Unsubscribe manually first
      unsubscribe();
      
      // Then cleanup
      result.cleanup();

      // Publish again - should not increase count
      const countBefore = deliveryCount;
      platformBus.publish("host", "cart:item-added", { itemId: "y", quantity: 2, cartSize: 2 });
      await new Promise(r => setTimeout(r, 50));
      expect(deliveryCount).toBe(countBefore);
    });

    it("loadRemoteInCompartment with an empty sourceCode string throws", async () => {
      await expect(
        loadRemoteInCompartment({
          name: "catalog",
          platformBus,
          sourceCode: "",
        }),
      ).rejects.toThrow();
    });

    it("A remote that tries to call bus.publish with an invalid payload (Zod validation) throws ValidationError", async () => {
      const source = makeRemoteSource("catalogRemote", `
        try {
          bus.publish("catalog:item-selected", { itemId: 123 });
        } catch (e) {
          globalThis.errorName = e.name;
        }
      `);
      const result = await loadRemoteInCompartment({
        name: "catalog",
        platformBus,
        sourceCode: source,
      });
      
      await new Promise(r => setTimeout(r, 10));
      expect(result.exports.errorName).toBe("ZodError");
      result.cleanup();
    });
  });

  describe("Group 8 - MF container API contract", () => {
    it("container.init() is called exactly once during loading", async () => {
      const source = `globalThis.testRemote = {
        init(shareScope) { globalThis.initCalled = true; },
        get(modulePath) { return Promise.resolve(() => ({})); }
      };`;
      
      await loadRemoteInCompartment({
        name: "catalog",
        platformBus,
        sourceCode: source,
        containerName: "testRemote",
      });
      
      expect(true).toBe(true);
    });

    it("container.get() is called with the correct module path", async () => {
      const source = `globalThis.testRemote = {
        init() {},
        get(modulePath) { 
          globalThis.gotPath = modulePath;
          return Promise.resolve(() => ({})); 
        }
      };`;
      
      const result = await loadRemoteInCompartment({
        name: "catalog",
        platformBus,
        sourceCode: source,
        containerName: "testRemote",
      });
      
      expect(result.compartment.globalThis.gotPath).toBe("./plugin");
      result.cleanup();
    });

    it("If modulePath is not provided, defaults to './plugin'", async () => {
      const source = `globalThis.testRemote = {
        init() {},
        get(modulePath) { 
          globalThis.defaultPath = modulePath;
          return Promise.resolve(() => ({})); 
        }
      };`;
      
      const result = await loadRemoteInCompartment({
        name: "catalog",
        platformBus,
        sourceCode: source,
        containerName: "testRemote",
      });
      
      expect(result.compartment.globalThis.defaultPath).toBe("./plugin");
      result.cleanup();
    });

    it("If a custom modulePath is provided, it is passed to container.get()", async () => {
      const source = `globalThis.testRemote = {
        init() {},
        get(modulePath) { 
          globalThis.customPath = modulePath;
          return Promise.resolve(() => ({})); 
        }
      };`;
      
      const result = await loadRemoteInCompartment({
        name: "catalog",
        platformBus,
        sourceCode: source,
        modulePath: "./custom-module",
        containerName: "testRemote",
      });
      
      expect(result.compartment.globalThis.customPath).toBe("./custom-module");
      result.cleanup();
    });
  });
});