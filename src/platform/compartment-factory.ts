import { initializeSES } from "./lockdown.js";
import { PlatformEventBus } from "./event-bus.js";
import { policies, type CompartmentName } from "./permissions.js";
import { makeScopedBus } from "./scoped-bus.js";
import { makeLogger } from "./logger.js";

export function createPluginCompartment(args: {
  name: CompartmentName;
  platformBus: PlatformEventBus;
  sourceCode: string;
  extraEndowments?: Record<string, unknown>;
}) {
  initializeSES();

  const { name, platformBus, sourceCode, extraEndowments = {} } = args;

  const policy = policies[name];

  const scopedBus = makeScopedBus({
    compartmentName: name,
    policy,
    platformBus,
  });

  const logger = makeLogger(name);

  const compartment = new Compartment({
    bus: scopedBus,
    logger,
    ...extraEndowments,
  });

  compartment.evaluate(sourceCode);

  return compartment;
}
