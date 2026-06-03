declare const bus: {
  publish(topic: string, payload: unknown): void;
  subscribe(topic: string, handler: (event: { payload: Record<string, unknown> }) => void): () => void;
};
declare const logger: {
  info(...args: unknown[]): void;
  error(...args: unknown[]): void;
};

logger.info("cart MF plugin loaded");

let cartSize = 0;
let lastAddedItem: unknown = null;

bus.subscribe("catalog:item-selected", (event) => {
  logger.info("cart received catalog:item-selected", JSON.stringify(event.payload));
  cartSize += event.payload.quantity as number;
  const itemAdded = {
    itemId: event.payload.itemId,
    quantity: event.payload.quantity,
    cartSize,
  };
  bus.publish("cart:item-added", itemAdded);
  lastAddedItem = itemAdded;
});

export function getCartSize(): number {
  return cartSize;
}

export function getLastAddedItem(): unknown {
  return lastAddedItem;
}

