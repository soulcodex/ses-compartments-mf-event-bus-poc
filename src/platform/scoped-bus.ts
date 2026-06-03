import type { PlatformEventBus } from "./event-bus.js";
import type { CompartmentName, CompartmentPolicy } from "./permissions.js";
import type { EventTopic } from "./schemas.js";
import { PermissionDeniedError } from "./errors.js";

export function makeScopedBus(args: {
  compartmentName: CompartmentName;
  policy: CompartmentPolicy;
  platformBus: PlatformEventBus;
}) {
  const { compartmentName, policy, platformBus } = args;

  return harden({
    publish(topic: string, payload: unknown): void {
      if (!policy.canPublish.includes(topic as EventTopic)) {
        throw new PermissionDeniedError(
          `compartment "${compartmentName}" cannot publish "${topic}"`,
        );
      }
      platformBus.publish(compartmentName, topic as EventTopic, payload);
    },

    subscribe(topic: string, handler: (event: unknown) => void): () => void {
      if (!policy.canSubscribe.includes(topic as EventTopic)) {
        throw new PermissionDeniedError(
          `compartment "${compartmentName}" cannot subscribe "${topic}"`,
        );
      }
      return platformBus.subscribe(topic as EventTopic, harden(handler));
    },
  });
}
