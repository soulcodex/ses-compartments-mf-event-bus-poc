import { initializeSES } from "./lockdown.js";
import { PlatformEventBus } from "@poc/shared";
import { policies, type CompartmentName } from "@poc/shared";
import { makeScopedBus } from "@poc/shared";
import { makeLogger } from "@poc/shared";

export function createPluginCompartment(args: {
  name: CompartmentName;
  platformBus: PlatformEventBus;
  sourceCode: string;
  extraEndowments?: Record<string, unknown>;
}) {
  initializeSES();
  const { name, platformBus, sourceCode, extraEndowments = {} } = args;
  const policy = policies[name];
  const scopedBus = makeScopedBus({ compartmentName: name, policy, platformBus });
  const logger = makeLogger(name);
  const compartment = new Compartment({ bus: scopedBus, logger, ...extraEndowments });
  compartment.evaluate(sourceCode);
  return compartment;
}