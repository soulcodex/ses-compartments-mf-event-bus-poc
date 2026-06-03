logger.info("catalog plugin loaded");

bus.subscribe("cart:item-added", (event) => {
  logger.info("received cart:item-added", JSON.stringify(event.payload));
});

globalThis.selectItem = function selectItem(itemId, quantity) {
  bus.publish("catalog:item-selected", { itemId, quantity });
};