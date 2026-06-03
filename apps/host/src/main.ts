import { PlatformEventBus } from "@poc/shared";
import { addLogSink } from "@poc/shared";
import { createPluginCompartment } from "./platform/compartment-factory.js";
import { spawnPluginWorker } from "./platform/worker-bus-bridge.js";
import { loadRemoteInCompartment, fetchRemoteSource } from "./platform/compartment-loader.js";
import { createLogRenderer } from "./ui/render-log.js";

// ?worker tells Rsbuild to bundle plugin-worker.ts as a separate worker chunk
// and hand back a constructor. This is the only correct way to get a Worker
// that the browser can actually load — a raw .ts URL would not be parseable.
import PluginWorker from "./workers/plugin-worker.ts?worker";

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
    const catalogHandle = spawnPluginWorker({ name: "catalog", platformBus, pluginSource: catalogSource, WorkerClass: PluginWorker });
    const cartHandle = spawnPluginWorker({ name: "cart", platformBus, pluginSource: cartSource, WorkerClass: PluginWorker });
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

    // IMPORTANT: The MF demo requires production-built remote artifacts.
    //
    // Dev server output includes HMR devtools, isomorphic-ws WebSocket clients,
    // and source-map annotations injected by @module-federation/rsbuild-plugin.
    // These devtools bundle isomorphic-ws whose .default constructor is
    // undefined inside a SES Compartment (the module was evaluated in the host
    // realm and its exports are not available as compartment endowments).
    //
    // Only production builds (pnpm build) produce clean IIFEs that can be
    // evaluated inside a SES Compartment.
    //
    // To run this demo:
    //   cd apps/catalog && pnpm build && npx serve dist -p 4001 --cors
    //   cd apps/cart    && pnpm build && npx serve dist -p 4002 --cors
    //
    // The host will fetch from ports 4001/4002 (production artifacts).
    const CATALOG_BASE = "http://localhost:4001";
    const CART_BASE    = "http://localhost:4002";

    renderer.append("host", `fetching production artifacts from ${CATALOG_BASE} and ${CART_BASE} ...`);

    const platformBus = new PlatformEventBus();

    const [
      catalogEntrySource, catalogManifest,
      cartEntrySource,    cartManifest,
    ] = await Promise.all([
      fetchRemoteSource(`${CATALOG_BASE}/remoteEntry.js`).catch(() => null),
      fetchRemoteSource(`${CATALOG_BASE}/mf-manifest.json`).catch(() => null),
      fetchRemoteSource(`${CART_BASE}/remoteEntry.js`).catch(() => null),
      fetchRemoteSource(`${CART_BASE}/mf-manifest.json`).catch(() => null),
    ]);

    if (!catalogEntrySource || !cartEntrySource) {
      renderer.append("host", "⚠  Production remotes not found.");
      renderer.append("host", "   Build + serve them first:");
      renderer.append("host", "   pnpm --filter @poc/catalog build");
      renderer.append("host", "   pnpm --filter @poc/cart build");
      renderer.append("host", "   npx serve apps/catalog/dist -p 4001 --cors");
      renderer.append("host", "   npx serve apps/cart/dist    -p 4002 --cors");
      return;
    }

    // Resolve the expose chunk path from the manifest (sync array = bundled chunk).
    const resolveExposeChunk = async (manifestJson: string | null, baseUrl: string) => {
      if (!manifestJson) return undefined;
      try {
        const manifest = JSON.parse(manifestJson);
        const exposes = manifest?.exposes ?? [];
        const pluginExpose = exposes.find((e: { path: string }) => e.path === "./plugin");
        // Rsbuild puts the expose chunk in assets.js.sync (bundled with remoteEntry)
        const chunkPath = pluginExpose?.assets?.js?.sync?.[0]
                       ?? pluginExpose?.assets?.js?.async?.[0];
        if (!chunkPath) return undefined;
        return fetchRemoteSource(`${baseUrl}/${chunkPath}`).catch(() => undefined);
      } catch { return undefined; }
    };

    const [catalogChunkSource, cartChunkSource] = await Promise.all([
      resolveExposeChunk(catalogManifest, CATALOG_BASE),
      resolveExposeChunk(cartManifest, CART_BASE),
    ]);

    renderer.append("host", "artifacts fetched — loading inside SES compartments ...");

    const catalogRemote = await loadRemoteInCompartment({
      name: "catalog",
      platformBus,
      sourceCode: catalogEntrySource,
      exposeChunkSource: catalogChunkSource,
      containerName: "catalogRemote",
    });

    const cartRemote = await loadRemoteInCompartment({
      name: "cart",
      platformBus,
      sourceCode: cartEntrySource,
      exposeChunkSource: cartChunkSource,
      containerName: "cartRemote",
    });

    renderer.append("host", "both MF remotes loaded inside SES compartments ✓");

    const selectItem = catalogRemote.exports.selectItem as ((id: string, qty: number) => void) | undefined;
    if (typeof selectItem === "function") {
      selectItem("sku_mf_1", 1);
    } else {
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