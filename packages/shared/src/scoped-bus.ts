import "ses";
import type { PlatformEventBus } from "./event-bus.js";
import type { CompartmentName, CompartmentPolicy } from "./permissions.js";
import type { EventTopic } from "./schemas.js";
import { PermissionDeniedError } from "./errors.js";

export function makeScopedBus(args: {
  compartmentName: CompartmentName;
  policy: CompartmentPolicy;
  platformBus: PlatformEventBus;
  /**
   * The host-assigned realm id for this compartment. The host stamps it on
   * every message the realm publishes, so a verifier reads the sender's true id
   * from a value the sender cannot forge. Defaults to the compartment name.
   */
  realmId?: string;
}) {
  const { compartmentName, policy, platformBus, realmId } = args;

  return harden({
    /**
     * Publish a message. `recipients` (a set of realm-ids) restricts delivery to
     * those realms — used to send a value only to attested peers. Omit it to
     * broadcast.
     */
    publish(topic: string, payload: unknown, recipients?: readonly string[]): void {
      if (!policy.canPublish.includes(topic as EventTopic)) {
        throw new PermissionDeniedError(
          `compartment "${compartmentName}" cannot publish "${topic}"`,
        );
      }
      platformBus.publish(compartmentName, topic as EventTopic, payload, realmId, recipients);
    },

    subscribe(topic: string, handler: (event: unknown) => void): () => void {
      if (!policy.canSubscribe.includes(topic as EventTopic)) {
        throw new PermissionDeniedError(
          `compartment "${compartmentName}" cannot subscribe "${topic}"`,
        );
      }
      // Register our realm-id so the host can route directed messages to us.
      return platformBus.subscribe(topic as EventTopic, harden(handler), realmId);
    },
  });
}