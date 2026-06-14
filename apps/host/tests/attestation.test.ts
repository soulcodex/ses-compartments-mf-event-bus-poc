import { describe, it, expect, beforeAll } from "vitest";
import { webcrypto } from "node:crypto";
import { RealmRegistry } from "../src/platform/realm-registry.js";
import { createAttestService } from "../src/platform/attest.js";
import { PlatformEventBus } from "@poc/shared";
import { initializeSES } from "../src/platform/lockdown.js";

// PlatformEventBus.publish hardens payloads, so SES must be locked down first.
beforeAll(() => initializeSES());

// Node provides global crypto on 20+, but seed it defensively for the test env.
if (!globalThis.crypto) {
  (globalThis as unknown as { crypto: Crypto }).crypto = webcrypto as unknown as Crypto;
}
const subtle = globalThis.crypto.subtle;
const ORIGIN = "http://localhost:4001";

const b64url = (buf: ArrayBuffer | Uint8Array) =>
  Buffer.from(buf instanceof Uint8Array ? buf : new Uint8Array(buf)).toString("base64url");

// Mirrors scripts/origin-server.mjs so we exercise the same JWS the real
// issuer produces — without a network round-trip.
async function signCert(
  privateKey: CryptoKey,
  fields: { realmId: string; role: string; origin: string; exp?: number },
): Promise<string> {
  const header = { alg: "ES256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    realmId: fields.realmId,
    role: fields.role,
    origin: fields.origin,
    iat: now,
    exp: fields.exp ?? now + 3600,
  };
  const input = `${b64url(Buffer.from(JSON.stringify(header)))}.${b64url(Buffer.from(JSON.stringify(payload)))}`;
  const sig = await subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privateKey,
    new TextEncoder().encode(input),
  );
  return `${input}.${b64url(new Uint8Array(sig))}`;
}

let issuer: CryptoKeyPair;
let issuerPublic: CryptoKey;

beforeAll(async () => {
  issuer = (await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const jwk = await subtle.exportKey("jwk", issuer.publicKey);
  issuerPublic = await subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, [
    "verify",
  ]);
});

function service() {
  const registry = new RealmRegistry();
  const svc = createAttestService({ registry });
  svc.addAnchor(ORIGIN, issuerPublic);
  return { registry, svc };
}

describe("realm attestation — verify", () => {
  it("accepts a valid cert whose realmId matches the host-stamped sender id", async () => {
    const { registry, svc } = service();
    const realmId = registry.register("catalog", ORIGIN);
    const cert = await signCert(issuer.privateKey, { realmId, role: "catalog", origin: ORIGIN });

    const res = await svc.verify(cert, realmId);
    expect(res.ok).toBe(true);
    expect(res.role).toBe("catalog");
    expect(res.realmId).toBe(realmId);
  });

  it("rejects a stolen cert replayed by a different realm (realmId mismatch)", async () => {
    const { registry, svc } = service();
    const victimId = registry.register("catalog", ORIGIN);
    const attackerId = registry.register("malicious", "in-thread");
    const stolen = await signCert(issuer.privateKey, { realmId: victimId, role: "catalog", origin: ORIGIN });

    // The attacker presents the victim's cert, but its messages are stamped with
    // the attacker's id — that is what verify() checks against.
    const res = await svc.verify(stolen, attackerId);
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/mismatch|stolen/i);
  });

  it("rejects a cert from an untrusted issuer (no anchor)", async () => {
    const registry = new RealmRegistry();
    const svc = createAttestService({ registry }); // no addAnchor
    const realmId = registry.register("catalog", ORIGIN);
    const cert = await signCert(issuer.privateKey, { realmId, role: "catalog", origin: ORIGIN });

    const res = await svc.verify(cert, realmId);
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/untrusted issuer/i);
  });

  it("rejects an expired cert", async () => {
    const { registry, svc } = service();
    const realmId = registry.register("catalog", ORIGIN);
    const past = Math.floor(Date.now() / 1000) - 10;
    const cert = await signCert(issuer.privateKey, { realmId, role: "catalog", origin: ORIGIN, exp: past });

    const res = await svc.verify(cert, realmId);
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/expired/i);
  });

  it("rejects a realmId that is not registered (not a live realm)", async () => {
    const { svc } = service(); // registry has no realms
    const ghostId = crypto.randomUUID();
    const cert = await signCert(issuer.privateKey, { realmId: ghostId, role: "catalog", origin: ORIGIN });

    const res = await svc.verify(cert, ghostId);
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/registry/i);
  });

  it("rejects a tampered cert (bad signature)", async () => {
    const { registry, svc } = service();
    const realmId = registry.register("catalog", ORIGIN);
    const cert = await signCert(issuer.privateKey, { realmId, role: "catalog", origin: ORIGIN });
    // Flip the role in the payload without re-signing.
    const [h, , s] = cert.split(".");
    const forgedPayload = b64url(
      Buffer.from(JSON.stringify({ realmId, role: "admin", origin: ORIGIN, iat: 0, exp: 9_999_999_999 })),
    );
    const tampered = `${h}.${forgedPayload}.${s}`;

    const res = await svc.verify(tampered, realmId);
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/signature/i);
  });
});

describe("bus — directed delivery (the confidentiality mechanism)", () => {
  const wait = () => new Promise((r) => setTimeout(r, 10));

  it("delivers a directed message only to the addressed realm", async () => {
    const bus = new PlatformEventBus();
    const got: Record<string, number> = {};
    bus.subscribe("value:updated", (e) => { got.alice = (e.payload as { value: number }).value; }, "alice");
    bus.subscribe("value:updated", (e) => { got.mallory = (e.payload as { value: number }).value; }, "mallory");

    // alice sends only to herself + bob — mallory is not in the recipient set.
    bus.publish("alice", "value:updated", { name: "x", value: 42 }, "alice", ["alice", "bob"]);
    await wait();

    expect(got.alice).toBe(42);
    expect(got.mallory).toBeUndefined(); // starved — never received the bytes
  });

  it("broadcasts to every subscriber when no recipients are given (the off baseline)", async () => {
    const bus = new PlatformEventBus();
    const got: Record<string, number> = {};
    bus.subscribe("value:updated", (e) => { got.alice = (e.payload as { value: number }).value; }, "alice");
    bus.subscribe("value:updated", (e) => { got.mallory = (e.payload as { value: number }).value; }, "mallory");

    bus.publish("alice", "value:updated", { name: "x", value: 7 }, "alice");
    await wait();

    expect(got.alice).toBe(7);
    expect(got.mallory).toBe(7); // no attestation → everyone sniffs
  });
});
