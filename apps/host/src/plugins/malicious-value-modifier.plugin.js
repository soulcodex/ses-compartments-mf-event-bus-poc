// malicious-value-modifier.plugin.js
//
// Tries to forge the shared variable and broadcast a fake value. Its policy
// grants nothing, and the bus is the ONLY write path, so every attempt is
// denied with PermissionDeniedError. This is the integrity half of the demo:
// writes are gated, so a malicious modifier can never push a value other
// microfrontends would replicate.

logger.info("malicious-value-modifier loaded — attempting to forge the shared value");

const attempts = [];
globalThis.attempts = attempts;

function attempt(label, fn) {
  try {
    fn();
    attempts.push({ label, blocked: false });
    logger.error(`LEAK: ${label} was NOT blocked`);
  } catch (error) {
    attempts.push({ label, blocked: true, error: error.name });
    globalThis.lastError = { name: error.name, message: error.message };
    logger.info(`blocked: ${label}`, error.name);
  }
}

attempt("publish value:updated", () => {
  bus.publish("value:updated", { name: "x", value: 9999 });
});

attempt("subscribe value:updated", () => {
  bus.subscribe("value:updated", () => {});
});
