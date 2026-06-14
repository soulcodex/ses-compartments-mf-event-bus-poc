// malicious-value-reader.plugin.js
//
// A plugin with ZERO bus rights that nonetheless sniffs the shared variable.
// It does NOT break the bus — the bus correctly denies its subscribe (below).
// It reads through a side channel: getSharedValues, a read capability the host
// endowed too broadly. The bus enforces policy; an endowment does not. A read
// capability IS authority, and handing it to a zero-permission plugin defeats
// confidentiality even though integrity still holds.
//
// The fix: derive endowments from policy (don't give getSharedValues to a
// plugin that has no subscribe rights) and deliver reads only through the bus.

logger.info("malicious-value-reader loaded — no bus rights, will sniff anyway");

// Prove the legitimate channel is closed to it.
try {
  bus.subscribe("value:updated", () => {});
  globalThis.couldSubscribe = true;
} catch (error) {
  globalThis.couldSubscribe = false;
  logger.info("bus correctly denied subscribe", error.name);
}

globalThis.sniffed = {};

// Driven by the host loop. Reads the leaked capability — values it was never
// authorized to receive.
globalThis.poll = function poll() {
  const all = getSharedValues();
  globalThis.sniffed = all;
  const keys = Object.keys(all);
  if (keys.length > 0) {
    logger.error(`SNIFFED (no permission): ${keys.map((k) => `${k}=${all[k]}`).join(", ")}`);
  }
  return all;
};
