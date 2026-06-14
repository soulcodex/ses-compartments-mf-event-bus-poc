// value-modifier.plugin.js
//
// Holds a LOCAL replica of a shared variable "x" and is allowed to set it.
// Setting does not mutate the replica directly — it broadcasts a message, and
// the replica is updated only when that message comes back through the bus
// (so its own writes and everyone else's travel the exact same path). This is
// what makes the value "feel global" while staying physically local per
// microfrontend, replicated purely through messages.
//
// Endowments: bus (publish + subscribe "value:updated"), logger.

logger.info("value-modifier loaded");

let localValue = null; // local replica; null until the first update arrives

// Replicate every update — including the echo of our own set.
bus.subscribe("value:updated", (event) => {
  localValue = event.payload.value;
});

globalThis.getLocal = () => localValue;

// Called by the host when the user clicks "Set". Broadcasts the new value; the
// replica updates when the message is delivered back to us.
globalThis.setValue = function setValue(n) {
  if (!Number.isFinite(n)) return;
  logger.info(`set x = ${n}`);
  bus.publish("value:updated", { name: "x", value: n });
};
