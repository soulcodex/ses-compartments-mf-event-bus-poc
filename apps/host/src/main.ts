import { PlatformEventBus } from "@poc/shared";
import { addLogSink } from "@poc/shared";
import { createPluginCompartment } from "./platform/compartment-factory.js";
import { spawnPluginWorker } from "./platform/worker-bus-bridge.js";
import { loadRemoteInCompartment, fetchRemoteSource } from "./platform/compartment-loader.js";
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

  async function runWorkerDemo() {
    renderer.append("host", "--- Happy Path (workers) ---");
    const platformBus = new PlatformEventBus();
    const workerUrl = new URL("./workers/plugin-worker.ts", import.meta.url);
    const catalogHandle = spawnPluginWorker({ name: "catalog", platformBus, pluginSource: catalogSource, workerUrl });
    const cartHandle = spawnPluginWorker({ name: "cart", platformBus, pluginSource: cartSource, workerUrl });
    await Promise.all([catalogHandle.ready, cartHandle.ready]);
    renderer.append("host", "both workers ready — triggering catalog:item-selected");
    platformBus.publish("host", "catalog:item-selected", { itemId: "sku_worker_42", quantity: 2 });
    await new Promise((r) => setTimeout(r, 300));
    renderer.append("host", "worker demo complete — terminating workers");
    catalogHandle.terminate();
    cartHandle.terminate();
  }

  async function runMFDemo() {
    renderer.append("host", "--- MF Demo (compartment-loaded remotes) ---");
    const platformBus = new PlatformEventBus();

    renderer.append("host", "fetching catalog remote from http://localhost:3001/remoteEntry.js ...");
    const catalogEntrySource = await fetchRemoteSource("http://localhost:3001/remoteEntry.js").catch(() => null);
    const cartEntrySource = await fetchRemoteSource("http://localhost:3002/remoteEntry.js").catch(() => null);

    if (!catalogEntrySource || !cartEntrySource) {
      renderer.append("host", "⚠ MF remotes not running. Start them with: pnpm dev:remotes");
      return;
    }

    const catalogRemote = await loadRemoteInCompartment({
      name: "catalog",
      platformBus,
      sourceCode: catalogEntrySource,
      containerName: "catalogRemote",
    });

    const cartRemote = await loadRemoteInCompartment({
      name: "cart",
      platformBus,
      sourceCode: cartEntrySource,
      containerName: "cartRemote",
    });

    renderer.append("host", "both MF remotes loaded inside SES compartments");

    // Trigger the catalog plugin if it exports a selectItem function
    const selectItem = catalogRemote.exports.selectItem as ((id: string, qty: number) => void) | undefined;
    if (selectItem) {
      selectItem("sku_mf_1", 1);
    } else {
      // Publish directly via the bus
      platformBus.publish("host", "catalog:item-selected", { itemId: "sku_mf_1", quantity: 1 });
    }

    await new Promise((r) => setTimeout(r, 200));

    renderer.append("host", "MF demo complete");
    catalogRemote.cleanup();
    cartRemote.cleanup();
  }

  document.getElementById("btn-happy")!.addEventListener("click", () => runHappyPath());
  document.getElementById("btn-malicious")!.addEventListener("click", () => runMalicious());
  document.getElementById("btn-mutation")!.addEventListener("click", () => runMutation());
  document.getElementById("btn-workers")!.addEventListener("click", () => runWorkerDemo());
  document.getElementById("btn-mf")!.addEventListener("click", () => runMFDemo());
  document.getElementById("btn-clear")!.addEventListener("click", () => renderer.clear());
});