import "ses";
import { initializeSES } from "./lockdown.js";
import { PlatformEventBus } from "@poc/shared";
import { policies, type CompartmentName } from "@poc/shared";
import { makeScopedBus } from "@poc/shared";
import { makeLogger } from "@poc/shared";

export type MFContainer = {
  init(shareScope: Record<string, unknown>): Promise<void> | void;
  get(module: string): Promise<() => Record<string, unknown>>;
};

export type LoadedRemote = {
  exports: Record<string, unknown>;
  compartment: InstanceType<typeof Compartment>;
  cleanup: () => void;
};

export type CompartmentLoaderOptions = {
  name: CompartmentName;
  platformBus: PlatformEventBus;
  /**
   * The source code of the remote entry bundle as a plain string.
   * In tests this is provided directly.
   * In browser the host fetches it via fetchRemoteSource().
   */
  sourceCode: string;
  /**
   * The MF module path to get from the container.
   * Defaults to "./plugin".
   */
  modulePath?: string;
  /**
   * Name under which the MF container registers itself on globalThis.
   * Defaults to the compartment name.
   */
  containerName?: string;
};

export async function loadRemoteInCompartment(
  options: CompartmentLoaderOptions,
): Promise<LoadedRemote> {
  const {
    name,
    platformBus,
    sourceCode,
    modulePath = "./plugin",
    containerName = `${name}Remote`,
  } = options;

  initializeSES();

  const policy = policies[name];
  const scopedBus = makeScopedBus({ compartmentName: name, policy, platformBus });
  const logger = makeLogger(name);

  // The compartment's globalThis where the MF container will register itself.
  // We provide __mf_container__ as the registration target to avoid collisions.
  const registrationKey = containerName ?? name;

  const compartment = new Compartment({
    bus: scopedBus,
    logger,
    // Provide a __webpack_require__ stub so the MF container bootstrap
    // does not crash when it tries to access the module federation runtime.
    // The stub exposes only what the container needs to register itself.
    __webpack_require__: harden({
      // MF containers call __webpack_require__.federation.runtime or similar;
      // we provide a no-op stub so evaluation does not throw.
    }),
  });

  // Evaluate the remote source inside the compartment.
  // MF containers produced by Rsbuild/Rspack register themselves on globalThis
  // using the container name as the key.
  compartment.evaluate(sourceCode);

  // Extract the container object from the compartment's globalThis.
  const container = compartment.globalThis[registrationKey] as MFContainer | undefined;

  if (!container || typeof container.get !== "function") {
    throw new Error(
      `CompartmentLoader: remote "${name}" did not register a valid MF container ` +
      `under globalThis.${registrationKey}. ` +
      `Make sure the remote's entry bundle exposes a container with .get() and .init().`,
    );
  }

  // Initialize the container with an empty shared scope
  // (we deliberately skip MF shared singleton semantics).
  await container.init({});

  // Get the plugin module factory.
  const factory = await container.get(modulePath);
  const exports = factory();

  const unsubscribers: Array<() => void> = [];

  return {
    exports,
    compartment,
    cleanup() {
      for (const unsub of unsubscribers) unsub();
    },
  };
}

/**
 * Fetch the source text of a remote entry URL.
 * Used in browser — not called in tests (tests inject source directly).
 */
export async function fetchRemoteSource(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`CompartmentLoader: failed to fetch remote at ${url}: ${res.status} ${res.statusText}`);
  }
  return res.text();
}