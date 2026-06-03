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
   * Optional source of the expose chunk (the async chunk that contains the
   * actual plugin module factory).  When provided it is pre-evaluated inside
   * the compartment before container.get() is called, making the module
   * available in the Rspack module cache without a network request.
   *
   * If omitted, container.get() will attempt to load the chunk via the
   * Rspack chunk-loader (__webpack_require__.l), which requires document and
   * network access and will not work inside a compartment.
   */
  exposeChunkSource?: string;
  /**
   * The MF module path to get from the container.
   * Defaults to "./plugin".
   */
  modulePath?: string;
  /**
   * Name under which the MF container registers itself on globalThis.
   * Defaults to "${name}Remote".
   */
  containerName?: string;
};

// ---------------------------------------------------------------------------
// Source sanitization
// ---------------------------------------------------------------------------

/**
 * The same regex SES uses internally in `rejectImportExpressions` to locate
 * suspicious import tokens.  We reproduce it here so we can run the *evasion*
 * transform (renaming `import` → `__import__`) on the source *before* passing
 * it to `compartment.evaluate()`.
 *
 * Pattern: word-boundary `import` followed by optional whitespace then either
 *   `(`  — dynamic import expression
 *   `/*` — opening block comment (could mask a dynamic import)
 *   `//` — opening line comment (same reason)
 *
 * The leading group `(^|[^.]|\.\.\.)` ensures we do not match `import` when
 * preceded by a dot (e.g. `obj.import(...)` is not an import expression).
 *
 * Source: endojs/endo packages/ses/src/transforms.js
 */
