import { z } from "zod";

export const eventSchemas = {
  "catalog:item-selected": z.object({
    itemId: z.string(),
    quantity: z.number().int().positive(),
  }),

  "cart:item-added": z.object({
    itemId: z.string(),
    quantity: z.number().int().positive(),
    cartSize: z.number().int().nonnegative(),
  }),

  // A replicated shared variable. A value-modifier broadcasts this whenever it
  // sets the variable; every microfrontend keeps its own local replica and
  // updates it from these messages. It "feels like" a global variable but is
  // physically local per compartment and kept in sync only by the bus.
  "value:updated": z.object({
    name: z.string(),
    value: z.number().finite(),
  }),

  // Realm attestation handshake. A realm broadcasts this once with the
  // certificate its origin issued; peers verify it before exchanging data.
  "attest:hello": z.object({
    cert: z.string(),
  }),

  // A freshly (re)deployed realm asks peers for the current counter value so it
  // can recover state after a rolling redeploy. Peers reply with value:updated.
  "value:sync-request": z.object({}),
} as const;

export type EventTopic = keyof typeof eventSchemas;