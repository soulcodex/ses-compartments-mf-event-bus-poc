declare global {
  function lockdown(options?: Record<string, unknown>): void;
  function harden<T>(value: T): T;

  class Compartment {
    constructor(
      endowments?: Record<string, unknown>,
      modules?: Record<string, unknown>,
      options?: Record<string, unknown>,
    );

    evaluate(source: string): unknown;

    globalThis: Record<string, unknown>;
  }
}

export {};
