import { eventSchemas, type EventTopic } from "./schemas.js";
import { sanitizePayload } from "./sanitize.js";
import { hostLogger } from "./logger.js";

export type EventEnvelope<T = unknown> = {
  id: string;
  topic: EventTopic;
  source: string;
  timestamp: number;
  payload: T;
};

type Handler = (event: EventEnvelope) => void;

export class PlatformEventBus {
  private subscribers = new Map<EventTopic, Handler[]>();

  subscribe(topic: EventTopic, handler: Handler): () => void {
    const handlers = this.subscribers.get(topic) ?? [];
    handlers.push(handler);
    this.subscribers.set(topic, handlers);

    return () => {
      const current = this.subscribers.get(topic) ?? [];
      this.subscribers.set(
        topic,
        current.filter((h) => h !== handler),
      );
    };
  }

  publish(source: string, topic: EventTopic, payload: unknown): void {
    const schema = eventSchemas[topic];

    if (!schema) {
      throw new Error(`Unknown event topic: ${topic}`);
    }

    const parsedPayload = schema.parse(payload);
    const safePayload = sanitizePayload(parsedPayload);

    const envelope: EventEnvelope = harden({
      id: crypto.randomUUID(),
      topic,
      source,
      timestamp: Date.now(),
      payload: safePayload,
    });

    hostLogger.info(`${source} published ${topic}`);

    const handlers = [...(this.subscribers.get(topic) ?? [])];

    queueMicrotask(() => {
      for (const handler of handlers) {
        try {
          hostLogger.info(`delivering ${topic} to subscriber`);
          handler(envelope);
        } catch (error) {
          hostLogger.error(`handler failed: ${String(error)}`);
        }
      }
    });
  }
}
