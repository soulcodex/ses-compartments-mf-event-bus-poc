import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { webcrypto } from "node:crypto";
import { PlatformEventBus } from "@poc/shared";
import { loadRemoteInCompartment } from "../src/platform/compartment-loader.js";
import { RealmRegistry } from "../src/platform/realm-registry.js";
import { createAttestService } from "../src/platform/attest.js";
import { initializeSES } from "../src/platform/lockdown.js";

if (!globalThis.crypto) {
  (globalThis as unknown as { crypto: Crypto }).crypto = webcrypto as unknown as Crypto;
}
const subtle = globalThis.crypto.subtle;
const b64url = (b: ArrayBuffer | Uint8Array) =>
  Buffer.from(b instanceof Uint8Array ? b : new Uint8Array(b)).toString("base64url");

beforeAll(() => initializeSES());

function loadBundle(app: string) {
  const dist = new URL(`../../${app}/dist/`, import.meta.url);
  const entry = readFileSync(new URL("remoteEntry.js", dist), "utf8");
  const asyncDir = new URL("static/js/async/", dist);
  const chunkName = readdirSync(asyncDir).find(
    (f) => f.startsWith("__federation_expose_realm") && f.endsWith(".js"),
  )!;
  const exposeChunk = readFileSync(new URL(chunkName, asyncDir), "utf8");
  return { entry, exposeChunk };
}

// Skip gracefully when the remotes have not been built.
function bundlesBuilt(): boolean {
  try {
    loadBundle("catalog");
    loadBundle("cart");
    return true;
  } catch {
    return false;
  }
}
const built = bundlesBuilt();

// A mock origin server (its own issuer key) that answers /issuer.jwk + /attest.
async function makeOrigin(origin: string, role: string) {
  const key = (await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const jwk = await subtle.exportKey("jwk", key.publicKey);
  async function sign(realmId: string) {
    const header = { alg: "ES256", typ: "JWT" };
    const now = Math.floor(Date.now() / 1000);
    const payload = { realmId, role, origin, iat: now, exp: now + 3600 };
    const input = `${b64url(Buffer.from(JSON.stringify(header)))}.${b64url(Buffer.from(JSON.stringify(payload)))}`;
    const sig = await subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      key.privateKey,
      new TextEncoder().encode(input),
    );
    return `${input}.${b64url(new Uint8Array(sig))}`;
  }
  return { origin, role, jwk, sign };
}

const CAT = "http://catalog.test";
const CART = "http://cart.test";
const wait = (ms = 80) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!built)("realm exchange — full attested handshake + directed delivery (real bundles)", () => {
  it("with attestation: catalog and cart attest and exchange; an unattested realm is starved", async () => {
    const origins: Record<string, Awaited<ReturnType<typeof makeOrigin>>> = {
      [CAT]: await makeOrigin(CAT, "catalog"),
      [CART]: await makeOrigin(CART, "cart"),
    };
    const mockFetch = (async (url: string | URL, opts?: { body?: string }) => {
      const u = String(url);
      for (const o of Object.values(origins)) {
        if (u === `${o.origin}/issuer.jwk`) return { ok: true, json: async () => o.jwk } as Response;
        if (u === `${o.origin}/attest`) {
          const { realmId } = JSON.parse(opts?.body ?? "{}");
          return { ok: true, json: async () => ({ cert: await o.sign(realmId) }) } as Response;
        }
      }
      return { ok: false, status: 404 } as Response;
    }) as unknown as typeof fetch;

    const platformBus = new PlatformEventBus();
    const registry = new RealmRegistry();
    const attest = createAttestService({ registry, fetchFn: mockFetch });
    await attest.loadAnchor(CAT);
    await attest.loadAnchor(CART);

    async function load(app: string, role: "catalog-realm" | "cart-realm", origin: string, container: string) {
      const { entry, exposeChunk } = loadBundle(app);
      const realmId = registry.register(role, origin);
      const loaded = await loadRemoteInCompartment({
        name: role,
        platformBus,
        sourceCode: entry,
        exposeChunkSource: exposeChunk,
        containerName: container,
        modulePath: "./realm",
        realmId,
        extraEndowments: {
          realmId,
          mode: "enforce",
          attest: attest.makeEndowment(realmId, origin),
        },
      });
      return { realmId, exports: loaded.exports };
    }

    const catalog = await load("catalog", "catalog-realm", CAT, "catalogRemote");
    const cart = await load("cart", "cart-realm", CART, "cartRemote");

    // An unattested eavesdropper subscribed to the topic directly on the bus.
    let sniffed: number | null = null;
    platformBus.subscribe("value:updated", (e) => {
      sniffed = (e.payload as { value: number }).value;
    }, "eavesdropper-realm-id");

    (catalog.exports.start as () => void)();
    (cart.exports.start as () => void)();
    await wait(120); // let the handshake complete

    // Both should have attested exactly one peer.
    const cs = (catalog.exports.getStatus as () => { attestedPeers: number; certStatus: string })();
    const ts = (cart.exports.getStatus as () => { attestedPeers: number; certStatus: string })();
    expect(cs.certStatus).toBe("ok");
    expect(ts.certStatus).toBe("ok");
    expect(cs.attestedPeers).toBe(1);
    expect(ts.attestedPeers).toBe(1);

    // The gated exchange works between attested peers.
    (catalog.exports.setValue as (n: number) => void)(42);
    await wait();
    expect((cart.exports.getLocal as () => number | null)()).toBe(42);

    // The unattested eavesdropper was never addressed — it got nothing.
    expect(sniffed).toBeNull();
  });
});