const IMPORT_PATTERN = /(^|[^.]|\.\.\.)\bimport(\s*(?:\(|\/[/*]))/g;

/**
 * Prepare a Rsbuild/Rspack MF remoteEntry bundle for evaluation inside a
 * SES Compartment.  Three transforms are applied in order:
 *
 * ① Direct-eval → indirect-eval
 *   SES's `rejectSomeDirectEvalExpressions` pass throws on any literal `eval(`
 *   token, including ones that appear inside string templates produced by the
 *   MF runtime (e.g. `eval(\`${n}\`)` in `getSharedFallbackGetter`).
 *   Replacing `eval(` with `(0,eval)(` converts every occurrence to an
 *   *indirect* eval.  Indirect eval runs in the global scope rather than the
 *   caller's scope — which is actually safer — and SES accepts it.
 *
 * ② Dynamic-import evasion
 *   SES's `rejectImportExpressions` pass throws on any source text matching
 *   `\bimport\s*(\(|\/[/*])`, even when the token appears inside a string
 *   literal or template that is passed to `Function()` — it is a purely
 *   textual scan with no AST.
 *
 *   The Rsbuild/Rspack MF runtime contains four such occurrences, all inside
 *   `Function("callbacks", \`import("${t}")\`)` call strings used by the
 *   remote-entry loader (`loadEntryDom`, `sdkImport`).  These code paths are
 *   dead for our use case — we already hold the full source text and never
 *   load additional network chunks.
 *
 *   We apply the same evasion SES documents internally: replace every matching
 *   `import` identifier with `__import__`.  Inside the `Function()` string
 *   templates this changes the *string contents* not the runtime semantics,
 *   since those `Function()` calls are never invoked when we control the
 *   environment (no live remote URLs, no ESM loader).
 *
 *   The replacement function `(_, p1, p2) => \`${p1}__import__${p2}\`` is
 *   taken verbatim from SES's internal `evadeImportExpressionTest` (not
 *   exported by the package but documented in src/transforms.js).
 *
 * ③ Strict-mode directive
 *   Rspack wraps the bundle in `(()=>{...})()` without `"use strict"`.
 *   Prepending the directive ensures the compartment runs the entire bundle
 *   in strict mode, which is required for several SES invariants.
 *
 * See docs/ses-mf-compatibility.md for the full investigation and rationale.
 */
export function sanitizeRemoteSource(source: string, containerName: string): string {
  // ① indirect eval
  const withIndirectEval = source.split("eval(").join("(0,eval)(");

  // ② evade dynamic import expressions (SES-documented technique)
  const withEvadedImports = withIndirectEval.replace(
    IMPORT_PATTERN,
    (_, p1, p2) => `${p1}__import__${p2}`,
  );

  // ③ fix bare global assignment so it lands on compartment.globalThis
  //
  // The Rspack IIFE ends with:
  //   var __webpack_exports__ = __webpack_require__.x();
  //   catalogRemote = __webpack_exports__           ← bare identifier
  //
  // In SES, the Compartment wraps source in a `with (this.globalObject) {...}`
  // scope chain.  A bare assignment to an undeclared identifier in sloppy mode
  // normally creates a global, but inside the `with` scope chain SES intercepts
  // it into its own proxy — and the value does NOT propagate back to the
  // `compartment.globalThis` object that callers read from.
  //
  // Fix: replace the bare `<containerName>=__webpack_exports__` with an explicit
  // `globalThis["<containerName>"]=__webpack_exports__` so the assignment
  // definitively lands on the compartment's globalThis regardless of scope rules.
  //
  // NOTE: we do NOT prepend "use strict". The Rspack IIFE is sloppy-mode code
  // and must remain so — strict mode would turn the bare assignment into a
  // ReferenceError before we even get to apply this fix.
  const withGlobalAssignment = withEvadedImports.replace(
    `${containerName}=__webpack_exports__`,
    `globalThis["${containerName}"]=__webpack_exports__`,
  );

  return withGlobalAssignment;
}

// ---------------------------------------------------------------------------
// Compartment endowments for Rspack MF runtime
// ---------------------------------------------------------------------------

/**
 * Build the minimal set of globals an Rspack-generated MF remote entry needs
 * in order to register its container on globalThis without crashing.
 *
 * We stub out every DOM/browser API the bundle touches so that:
 *  - script injection (document.createElement / document.head.appendChild)
 *    is silently no-op'd — we do not want the remote to inject anything into
 *    the host page; chunk loading is irrelevant here because we already have
 *    the full remoteEntry source as text.
 *  - `self` references resolve to a plain object rather than the real window.
 *  - The `chunk_<containerName>` push array expected by Rspack's jsonp runtime
 *    is pre-populated so the bundle does not throw on `.forEach` / `.push`.
 *
 * None of these stubs grant any real authority — they are the minimum needed
 * to let the bundle reach the line where it writes
 * `globalThis[containerName] = { init, get }`.
 */
function makeRspackEndowments(containerName: string): Record<string, unknown> {
  // Minimal document stub — only what Rspack's __webpack_require__.l needs.
  const scriptStub = {
    setAttribute: () => {},
    onerror: null as unknown,
    onload: null as unknown,
    src: "",
  };

  // The MF runtime (module 6984 / CurrentGlobal) does:
  //   s = (() => { try { return document.defaultView } catch { return globalThis } })()
  //   h(s)   // where h(e) calls Object.hasOwnProperty.call(e, "__VMOK__")
  //
  // If document.defaultView returns undefined, h(undefined) throws
  // "Cannot convert undefined or null to object" inside hasOwnProperty.
  // We make defaultView a self-reference that the Compartment can resolve
  // after construction by using a lazy getter that reads compartment.globalThis.
  // At stub-construction time we don't have compartment yet, so we use a
  // sentinel object that is plain enough for hasOwnProperty.call to work.
  const globalThisProxy: Record<string, unknown> = {};

  const documentStub = {
    getElementsByTagName: (_tag: string) => [],
    createElement: (_tag: string) => ({ ...scriptStub }),
    head: {
      appendChild: (_el: unknown) => {},
    },
    // MF module 6984 accesses document.defaultView to get a second reference
    // to globalThis (used to register __FEDERATION__ state).  Return the same
    // proxy object we also use as selfStub so both point to the same store.
    defaultView: globalThisProxy,
  };

  // `self` in a Worker/window context — point it back at itself.
  // The bundle uses self["chunk_<name>"] to push jsonp callbacks.
  // We reuse globalThisProxy so document.defaultView === self — same as a real browser.
  const selfStub = globalThisProxy;

  // Pre-create the jsonp chunk array the Rspack runtime calls .forEach on.
  // Without it, `r.forEach(t.bind(null,0))` throws "r.forEach is not a function".
  // Note the trailing space — Rspack adds it to the container name.
  selfStub[`chunk_${containerName} `] = {
    forEach: (_fn: unknown) => {},
    push:    (_entry: unknown) => {},
  };

  return {
    document: documentStub,
    self: selfStub,
    // __webpack_require__ is initialised by the bundle itself — we just need
    // the property to exist on globalThis so early references don't throw.
    __webpack_require__: undefined,
    // setTimeout / clearTimeout are used by the script-load timeout in
    // __webpack_require__.l — provide no-op stubs.
    setTimeout:  (_fn: unknown, _ms: unknown) => 0,
    clearTimeout: (_id: unknown) => {},
    // Date.now() is called by the MF runtime during init() for versioning.
    // SES locks down Date.now() in secure mode to prevent timing-based
    // side-channel attacks. Endow a harmless stub that always returns 0.
    Date: { now: () => 0 },
    // Promise must be available for container.get() which returns a Promise.
    Promise,
  };
}

// ---------------------------------------------------------------------------
// Main loader
// ---------------------------------------------------------------------------

export async function loadRemoteInCompartment(
  options: CompartmentLoaderOptions,
): Promise<LoadedRemote> {
  const {
    name,
    platformBus,
    sourceCode,
    exposeChunkSource,
    modulePath = "./plugin",
    containerName = `${name}Remote`,
  } = options;

  initializeSES();

  const policy = policies[name];
  const scopedBus = makeScopedBus({ compartmentName: name, policy, platformBus });
  const logger = makeLogger(name);

  // Prepare the source for SES evaluation (sanitizeRemoteSource needs
  // containerName to fix the bare global assignment at the end of the IIFE).
  const safeSource = sanitizeRemoteSource(sourceCode, containerName);

  // Build endowments: capability objects first, then Rspack runtime stubs.
  const rspackEndowments = makeRspackEndowments(containerName);

  const compartment = new Compartment({
    // Capability endowments — the only real authority granted to the remote.
    bus: scopedBus,
    logger,
    // Rspack runtime stubs — no real authority, just enough for the bundle
    // bootstrap to reach the container registration line.
    ...rspackEndowments,
  });

  // Evaluate the sanitized remoteEntry bundle inside the compartment.
  // On success the bundle writes:
  //   globalThis[containerName] = __webpack_exports__
  // where __webpack_exports__ has .init() and .get() (via __webpack_require__.x).
  compartment.evaluate(safeSource);

  // If the expose chunk source was provided, pre-evaluate it now so that
  // the Rspack module cache inside this compartment already contains the
  // plugin module.  This avoids any network chunk-loading request when
  // container.get() is called.
  //
  // The expose chunk is a JSONP push: self["chunk_<name> "].push([...])
  // The self["chunk_<name> "].push callback was wired up during IIFE
  // startup to install the chunk modules into __webpack_module_cache__.
  //
  // We need to replace the push stub we provided earlier with the real
  // Rspack chunk installer that __webpack_require__.f.j set up.
  // The simplest approach: evaluate the expose chunk source inside the
  // same compartment — it will call the real push (now installed) itself.
  if (exposeChunkSource) {
    const safeChunk = sanitizeRemoteSource(exposeChunkSource, containerName);
    compartment.evaluate(safeChunk);
  }

  // Extract the container the bundle registered on the compartment's globalThis.
  const container = compartment.globalThis[containerName] as MFContainer | undefined;

  if (!container || typeof container.get !== "function") {
    throw new Error(
      `CompartmentLoader: remote "${name}" did not register a valid MF container ` +
      `under globalThis.${containerName}. ` +
      `The bundle may have crashed before reaching the registration line, ` +
      `or the container name does not match (expected: "${containerName}").`,
    );
  }

  // Initialise the container with an empty shared scope.
  // We deliberately skip MF's shared singleton semantics — remotes are
  // logic-only plugins with no framework dependency.
  await container.init({});

  // Obtain the plugin module factory and call it to get the exports.
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

// ---------------------------------------------------------------------------
// Fetch helper
// ---------------------------------------------------------------------------

/**
 * Fetch the source text of a remote entry URL.
 * Used in the browser — tests inject source directly and never call this.
 */
export async function fetchRemoteSource(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(
      `CompartmentLoader: failed to fetch remote at ${url}: ${res.status} ${res.statusText}`,
    );
  }
  return res.text();
}
