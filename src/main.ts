import { PlatformEventBus } from "./platform/event-bus.js";
import { createPluginCompartment } from "./platform/compartment-factory.js";
import { spawnPluginWorker } from "./platform/worker-bus-bridge.js";
import { addLogSink } from "./platform/logger.js";
import { createLogRenderer } from "./ui/render-log.js";

import catalogSource from "./plugins/catalog.plugin.js?raw";
import cartSource from "./plugins/cart.plugin.js?raw";
import maliciousSource from "./plugins/malicious.plugin.js?raw";
import mutationSource from "./plugins/mutation.plugin.js?raw";

document.addEventListener("DOMContentLoaded", () => {
  const renderer = createLogRenderer("log-panel");

  addLogSink(({ source, message }) => {
    renderer.append(source, message);
  });

  // ----------------------------------------------------------------
  // Scenario: in-thread SES compartments (existing)
  // ----------------------------------------------------------------

  async function runHappyPath() {
    renderer.append("host", "--- Happy Path (in-thread) ---");
    const platformBus = new PlatformEventBus();

    const catalog = createPluginCompartment({ name: "catalog", platformBus, sourceCode: catalogSource });
    createPluginCompartment({ name: "cart", platformBus, sourceCode: cartSource });

    const selectItem = catalog.globalThis.selectItem as (id: string, qty: number) => void;
    selectItem("sku_123", 1);

    await new Promise((r) => setTimeout(r, 100));
  }

  async function runMalicious() {
    renderer.append("host", "--- Malicious Plugin (in-thread) ---");
    const platformBus = new PlatformEventBus();

    createPluginCompartment({ name: "malicious", platformBus, sourceCode: maliciousSource });

    await new Promise((r) => setTimeout(r, 50));
  }

  async function runMutation() {
    renderer.append("host", "--- Mutation Attack (in-thread) ---");
    const platformBus = new PlatformEventBus();

    createPluginCompartment({ name: "catalog", platformBus, sourceCode: catalogSource });
    createPluginCompartment({ name: "mutation", platformBus, sourceCode: mutationSource });

    await new Promise((r) => setTimeout(r, 100));
  }

  // ----------------------------------------------------------------
  // Scenario: Worker-based compartments
  // ----------------------------------------------------------------

  async function runWorkerDemo() {
    renderer.append("host", "--- Happy Path (workers) ---");
    const platformBus = new PlatformEventBus();

    const workerUrl = new URL("./workers/plugin-worker.ts", import.meta.url);

    const catalogHandle = spawnPluginWorker({
      name: "catalog",
      platformBus,
      pluginSource: catalogSource,
      workerUrl,
    });

    const cartHandle = spawnPluginWorker({
      name: "cart",
      platformBus,
      pluginSource: cartSource,
      workerUrl,
    });

    // Wait for both workers to finish evaluating plugin code
    await Promise.all([catalogHandle.ready, cartHandle.ready]);

    renderer.append("host", "both workers ready — triggering catalog:item-selected via postMessage");

    // The catalog plugin exposes selectItem on its compartment globalThis,
    // but in a Worker we can't reach compartment.globalThis directly.
    // Instead publish directly through the bus, same as the plugin would.
    platformBus.publish("host", "catalog:item-selected", { itemId: "sku_worker_42", quantity: 2 });

    // Wait for async cross-worker delivery
    await new Promise((r) => setTimeout(r, 300));

    renderer.append("host", "worker demo complete — terminating workers");
    catalogHandle.terminate();
    cartHandle.terminate();
  }

  // ----------------------------------------------------------------
  // Button wiring
  // ----------------------------------------------------------------

  document.getElementById("btn-happy")!.addEventListener("click", () => runHappyPath());
  document.getElementById("btn-malicious")!.addEventListener("click", () => runMalicious());
  document.getElementById("btn-mutation")!.addEventListener("click", () => runMutation());
  document.getElementById("btn-workers")!.addEventListener("click", () => runWorkerDemo());
  document.getElementById("btn-clear")!.addEventListener("click", () => renderer.clear());
});
