import "ses";
import { eventSchemas, type EventTopic } from "./schemas.js";
import { sanitizePayload } from "./sanitize.js";
import { hostLogger } from "./logger.js";

export type EventEnvelope<T = unknown> = {
  id: string;
  topic: EventTopic;
  source: string;
  /**
   * The host-assigned realm id of the publisher, stamped by the host (via the
   * scoped bus) — the publisher cannot choose or forge it. Realm attestation
   * compares a sender's true id against its certificate. Falls back to `source`
   * for messages published directly by the host.
   */
  realmId: string;
  timestamp: number;
  payload: T;
};

type Handler = (event: EventEnvelope) => void;
type Subscription = { handler: Handler; realmId: string };

export class PlatformEventBus {
  private subscribers = new Map<EventTopic, Subscription[]>();

  /**
   * Subscribe to a topic. `realmId` lets the host route *directed* messages: a
   * publisher can restrict delivery to a set of realm-ids, and the host only
   * invokes subscriptions whose realmId is in that set. Defaults to "host".
   */
  subscribe(topic: EventTopic, handler: Handler, realmId: string = "host"): () => void {
    const subs = this.subscribers.get(topic) ?? [];
    const sub: Subscription = { handler, realmId };
    subs.push(sub);
    this.subscribers.set(topic, subs);

    return () => {
      const current = this.subscribers.get(topic) ?? [];
      this.subscribers.set(
        topic,
        current.filter((s) => s !== sub),
      );
    };
  }

  /**
   * Remove every subscription registered by a realm — used when a realm is torn
   * down (e.g. a rolling redeploy), so its handlers stop receiving messages.
   */
  unsubscribeRealm(realmId: string): void {
    for (const [topic, subs] of this.subscribers) {
      this.subscribers.set(
        topic,
        subs.filter((s) => s.realmId !== realmId),
      );
    }
  }

  /**
   * Publish a message. When `recipients` is provided, the host delivers ONLY to
   * subscriptions whose realmId is in that set (directed delivery) — an
   * unattested realm is in nobody's recipient set, so it never receives the
   * bytes. When omitted, the message is broadcast to every subscriber.
   */
  publish(
    source: string,
    topic: EventTopic,
    payload: unknown,
    realmId?: string,
    recipients?: readonly string[],
  ): void {
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
      // The host stamps the publisher's assigned realm id; defaults to `source`
      // when the host itself publishes (no separate realm id).
      realmId: realmId ?? source,
      timestamp: Date.now(),
      payload: safePayload,
    });

    hostLogger.info(`${source} published ${topic}`);

    const subs = [...(this.subscribers.get(topic) ?? [])];

    queueMicrotask(() => {
      for (const sub of subs) {
        // Directed delivery: skip subscribers not in the recipient set.
        if (recipients && !recipients.includes(sub.realmId)) continue;
        try {
          hostLogger.info(`delivering ${topic} to subscriber`);
          sub.handler(envelope);
        } catch (error) {
          hostLogger.error(`handler failed: ${String(error)}`);
        }
      }
    });
  }
}