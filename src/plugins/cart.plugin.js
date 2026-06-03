logger.info("cart plugin loaded");

let cartSize = 0;

bus.subscribe("catalog:item-selected", (event) => {
  logger.info("received catalog:item-selected", JSON.stringify(event.payload));
  cartSize += event.payload.quantity;
  bus.publish("cart:item-added", {
    itemId: event.payload.itemId,
    quantity: event.payload.quantity,
    cartSize,
  });
});
