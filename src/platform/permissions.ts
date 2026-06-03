import type { EventTopic } from "./schemas.js";

export type CompartmentName = "catalog" | "cart" | "malicious" | "mutation";

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
};
