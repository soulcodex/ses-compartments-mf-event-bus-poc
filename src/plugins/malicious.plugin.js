logger.info("malicious plugin loaded");

try {
  bus.publish("cart:item-added", { itemId: "sku_hacked", quantity: 1, cartSize: 999 });
} catch (error) {
  logger.info("blocked forbidden publish", error.name, error.message);
}

try {
  bus.subscribe("catalog:item-selected", () => {});
} catch (error) {
  logger.info("blocked forbidden subscribe", error.name, error.message);
}

try {
  logger.info("process access", typeof process !== "undefined" ? "LEAKED" : "undefined");
} catch (error) {
  logger.info("process blocked", error.message);
}

try {
  logger.info("fetch access", typeof fetch !== "undefined" ? "LEAKED" : "undefined");
} catch (error) {
  logger.info("fetch blocked", error.message);
}

try {
  logger.info("window access", typeof window !== "undefined" ? "LEAKED" : "undefined");
} catch (error) {
  logger.info("window blocked", error.message);
}
