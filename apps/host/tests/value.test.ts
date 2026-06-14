import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { createPluginCompartment } from "../src/platform/compartment-factory.js";
import { PlatformEventBus } from "@poc/shared";

// Load the real plugin sources (the same files the browser demo evaluates).
const read = (file: string) =>
  readFileSync(new URL(`../src/plugins/${file}`, import.meta.url), "utf8");

const valueModifierSource = read("value-modifier.plugin.js");
const valueReaderSource = read("value-reader.plugin.js");
const maliciousValueModifierSource = read("malicious-value-modifier.plugin.js");
const maliciousValueReaderSource = read("malicious-value-reader.plugin.js");

const tick = () => new Promise((r) => setTimeout(r, 10));

type LocalApi = { getLocal(): number | null };

describe("shared variable — integrity is gated, confidentiality is not", () => {
  it("a set on one modifier is replicated to another modifier and a reader", async () => {
    const platformBus = new PlatformEventBus();

    const modA = createPluginCompartment({
      name: "value-modifier",
      platformBus,
      sourceCode: valueModifierSource,
    });
    const modB = createPluginCompartment({
      name: "value-modifier",
      platformBus,
      sourceCode: valueModifierSource,
    });
    const reader = createPluginCompartment({
      name: "value-reader",
      platformBus,
      sourceCode: valueReaderSource,
    });

    (modA.globalThis.setValue as (n: number) => void)(42);
    await tick();

    // Every local replica — including the setter's own — converges via messages.
    expect((modA.globalThis as unknown as LocalApi).getLocal()).toBe(42);
    expect((modB.globalThis as unknown as LocalApi).getLocal()).toBe(42);
    expect((reader.globalThis as unknown as LocalApi).getLocal()).toBe(42);
  });

  it("the reader cannot set the value (subscribe-only policy)", async () => {
    const platformBus = new PlatformEventBus();
    const reader = createPluginCompartment({
      name: "value-reader",
      platformBus,
      sourceCode: valueReaderSource,
    });
    await tick();
    expect(reader.globalThis.couldPublish).toBe(false);
  });

  it("a malicious modifier is blocked from forging/broadcasting a value", async () => {
    const platformBus = new PlatformEventBus();

    const reader = createPluginCompartment({
      name: "value-reader",
      platformBus,
      sourceCode: valueReaderSource,
    });
    const malModifier = createPluginCompartment({
      name: "malicious-value-modifier",
      platformBus,
      sourceCode: maliciousValueModifierSource,
    });
    await tick();

    const attempts = malModifier.globalThis.attempts as {
      label: string;
      blocked: boolean;
      error?: string;
    }[];
    const publishAttempt = attempts.find((a) => a.label === "publish value:updated");
    expect(publishAttempt?.blocked).toBe(true);
    expect(publishAttempt?.error).toBe("PermissionDeniedError");

    // The forged value never reaches a legitimate subscriber.
    expect((reader.globalThis as unknown as LocalApi).getLocal()).toBeNull();
  });

  it("a malicious reader with NO bus rights still sniffs the value via the leaked capability", async () => {
    const platformBus = new PlatformEventBus();

    // Host mirror fed from the gated bus (mirrors main.ts runValueDemo).
    const board = new Map<string, number>();
    platformBus.subscribe("value:updated", (event) => {
      const p = event.payload as { name: string; value: number };
      board.set(p.name, p.value);
    });
    const getSharedValues = () => harden({ ...Object.fromEntries(board) });

    const modifier = createPluginCompartment({
      name: "value-modifier",
      platformBus,
      sourceCode: valueModifierSource,
    });
    (modifier.globalThis.setValue as (n: number) => void)(7);
    await tick();

    const malReader = createPluginCompartment({
      name: "malicious-value-reader",
      platformBus,
      sourceCode: maliciousValueReaderSource,
      extraEndowments: { getSharedValues },
    });
    await tick();

    // The bus correctly denied it the legitimate channel...
    expect(malReader.globalThis.couldSubscribe).toBe(false);

    // ...yet the leaked read capability hands it the value anyway.
    const sniffed = (malReader.globalThis.poll as () => Record<string, number>)();
    expect(sniffed.x).toBe(7);

    // The leak is read-only: the snapshot is frozen, granting no write power.
    expect(Object.isFrozen(sniffed)).toBe(true);
  });
});
