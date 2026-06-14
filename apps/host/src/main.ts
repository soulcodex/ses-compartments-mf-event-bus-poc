import { PlatformEventBus } from "@poc/shared";
import { addLogSink } from "@poc/shared";
import { createPluginCompartment } from "./platform/compartment-factory.js";
import { initializeSES } from "./platform/lockdown.js";
import { spawnPluginWorker } from "./platform/worker-bus-bridge.js";
import { loadRemoteInCompartment, fetchRemoteSource } from "./platform/compartment-loader.js";
import { createLogRenderer } from "./ui/render-log.js";
import { createValueBoard } from "./ui/value-board.js";

// ?worker tells Rsbuild to bundle plugin-worker.ts as a separate worker chunk
// and hand back a constructor. This is the only correct way to get a Worker
// that the browser can actually load — a raw .ts URL would not be parseable.
import PluginWorker from "./workers/plugin-worker.ts?worker";

import catalogSource from "./plugins/catalog.plugin.js?raw";
import cartSource from "./plugins/cart.plugin.js?raw";
import maliciousSource from "./plugins/malicious.plugin.js?raw";
import mutationSource from "./plugins/mutation.plugin.js?raw";

import valueModifierSource from "./plugins/value-modifier.plugin.js?raw";
import valueReaderSource from "./plugins/value-reader.plugin.js?raw";
import maliciousValueModifierSource from "./plugins/malicious-value-modifier.plugin.js?raw";
import maliciousValueReaderSource from "./plugins/malicious-value-reader.plugin.js?raw";
import maliciousRealmSource from "./plugins/malicious-realm.plugin.js?raw";

import { RealmRegistry } from "./platform/realm-registry.js";
import { createAttestService } from "./platform/attest.js";

