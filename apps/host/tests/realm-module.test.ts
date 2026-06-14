import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { PlatformEventBus } from "@poc/shared";
import { loadRemoteInCompartment } from "../src/platform/compartment-loader.js";

// Load the REAL built catalog realm bundle (requires `pnpm build:remotes`).
// Skip gracefully if the remotes have not been built.
function tryLoadBundle(): { entry: string; chunk: string } | null {
  try {
    const dist = new URL("../../catalog/dist/", import.meta.url);
    const entry = readFileSync(new URL("remoteEntry.js", dist), "utf8");
    const asyncDir = new URL("static/js/async/", dist);
    const chunkName = readdirSync(asyncDir).find(
      (f) => f.startsWith("__federation_expose_realm") && f.endsWith(".js"),
    )!;
    const chunk = readFileSync(new URL(chunkName, asyncDir), "utf8");
    return { entry, chunk };
  } catch {
    return null;
  }
}
const bundle = tryLoadBundle();
const entry = bundle?.entry ?? "";
const chunk = bundle?.chunk ?? "";

function makeAttest() {
  const calls = { requested: 0 };
  const attest = {
    requestCertificate: async () => {
      calls.requested++;
      return "h.p.s";
    },
    verify: async () => ({ ok: false, reason: "n/a" }),
  };
  return { attest, calls };
}

async function loadCatalogRealm(required: boolean, realmId = "rid-test") {
  const platformBus = new PlatformEventBus();
  const { attest, calls } = makeAttest();
  const result = await loadRemoteInCompartment({
    name: "catalog-realm",
    platformBus,
    sourceCode: entry,
    exposeChunkSource: chunk,
    containerName: "catalogRemote",
    modulePath: "./realm",
    realmId,
    extraEndowments: { realmId, attestationRequired: required, attest },
  });
  return { result, calls, platformBus };
}

describe.skipIf(!bundle)("realm module — endowment threading (real MF bundle)", () => {
  it("exposes start/setValue/getStatus", async () => {
    const { result } = await loadCatalogRealm(true);
    expect(typeof result.exports.start).toBe("function");
    expect(typeof result.exports.setValue).toBe("function");
    expect(typeof result.exports.getStatus).toBe("function");
  });

  it("attestationRequired=true → start() requests a certificate", async () => {
    const { result, calls } = await loadCatalogRealm(true);
    (result.exports.start as () => void)();
    await new Promise((r) => setTimeout(r, 30));
    expect(calls.requested).toBe(1);
  });

  it("attestationRequired=false → start() does nothing", async () => {
    const { result, calls } = await loadCatalogRealm(false);
    (result.exports.start as () => void)();
    await new Promise((r) => setTimeout(r, 30));
    expect(calls.requested).toBe(0);
  });

  it("getStatus reflects the endowed realmId", async () => {
    const { result } = await loadCatalogRealm(true, "rid-XYZ");
    const st = (result.exports.getStatus as () => { realmId: string })();
    expect(st.realmId).toBe("rid-XYZ");
  });
});
