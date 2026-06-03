import { describe, it, expect } from "vitest";
import { sanitizePayload } from "../src/platform/sanitize.js";
import { initializeSES } from "../src/platform/lockdown.js";

initializeSES();

describe("sanitize", () => {
  it("returns a clone, not the original reference", () => {
    const original = { itemId: "sku_1", quantity: 1 };
    const result = sanitizePayload(original);
    expect(result).not.toBe(original);
    expect(result).toEqual(original);
  });

  it("mutation after sanitize does not affect the result", () => {
    const original = { itemId: "sku_1", quantity: 1 };
    const result = sanitizePayload(original);
    original.itemId = "mutated";
    expect(result.itemId).toBe("sku_1");
  });

  it("hardened payload throws on mutation attempt", () => {
    const result = sanitizePayload({ itemId: "sku_1", quantity: 1 });
    expect(() => {
      (result as Record<string, unknown>).itemId = "mutated";
    }).toThrow();
  });
});
