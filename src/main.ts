import { PlatformEventBus } from "./platform/event-bus.js";
import { createPluginCompartment } from "./platform/compartment-factory.js";
import { addLogSink } from "./platform/logger.js";
import { createLogRenderer } from "./ui/render-log.js";

import catalogSource from "./plugins/catalog.plugin.js?raw";
import cartSource from "./plugins/cart.plugin.js?raw";
import maliciousSource from "./plugins/malicious.plugin.js?raw";
import mutationSource from "./plugins/mutation.plugin.js?raw";

document.addEventListener("DOMContentLoaded", () => {
  const renderer = createLogRenderer("log-panel");

  addLogSink(({ source, message }) => {
    renderer.append(source, message);
  });

  async function runHappyPath() {
    renderer.append("host", "--- Happy Path ---");
    const platformBus = new PlatformEventBus();

    const catalog = createPluginCompartment({ name: "catalog", platformBus, sourceCode: catalogSource });
    createPluginCompartment({ name: "cart", platformBus, sourceCode: cartSource });

    const selectItem = catalog.globalThis.selectItem as (id: string, qty: number) => void;
    selectItem("sku_123", 1);

    await new Promise((r) => setTimeout(r, 100));
  }

  async function runMalicious() {
    renderer.append("host", "--- Malicious Plugin ---");
    const platformBus = new PlatformEventBus();

    createPluginCompartment({ name: "malicious", platformBus, sourceCode: maliciousSource });

    await new Promise((r) => setTimeout(r, 50));
  }

  async function runMutation() {
    renderer.append("host", "--- Mutation Attack ---");
    const platformBus = new PlatformEventBus();

    createPluginCompartment({ name: "catalog", platformBus, sourceCode: catalogSource });
    createPluginCompartment({ name: "mutation", platformBus, sourceCode: mutationSource });

    await new Promise((r) => setTimeout(r, 100));
  }

  document.getElementById("btn-happy")!.addEventListener("click", () => runHappyPath());
  document.getElementById("btn-malicious")!.addEventListener("click", () => runMalicious());
  document.getElementById("btn-mutation")!.addEventListener("click", () => runMutation());
  document.getElementById("btn-clear")!.addEventListener("click", () => renderer.clear());
});
