// realm.ts — exposed as the MF remote module "./realm".
//
// An attested value realm. Attestation ALWAYS runs (request a certificate,
// announce it, verify peers). The `mode` endowment decides what a certificate
// failure means:
//   - "enforce": reject communication with unattested realms (directed delivery
//     to attested peers only; drop values from unattested senders).
//   - "observe": ignore failures — accept/broadcast as usual, but LOG every
//     violation. This is the monitor/dry-run stage of a staged rollout.
//
// On (re)deploy it recovers the counter from peers: peers push their value when
// they attest a freshly announced realm, and re-announce their own hello so the
// late-joining instance can attest them back.
//
// Endowments: bus, logger, attest, mode, realmId.

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
declare const mode: "observe" | "enforce";
declare const realmId: string;

const ROLE = "catalog";

let localValue: number | null = null;
let certStatus: "none" | "ok" | "error" = "none";
let violations = 0;
let myCert: string | null = null;
const attestedPeers = new Set<string>();

logger.info(`${ROLE}-realm loaded (mode=${mode})`);

// Enforce → directed to self + attested peers; observe → broadcast (undefined).
function sendValue(n: number): void {
  const recipients = mode === "enforce" ? [realmId, ...attestedPeers] : undefined;
  bus.publish("value:updated", { name: "x", value: n }, recipients);
}

// Replicate the counter. Attestation always runs; mode decides the response to
// a value from a sender we have not attested.
bus.subscribe("value:updated", (event) => {
  const trusted = event.realmId === realmId || attestedPeers.has(event.realmId);
  if (!trusted) {
    if (mode === "enforce") {
      logger.error(`ENFORCE: rejected value from unattested ${event.realmId.slice(0, 8)}`);
      return;
    }
    violations++;
    logger.error(
      `OBSERVE: accepted UNATTESTED value from ${event.realmId.slice(0, 8)} (would reject in enforce)`,
    );
  }
  localValue = (event.payload as { value: number }).value;
});

// Verify peers' handshakes. On first attesting a peer, re-announce our own hello
// (so a late-joining redeployed peer can attest us back) and push our current
// value (so it recovers state).
bus.subscribe("attest:hello", (event) => {
  if (event.realmId === realmId) return;
  const cert = event.payload.cert as string;
  const wasNew = !attestedPeers.has(event.realmId);
  void attest.verify(cert, event.realmId).then((res) => {
    if (res.ok) {
      attestedPeers.add(event.realmId);
      logger.info(`attested peer ${res.role} (${event.realmId.slice(0, 8)})`);
      if (wasNew && myCert !== null) bus.publish("attest:hello", { cert: myCert });
      if (localValue !== null) sendValue(localValue);
    } else {
      logger.error(`failed to attest ${event.realmId.slice(0, 8)}: ${res.reason}`);
    }
  });
});

// Answer a (re)deployed peer's sync request with our current value.
bus.subscribe("value:sync-request", (event) => {
  if (event.realmId === realmId || localValue === null) return;
  if (mode === "enforce" && !attestedPeers.has(event.realmId)) return;
  sendValue(localValue);
});

// Called by the host after all realms are loaded (so everyone is subscribed
// before anyone announces). Requests our certificate, announces it, and asks
// peers for the current counter value.
export function start(): void {
  void attest
    .requestCertificate()
    .then((cert) => {
      myCert = cert;
      certStatus = "ok";
      logger.info(`${ROLE}-realm got certificate from origin`);
      bus.publish("attest:hello", { cert });
      bus.publish("value:sync-request", {});
    })
    .catch((err) => {
      certStatus = "error";
      logger.error(`attestation failed: ${String(err)}`);
    });
}

export function setValue(n: number): void {
  sendValue(n);
}

export function getLocal(): number | null {
  return localValue;
}

export function getStatus(): {
  realmId: string;
  role: string;
  mode: string;
  certStatus: string;
  attestedPeers: number;
  localValue: number | null;
  violations: number;
} {
  return {
    realmId,
    role: ROLE,
    mode,
    certStatus,
    attestedPeers: attestedPeers.size,
    localValue,
    violations,
  };
}
