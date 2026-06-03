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
} as const;

export type EventTopic = keyof typeof eventSchemas;
