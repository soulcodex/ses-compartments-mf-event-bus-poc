import type { EventTopic } from "./schemas.js";

export type CompartmentName =
  | "catalog"
  | "cart"
  | "malicious"
  | "mutation"
  | "value-modifier"
  | "value-reader"
  | "malicious-value-modifier"
  | "malicious-value-reader"
  | "catalog-realm"
  | "cart-realm"
  | "malicious-realm";

export type CompartmentPolicy = {
  canPublish: EventTopic[];
  canSubscribe: EventTopic[];
};

export const policies: Record<CompartmentName, CompartmentPolicy> = {
  catalog: {
    canPublish: ["catalog:item-selected"],
    canSubscribe: ["cart:item-added"],
  },

  cart: {
    canPublish: ["cart:item-added"],
    canSubscribe: ["catalog:item-selected"],
  },

  malicious: {
    canPublish: [],
    canSubscribe: [],
  },

  mutation: {
    canPublish: ["catalog:item-selected"],
    canSubscribe: [],
  },

  // May set the shared variable (publish) AND replicate everyone else's
  // updates (subscribe).
  "value-modifier": {
    canPublish: ["value:updated"],
    canSubscribe: ["value:updated"],
  },

  // Consulter: may read/replicate the broadcast value but never set it.
  "value-reader": {
    canPublish: [],
    canSubscribe: ["value:updated"],
  },

  // Wants to forge/broadcast a value. The bus is the only write path and it is
  // gated, so every publish attempt is denied — integrity is preserved.
  "malicious-value-modifier": {
    canPublish: [],
    canSubscribe: [],
  },

  // Has NO bus rights at all. It still sniffs the shared value — not through the
  // bus, but through an over-broadly endowed read capability (getSharedValues).
  // The bus protects integrity, but a leaked read capability defeats
  // confidentiality. The policy below is what the bus enforces; the leak lives
  // in the endowments, outside the bus.
  "malicious-value-reader": {
    canPublish: [],
    canSubscribe: [],
  },

  // Attestation demo realms (loaded as MF remotes). They exchange the shared
  // counter and broadcast their attestation handshake.
  "catalog-realm": {
    canPublish: ["value:updated", "attest:hello"],
    canSubscribe: ["value:updated", "attest:hello"],
  },

  "cart-realm": {
    canPublish: ["value:updated", "attest:hello"],
    canSubscribe: ["value:updated", "attest:hello"],
  },

  // It is granted full bus rights on purpose — to show attestation, not bus
  // policy, is what excludes it. It *subscribes* to value:updated, but with
  // directed delivery no legit realm ever addresses it (it has no valid cert,
  // so nobody attests it), so the host never delivers it the value — it cannot
  // sniff. Its injected writes are likewise rejected: its replayed certificate
  // fails the realm-id check. With attestation off, both attacks succeed
  // (broadcast delivery + ungated receive) — the baseline that motivates it.
  "malicious-realm": {
    canPublish: ["value:updated", "attest:hello"],
    canSubscribe: ["value:updated", "attest:hello"],
  },
};