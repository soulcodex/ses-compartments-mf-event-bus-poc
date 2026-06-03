logger.info("mutation plugin loaded");

const payload = { itemId: "sku_123", quantity: 1 };

bus.publish("catalog:item-selected", payload);

payload.itemId = "mutated_after_publish";

logger.info("sender mutated payload to:", payload.itemId);
