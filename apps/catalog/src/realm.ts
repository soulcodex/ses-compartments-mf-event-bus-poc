// realm.ts — exposed as the MF remote module "./realm".
//
// An attested value realm. It holds a local replica of the shared variable `x`
// and, when attestation is required, only replicates updates from peers whose
// origin certificate it has verified. Endowments (injected at runtime inside the
// SES compartment): bus, logger, attest, attestationRequired, realmId.

type Envelope = { realmId: string; source: string; payload: Record<string, unknown> };
declare const bus: {
  publish(topic: string, payload: unknown, recipients?: readonly string[]): void;
  subscribe(topic: string, handler: (event: Envelope) => void): () => void;
};
declare const logger: { info(...a: unknown[]): void; error(...a: unknown[]): void };
declare const attest: {
  requestCertificate(): Promise<string>;
  verify(
    cert: string,
    expectedRealmId: string,
  ): Promise<{ ok: boolean; reason?: string; role?: string; realmId?: string }>;
};
declare const attestationRequired: boolean;
declare const realmId: string;

const ROLE = "catalog";

let localValue: number | null = null;
let certStatus: "none" | "ok" | "error" = "none";
const attestedPeers = new Set<string>();

logger.info(`${ROLE}-realm loaded (attestationRequired=${attestationRequired})`);

// Replicate the shared variable. With directed delivery the host already only
// hands us messages addressed to us; we additionally drop anything from a sender
// we have not attested (our own echo is always allowed).
bus.subscribe("value:updated", (event) => {
  const fromSelf = event.realmId === realmId;
  if (attestationRequired && !fromSelf && !attestedPeers.has(event.realmId)) {
    logger.error(`dropped value from unattested ${event.realmId.slice(0, 8)}`);
    return;
  }
  localValue = (event.payload as { value: number }).value;
});

if (attestationRequired) {
  // Verify every peer handshake. The id we verify against is the HOST-stamped
  // sender id (event.realmId), which the sender cannot forge — a replayed cert
  // whose realmId differs from the stamp is rejected here.
  bus.subscribe("attest:hello", (event) => {
    if (event.realmId === realmId) return; // ignore our own announcement
    const cert = event.payload.cert as string;
    void attest.verify(cert, event.realmId).then((res) => {
      if (res.ok) {
        attestedPeers.add(event.realmId);
        logger.info(`attested peer ${res.role} (${event.realmId.slice(0, 8)})`);
      } else {
        logger.error(`rejected peer ${event.realmId.slice(0, 8)}: ${res.reason}`);
      }
    });
  });

}

// Called by the host AFTER all realms are loaded, so every realm is already
// subscribed before anyone announces (no handshake is missed). Requests our
// certificate from our origin and broadcasts the hello.
export function start(): void {
  if (!attestationRequired) return;
  void attest
    .requestCertificate()
    .then((cert) => {
      certStatus = "ok";
      logger.info(`${ROLE}-realm got certificate from origin`);
      bus.publish("attest:hello", { cert });
    })
    .catch((err) => {
      certStatus = "error";
      logger.error(`attestation failed: ${String(err)}`);
    });
}

export function setValue(n: number): void {
  const payload = { name: "x", value: n };
  if (attestationRequired) {
    // Send only to ourselves and the peers we have attested. An unattested
    // realm (no valid certificate) is in nobody's recipient set, so the host
    // never delivers it the value — it cannot sniff.
    bus.publish("value:updated", payload, [realmId, ...attestedPeers]);
  } else {
    bus.publish("value:updated", payload); // no attestation → broadcast baseline
  }
}

export function getLocal(): number | null {
  return localValue;
}

export function getStatus(): {
  realmId: string;
  role: string;
  certStatus: string;
  attestedPeers: number;
  localValue: number | null;
} {
  return { realmId, role: ROLE, certStatus, attestedPeers: attestedPeers.size, localValue };
}
