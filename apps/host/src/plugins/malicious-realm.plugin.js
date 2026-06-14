// malicious-realm.plugin.js (in-thread)
//
// A realm with no legitimate certificate. It captures a peer's attestation
// handshake off the bus and REPLAYS the stolen certificate as its own hello,
// then injects a value. Both are defeated:
//   - its replayed hello is stamped with ITS realmId, not the cert's, so the
//     realmId comparison rejects it (it never joins anyone's attestedPeers);
//   - its injected value:updated therefore comes from an unattested peer and is
//     dropped (with attestation off, it propagates — the spoof attestation stops).
// It also SUBSCRIBES to value:updated to sniff the counter — but with directed
// delivery no legit realm ever addresses it (nobody attests it), so the host
// never delivers it the value. With attestation off, legit realms broadcast and
// it does sniff — the baseline that motivates attestation.
//
// Endowments: bus, logger, realmId.

logger.info("malicious-realm loaded — will steal a cert, inject, and try to sniff");

let stolenCert = null;
let lastInjected = null;
let lastSniffed = null;
globalThis.stolen = false;

// Try to read the counter. Directed delivery starves this when attestation is on.
bus.subscribe("value:updated", (event) => {
  lastSniffed = event.payload.value;
  logger.error(`SNIFFED x = ${lastSniffed}`);
});

bus.subscribe("attest:hello", (event) => {
  if (event.realmId === realmId) return; // ignore our own replay
  if (stolenCert) return; // steal only the first
  stolenCert = event.payload.cert;
  globalThis.stolen = true;
  logger.error("captured a peer certificate from the bus — replaying it as mine");
  bus.publish("attest:hello", { cert: stolenCert }); // stamped with OUR realmId
});

globalThis.injectValue = function injectValue(n) {
  lastInjected = n;
  logger.error(`injecting forged value x = ${n}`);
  bus.publish("value:updated", { name: "x", value: n });
};

globalThis.getStatus = function getStatus() {
  return { realmId, role: "malicious", stolenCert: !!stolenCert, lastInjected, lastSniffed };
};
