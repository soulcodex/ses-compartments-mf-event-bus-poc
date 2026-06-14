// value-reader.plugin.js
//
// A consulter. It keeps a local replica of the shared variable but may never
// set it. Its policy grants subscribe only; the defensive publish below proves
// the write path is closed to it.

logger.info("value-reader loaded");

let localValue = null;
bus.subscribe("value:updated", (event) => {
  localValue = event.payload.value;
});

globalThis.getLocal = () => localValue;

// Proof that it cannot write: any publish attempt is denied.
try {
  bus.publish("value:updated", { name: "x", value: -1 });
  globalThis.couldPublish = true;
} catch (error) {
  globalThis.couldPublish = false;
  logger.info("reader correctly blocked from publishing", error.name);
}