document.addEventListener("DOMContentLoaded", () => {
  const renderer = createLogRenderer("log-panel");
  const valueBoard = createValueBoard("value-board");
  let valueInterval: ReturnType<typeof setInterval> | null = null;

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

  function stopValueDemo() {
    if (valueInterval !== null) {
      clearInterval(valueInterval);
      valueInterval = null;
    }
  }

  function runValueDemo() {
    // Re-running tears down any previous loop and clears the board.
    stopValueDemo();
    valueBoard.clear();
    renderer.append("host", "--- Variable Demo (replicated shared value) ---");

    // Run lockdown up front so harden() is available before we build endowments.
    initializeSES();

    const platformBus = new PlatformEventBus();

    // Host-owned mirror of the shared variable, fed only from the gated bus.
    // Used to render and to back the (deliberately leaked) read capability.
    const board = new Map<string, number>();
    platformBus.subscribe("value:updated", (event) => {
      const p = event.payload as { name: string; value: number };
      board.set(p.name, p.value);
    });

    // ⚠ DELIBERATE VULNERABILITY — the point of the malicious-reader demo.
    // A read capability over the whole shared store. The bus enforces per-plugin
    // policy; this endowment does NOT. Handing it to a zero-permission plugin
    // lets it sniff the value. Correct fix: derive endowments from policy and
    // deliver reads only through the gated bus. See README "Endowments...".
    const getSharedValues = () => harden({ ...Object.fromEntries(board) });

    type LocalApi = { getLocal(): number | null };

    const modifiers = [
      { id: "mod-a", title: "Modifier A" },
      { id: "mod-b", title: "Modifier B" },
    ].map((meta) => ({
      meta,
      compartment: createPluginCompartment({
        name: "value-modifier",
        platformBus,
        sourceCode: valueModifierSource,
      }),
    }));

    const reader = createPluginCompartment({
      name: "value-reader",
      platformBus,
      sourceCode: valueReaderSource,
    });

    const malModifier = createPluginCompartment({
      name: "malicious-value-modifier",
      platformBus,
      sourceCode: maliciousValueModifierSource,
    });

    const malReader = createPluginCompartment({
      name: "malicious-value-reader",
      platformBus,
      sourceCode: maliciousValueReaderSource,
      extraEndowments: { getSharedValues }, // the leak lands here
    });

    // --- Cards -------------------------------------------------------------
    for (const { meta, compartment } of modifiers) {
      const setValue = compartment.globalThis.setValue as (n: number) => void;
      valueBoard.addCard({
        id: meta.id,
        title: meta.title,
        role: "modifier",
        subtitle: "value-modifier · publish + subscribe",
        input: { initial: 0 },
        controls: [{ label: "Set x", onClick: (v) => setValue(Number(v)) }],
      });
    }

    valueBoard.addCard({
      id: "reader",
      title: "Reader",
      role: "reader",
      subtitle: "value-reader · subscribe only",
    });
    valueBoard.addCard({
      id: "mal-mod",
      title: "Malicious Modifier",
      role: "malicious",
      subtitle: "malicious-value-modifier · no rights",
    });
    valueBoard.addCard({
      id: "mal-read",
      title: "Malicious Reader",
      role: "malicious",
      subtitle: "malicious-value-reader · no rights",
    });

    const fmt = (v: number | null | undefined) =>
      v === null || v === undefined ? "—" : `x = ${v}`;

    // --- Render loop -------------------------------------------------------
    function render() {
      // Each modifier shows its OWN local replica — watch them converge on Set.
      for (const { meta, compartment } of modifiers) {
        const local = (compartment.globalThis as unknown as LocalApi).getLocal();
        valueBoard.updateCard(meta.id, {
          big: fmt(local),
          badge: { text: "local replica", kind: "ok" },
        });
      }

      // Legit reader — replica arrived through the gated bus.
      const rv = (reader.globalThis as unknown as LocalApi).getLocal();
      valueBoard.updateCard("reader", {
        big: fmt(rv),
        badge: { text: "subscribed", kind: "ok" },
      });

      // Malicious modifier — every write attempt was denied.
      const attempts =
        (malModifier.globalThis.attempts as { label: string; blocked: boolean; error?: string }[]) ??
        [];
      valueBoard.updateCard("mal-mod", {
        big: "⛔",
        badge: { text: "BLOCKED", kind: "blocked" },
        rows: attempts.map(
          (a) => `${a.blocked ? "⛔" : "⚠ LEAK"} ${a.label}${a.error ? ` → ${a.error}` : ""}`,
        ),
      });

      // Malicious reader — sniffs the value via the leaked read capability.
      const poll = malReader.globalThis.poll as (() => void) | undefined;
      poll?.();
      const sniffed = (malReader.globalThis.sniffed as Record<string, number>) ?? {};
      const entries = Object.entries(sniffed);
      valueBoard.updateCard("mal-read", {
        big: entries.length > 0 ? `x = ${entries[0][1]}` : "—",
        badge: { text: "⚠ SNIFFING", kind: "sniff" },
        rows: entries.map(([k, v]) => `${k} = ${v}`),
      });
    }

    render();
    valueInterval = setInterval(render, 200);

    renderer.append(
      "host",
      "variable demo running — type a number and click \"Set x\" on a modifier; every replica converges",
    );
  }

  // ----- Counter Exchange (realm attestation) ----------------------------
  const CATALOG_ORIGIN = "http://localhost:4001";
  const CART_ORIGIN = "http://localhost:4002";

  type RealmStatus = {
    realmId: string;
    role: string;
    certStatus: string;
    attestedPeers: number;
    localValue: number | null;
  };

  async function fetchRealmBundle(origin: string) {
    const [entry, manifest] = await Promise.all([
      fetchRemoteSource(`${origin}/remoteEntry.js`).catch(() => null),
      fetchRemoteSource(`${origin}/mf-manifest.json`).catch(() => null),
    ]);
    if (!entry) return null;
    let exposeChunk: string | undefined;
    if (manifest) {
      try {
        const m = JSON.parse(manifest) as {
          exposes?: { path: string; assets?: { js?: { sync?: string[]; async?: string[] } } }[];
        };
        const realmExpose = (m.exposes ?? []).find((e) => e.path === "./realm");
        const chunkPath = realmExpose?.assets?.js?.sync?.[0] ?? realmExpose?.assets?.js?.async?.[0];
        if (chunkPath) {
          exposeChunk = await fetchRemoteSource(`${origin}/${chunkPath}`).catch(() => undefined);
        }
      } catch {
        /* ignore — chunk is optional */
      }
    }
    return { entry, exposeChunk };
  }

  async function runAttestedDemo(required: boolean) {
    stopValueDemo();
    valueBoard.clear();
    renderer.append("host", `--- Counter Exchange (attestation ${required ? "ON" : "OFF"}) ---`);
    initializeSES();

    const platformBus = new PlatformEventBus();
    const registry = new RealmRegistry();
    const attestService = createAttestService({ registry });

    renderer.append("host", "fetching realm remotes from :4001 and :4002 ...");
    const [catalogBundle, cartBundle] = await Promise.all([
      fetchRealmBundle(CATALOG_ORIGIN),
      fetchRealmBundle(CART_ORIGIN),
    ]);
    if (!catalogBundle || !cartBundle) {
      renderer.append("host", "⚠ realm remotes not found — run `pnpm demo:attest` first");
      return;
    }

    if (required) {
      try {
        await Promise.all([
          attestService.loadAnchor(CATALOG_ORIGIN),
          attestService.loadAnchor(CART_ORIGIN),
        ]);
      } catch (err) {
        renderer.append("host", `⚠ could not load issuer keys: ${String(err)}`);
        return;
      }
    }

    async function loadRealm(
      role: "catalog-realm" | "cart-realm",
      origin: string,
      containerName: string,
      bundle: { entry: string; exposeChunk?: string },
    ) {
      const realmId = registry.register(role, origin);
      const loaded = await loadRemoteInCompartment({
        name: role,
        platformBus,
        sourceCode: bundle.entry,
        exposeChunkSource: bundle.exposeChunk,
        containerName,
        modulePath: "./realm",
        realmId,
        extraEndowments: {
          realmId,
          attestationRequired: required,
          attest: attestService.makeEndowment(realmId, origin),
        },
      });
      return { realmId, exports: loaded.exports };
    }

    const catalog = await loadRealm("catalog-realm", CATALOG_ORIGIN, "catalogRemote", catalogBundle);
    const cart = await loadRealm("cart-realm", CART_ORIGIN, "cartRemote", cartBundle);

    const malRealmId = registry.register("malicious", "in-thread");
    const malicious = createPluginCompartment({
      name: "malicious-realm",
      platformBus,
      sourceCode: maliciousRealmSource,
      realmId: malRealmId,
      extraEndowments: { realmId: malRealmId },
    });

    // Every realm is now loaded and subscribed — announce (no missed handshakes).
    (catalog.exports.start as () => void)();
    (cart.exports.start as () => void)();

    valueBoard.addCard({
      id: "r-catalog",
      title: "catalog realm",
      role: "modifier",
      subtitle: `origin :4001 · ${catalog.realmId.slice(0, 8)}`,
      input: { initial: 0 },
      controls: [{ label: "Set x", onClick: (v) => (catalog.exports.setValue as (n: number) => void)(Number(v)) }],
    });
    valueBoard.addCard({
      id: "r-cart",
      title: "cart realm",
      role: "modifier",
      subtitle: `origin :4002 · ${cart.realmId.slice(0, 8)}`,
      input: { initial: 0 },
      controls: [{ label: "Set x", onClick: (v) => (cart.exports.setValue as (n: number) => void)(Number(v)) }],
    });
    valueBoard.addCard({
      id: "r-mal",
      title: "malicious realm",
      role: "malicious",
      subtitle: `no origin · ${malRealmId.slice(0, 8)}`,
      input: { initial: 666 },
      controls: [{ label: "Inject x", onClick: (v) => (malicious.globalThis.injectValue as (n: number) => void)(Number(v)) }],
    });

    function updateRealmCard(cardId: string, st: RealmStatus) {
      valueBoard.updateCard(cardId, {
        big: st.localValue === null ? "x = —" : `x = ${st.localValue}`,
        badge: !required
          ? { text: "no attestation", kind: "ok" }
          : st.certStatus === "ok"
            ? { text: `cert ✓ · ${st.attestedPeers} peer`, kind: "ok" }
            : st.certStatus === "error"
              ? { text: "cert ✗", kind: "blocked" }
              : { text: "attesting…", kind: "ok" },
      });
    }

    function render() {
      const catalogSt = (catalog.exports.getStatus as () => RealmStatus)();
      const cartSt = (cart.exports.getStatus as () => RealmStatus)();
      updateRealmCard("r-catalog", catalogSt);
      updateRealmCard("r-cart", cartSt);

      const ms = (malicious.globalThis.getStatus as () => {
        stolenCert: boolean;
        lastInjected: number | null;
        lastSniffed: number | null;
      })();

      // Read (sniff): with attestation on, directed delivery starves it → "—".
      const sniff =
        ms.lastSniffed === null || ms.lastSniffed === undefined ? "—" : String(ms.lastSniffed);

      // Write (inject): did the forged value land on a legit realm?
      let injectRow = "inject: —";
      let badge: { text: string; kind: "ok" | "blocked" | "sniff" } = ms.stolenCert
        ? { text: "replayed stolen cert", kind: "sniff" }
        : { text: "no certificate", kind: "blocked" };
      if (ms.lastInjected !== null && ms.lastInjected !== undefined) {
        const landed =
          catalogSt.localValue === ms.lastInjected || cartSt.localValue === ms.lastInjected;
        injectRow = landed
          ? `inject ${ms.lastInjected} → ✓ ACCEPTED`
          : `inject ${ms.lastInjected} → ⛔ REJECTED`;
        badge = landed ? { text: "ATTACK SUCCEEDED", kind: "sniff" } : { text: "EXCLUDED", kind: "blocked" };
      }
      valueBoard.updateCard("r-mal", {
        big: `read: ${sniff}`,
        badge,
        rows: [
          injectRow,
          required ? "attestation on — starved of reads & writes" : "attestation off — reads & writes land",
        ],
      });
    }

    render();
    valueInterval = setInterval(render, 300);
    renderer.append(
      "host",
      required
        ? "attested — Set x on catalog/cart converges; malicious Inject x is rejected"
        : "no attestation — malicious Inject x propagates to catalog & cart (the spoof)",
    );
  }

  document.getElementById("btn-happy")!.addEventListener("click", () => runHappyPath());
  document.getElementById("btn-malicious")!.addEventListener("click", () => runMalicious());
  document.getElementById("btn-mutation")!.addEventListener("click", () => runMutation());
  document.getElementById("btn-workers")!.addEventListener("click", () => runWorkerDemo());
  document.getElementById("btn-mf")!.addEventListener("click", () => runMFDemo());
  document.getElementById("btn-value")!.addEventListener("click", () => runValueDemo());
  document.getElementById("btn-attest")!.addEventListener("click", () => {
    const required = (document.getElementById("chk-attest") as HTMLInputElement).checked;
    void runAttestedDemo(required);
  });
  document.getElementById("btn-clear")!.addEventListener("click", () => {
    stopValueDemo();
    valueBoard.clear();
    renderer.clear();
  });
});