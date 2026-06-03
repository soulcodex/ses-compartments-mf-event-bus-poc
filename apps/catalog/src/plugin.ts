// This module is exposed as an MF remote entry.
// When loaded via CompartmentLoader, it runs inside a SES Compartment
// where `bus` and `logger` are available as globals (endowments).
// We declare them to satisfy TypeScript — they are injected at runtime.
declare const bus: {
  publish(topic: string, payload: unknown): void;
  subscribe(topic: string, handler: (event: { payload: unknown }) => void): () => void;
};
declare const logger: {
  info(...args: unknown[]): void;
  error(...args: unknown[]): void;
};

logger.info("catalog MF plugin loaded");

let lastConfirmation: unknown = null;

bus.subscribe("cart:item-added", (event) => {
  logger.info("catalog received cart:item-added", JSON.stringify(event.payload));
  lastConfirmation = event.payload;
});

export function selectItem(itemId: string, quantity: number): void {
  bus.publish("catalog:item-selected", { itemId, quantity });
}

export function getLastConfirmation(): unknown {
  return lastConfirmation;
}

