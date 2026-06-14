// attest.ts
//
// Host-side attestation service. It provides the crypto authority a realm needs
// as a narrow endowment ("endow the authority, not the material"):
//
//   requestCertificate() — POST the realm's host-assigned id to ITS origin's
//                          /attest endpoint and return the certificate (JWS).
//                          The realm cannot choose the id or the origin: both are
//                          bound by the host when the endowment is built.
//   verify(cert, expectedRealmId) — verify an issuer-signed certificate and check
//                          its realm-id equals the host-stamped sender id.
//
// The realm makes the trust DECISION (it gates its exchange on verify's result);
// the host does the cryptographic math. Verification uses the issuer public keys
// fetched once from each origin's /issuer.jwk (the trust anchors).

import type { RealmRegistry } from "./realm-registry.js";

export type VerifyResult = {
  ok: boolean;
  reason?: string;
  role?: string;
  origin?: string;
  realmId?: string;
};

export type AttestEndowment = {
  requestCertificate(): Promise<string>;
  verify(cert: string, expectedRealmId: string): Promise<VerifyResult>;
};

type CertPayload = {
  realmId: string;
  role: string;
  origin: string;
  iat: number;
  exp: number;
};

// base64url → bytes / string (works in browser and Node 18+ via global atob).
function b64urlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64.padEnd(Math.ceil(b64.length / 4) * 4, "=");
  const bin = atob(padded);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function b64urlToString(s: string): string {
  return new TextDecoder().decode(b64urlToBytes(s));
}

export function createAttestService(args: {
  registry: RealmRegistry;
  /** Injectable for tests; defaults to global fetch. */
  fetchFn?: typeof fetch;
}) {
  const { registry } = args;
  const fetchFn = args.fetchFn ?? globalThis.fetch.bind(globalThis);
  const subtle = globalThis.crypto.subtle;

  // origin → imported issuer public key (trust anchor)
  const anchors = new Map<string, CryptoKey>();

  async function loadAnchor(origin: string): Promise<void> {
    if (anchors.has(origin)) return;
    const res = await fetchFn(`${origin}/issuer.jwk`);
    if (!res.ok) throw new Error(`could not fetch issuer key from ${origin}: ${res.status}`);
    const jwk = await res.json();
    const key = await subtle.importKey(
      "jwk",
      jwk,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    anchors.set(origin, key);
  }

  // Manually seed an anchor (used by tests to avoid the network).
  function addAnchor(origin: string, key: CryptoKey): void {
    anchors.set(origin, key);
  }

  async function requestCertificate(realmId: string, origin: string): Promise<string> {
    const res = await fetchFn(`${origin}/attest`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ realmId }),
    });
    if (!res.ok) throw new Error(`/attest failed at ${origin}: ${res.status}`);
    const { cert } = await res.json();
    if (typeof cert !== "string") throw new Error(`/attest at ${origin} returned no cert`);
    return cert;
  }

  async function verify(cert: string, expectedRealmId: string): Promise<VerifyResult> {
    const parts = cert.split(".");
    if (parts.length !== 3) return { ok: false, reason: "malformed certificate" };
    const [h, p, s] = parts;

    let payload: CertPayload;
    try {
      payload = JSON.parse(b64urlToString(p));
    } catch {
      return { ok: false, reason: "unreadable certificate payload" };
    }

    const anchor = anchors.get(payload.origin);
    if (!anchor) return { ok: false, reason: `untrusted issuer "${payload.origin}"` };

    const sigOk = await subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      anchor,
      b64urlToBytes(s),
      new TextEncoder().encode(`${h}.${p}`),
    );
    if (!sigOk) return { ok: false, reason: "bad issuer signature" };

    // The crux: the id the issuer signed must equal the id the HOST stamped on
    // the sender's message. A replayed (stolen) cert fails here.
    if (payload.realmId !== expectedRealmId) {
      return {
        ok: false,
        reason: `realmId mismatch — stolen cert (cert=${payload.realmId.slice(0, 8)} sender=${expectedRealmId.slice(0, 8)})`,
      };
    }

    const now = Math.floor(Date.now() / 1000);
    if (typeof payload.exp === "number" && now > payload.exp) {
      return { ok: false, reason: "certificate expired" };
    }
    if (!registry.has(payload.realmId)) {
      return { ok: false, reason: "realmId not in registry" };
    }

    return { ok: true, role: payload.role, origin: payload.origin, realmId: payload.realmId };
  }

  /**
   * Build the per-realm endowment. `realmId` and `origin` are baked in by the
   * host, so the realm can neither pick a different id nor attest with a
   * different origin — it can only request a cert for what it actually is.
   */
  function makeEndowment(realmId: string, origin: string): AttestEndowment {
    return harden({
      requestCertificate: () => requestCertificate(realmId, origin),
      verify: (cert: string, expectedRealmId: string) => verify(cert, expectedRealmId),
    });
  }

  return { loadAnchor, addAnchor, verify, makeEndowment };
}

export type AttestService = ReturnType<typeof createAttestService>;
