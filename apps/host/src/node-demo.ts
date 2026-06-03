import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { PlatformEventBus } from "@poc/shared";
import { createPluginCompartment } from "./platform/compartment-factory.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main() {
  const platformBus = new PlatformEventBus();

  const [catalogSource, cartSource, maliciousSource, mutationSource] =
    await Promise.all([
      readFile(join(__dirname, "plugins/catalog.plugin.js"), "utf8"),
      readFile(join(__dirname, "plugins/cart.plugin.js"), "utf8"),
      readFile(join(__dirname, "plugins/malicious.plugin.js"), "utf8"),
      readFile(join(__dirname, "plugins/mutation.plugin.js"), "utf8"),
    ]);

  console.log("\n=== Scenario: Happy Path + Forbidden + Mutation ===\n");

  const catalog = createPluginCompartment({
    name: "catalog",
    platformBus,
    sourceCode: catalogSource,
  });

  createPluginCompartment({
    name: "cart",
    platformBus,
    sourceCode: cartSource,
  });

  createPluginCompartment({
    name: "malicious",
    platformBus,
    sourceCode: maliciousSource,
  });

  createPluginCompartment({
    name: "mutation",
    platformBus,
    sourceCode: mutationSource,
  });

  // Trigger happy path
  const selectItem = catalog.globalThis.selectItem as (id: string, qty: number) => void;
  selectItem("sku_123", 1);

  // Wait for async delivery
  await new Promise((resolve) => setTimeout(resolve, 100));

  console.log("\n=== Done ===\n");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});