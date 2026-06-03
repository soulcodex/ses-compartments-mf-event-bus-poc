# SES + Module Federation Compatibility: Investigation Notes

This document records every incompatibility we encountered when trying to
evaluate a Rsbuild/Rspack Module Federation `remoteEntry.js` bundle inside a
SES `Compartment`, the root cause of each, and the fix we applied.

It is intended as a living reference for anyone working at the intersection of
SES (Secure ECMAScript) and Module Federation.

---

## Table of Contents

- [Background](#background)
- [Issue 1 — `rejectSomeDirectEvalExpressions`](#issue-1--rejectsomediirectevalexpressions)
- [Issue 2 — `rejectImportExpressions`](#issue-2--rejectimportexpressions)
- [Issue 3 — Missing Rspack runtime globals](#issue-3--missing-rspack-runtime-globals)
- [Issue 4 — `document.defaultView` returns `undefined`](#issue-4--documentdefaultview-returns-undefined)
- [Issue 5 — `Date.now()` locked in secure mode](#issue-5--datenow-locked-in-secure-mode)
- [Issue 6 — Bare global assignment swallowed by SES scope chain](#issue-6--bare-global-assignment-swallowed-by-ses-scope-chain)
- [Issue 7 — Dev server bundles contain devtools (`isomorphic-ws`)](#issue-7--dev-server-bundles-contain-devtools-isomorphic-ws)
- [Summary of transforms applied](#summary-of-transforms-applied)
- [What we deliberately do NOT fix](#what-we-deliberately-do-not-fix)
- [SES internals reference](#ses-internals-reference)
- [Module Federation internals reference](#module-federation-internals-reference)

---

## Background

SES's `Compartment.evaluate(sourceText)` does not evaluate source code
directly. It first runs the source through a pipeline of *static transforms*
that scan the text for patterns SES considers unsafe, rejecting the whole
string if any are found. This is intentional: SES cannot parse arbitrary JS
without a full parser, so it uses conservative textual heuristics.

A Rsbuild/Rspack-generated `remoteEntry.js` is a self-contained IIFE that
bootstraps the Rspack module system and registers an MF container object on
`globalThis`. As of `@module-federation/rsbuild-plugin@2.5.0` this bundle
contains several patterns that trigger SES rejections.

The investigation was done against:

- `ses@1.15.0`
- `@module-federation/rsbuild-plugin@2.5.0`
- `@rsbuild/core@2.0.11`
- Production build output (not dev/eval source maps)

---

## Issue 1 — `rejectSomeDirectEvalExpressions`

### Error

```
SyntaxError: Possible direct eval expression rejected at <unknown>:N.
(SES_DIRECT_EVAL)
```

### Root cause

SES's `rejectSomeDirectEvalExpressions` transform scans the source text for
the literal token sequence `eval(` using this regex:

```js
/(^|[^.])(\beval)(\s*\()/g
```

It matches regardless of context — inside string literals, template literals,
or comments. Any match causes an immediate rejection.

The production `remoteEntry.js` contains one `eval(` call inside the MF
runtime's `getSharedFallbackGetter` function:

```js
// From @module-federation/runtime-tools (bundled into remoteEntry.js)
// Module 2829: getSharedFallbackGetter
Function("callbacks", `import("${t}")${l}`)([e, n])
// ... and later in the same function body:
eval(`${n}`)   // ← triggers SES_DIRECT_EVAL
```

### Why it's inside a string template in the output

The source is compiled and minified. What appears as `eval(` in the bundle is
the result of Rspack inlining a helper from `@module-federation/runtime-tools`.
The intent is runtime code generation — `eval` is used to construct a small
function from a template string. This is dead code for our use case (we never
load additional shared dependency chunks) but SES cannot know that.

### Fix

Replace every `eval(` with `(0,eval)(` before passing the source to
`compartment.evaluate()`:

```ts
const withIndirectEval = source.split("eval(").join("(0,eval)(");
```

`(0,eval)(...)` is an *indirect eval* — it runs in the global scope rather
than the caller's lexical scope. It loses the dangerous dynamic-scoping
semantics that motivate SES's rejection. SES accepts indirect eval because it
cannot be used to escape a Compartment's scope.

**Why `split/join` instead of a regex?**  
`evalSomething(` must not be matched. The literal string `"eval("` never
appears as a suffix of a longer identifier, so the split/join is unambiguous
and avoids regex escaping complexity.

---

## Issue 2 — `rejectImportExpressions`

### Error

```
SyntaxError: Possible import expression rejected at <unknown>:2862.
(SES_IMPORT_REJECTED)
```

### Root cause

SES's `rejectImportExpressions` transform uses this regex:

```js
/(^|[^.]|\.\.\.)\bimport(\s*(?:\(|\/[/*]))/g
```

It matches the word `import` followed by whitespace then `(`, `/*`, or `//`.
Like the eval transform, it is purely textual — it rejects matches inside
string literals and template literals too.

The production `remoteEntry.js` contains **four** occurrences of `import(`,
all inside `Function()` string template arguments in the MF runtime:

| Location | Code pattern | Purpose |
|---|---|---|
| `loadEntryDom` (×2) | `Function("callbacks", \`import("${t}")${l}\`)` | Load a remote entry via ESM `import()` when `FEDERATION_ALLOW_NEW_FUNCTION` is set |
| `loadEntryNodeVm` | `Function("callbacks", \`System.import("${t}")${l}\`)` | SystemJS variant |
| `sdkImport` | `Function("name","return import(name)")(e)` | Internal MF SDK module importer |

All four are guarded by `FEDERATION_ALLOW_NEW_FUNCTION` or are in paths that
require a live network entry URL. They are **dead code** for our use case — we
already have the full source text of the remote and never load additional
network chunks.

### Why SES rejects these

SES intentionally cannot distinguish `import(` inside a string from `import(`
in real code. The rejection is conservative by design:

> *"The proposed dynamic import expression is the only syntax currently
> proposed, that can appear in non-module JavaScript code, that enables direct
> access to the outside world that cannot be suppressed or intercepted without
> parsing and rewriting."*
>
> — SES source, `packages/ses/src/transforms.js`

The rejection is the correct default. If `import()` were allowed through, a
compartment could escape isolation by importing an arbitrary ESM module from
the network.

### Fix

Apply the evasion transform documented in SES's own source as
`evadeImportExpressionTest` (internal to `ses`, not exported):

```ts
// Regex is the same importPattern SES uses internally:
const IMPORT_PATTERN = /(^|[^.]|\.\.\.)\bimport(\s*(?:\(|\/[/*]))/g;

// Replacement function taken verbatim from SES src/transforms.js:
source.replace(IMPORT_PATTERN, (_, p1, p2) => `${p1}__import__${p2}`);
```

This renames every suspicious `import` token to `__import__`. Inside the
`Function()` string template arguments this changes the *string content* — the
`Function()` would produce `__import__("url")` instead of `import("url")`.
Since these `Function()` calls are never invoked in our environment (no live
remote URLs, no ESM loader), the semantic change is irrelevant.

### Why we re-implement instead of calling SES's function

`evadeImportExpressionTest` is a **private internal function** of the `ses`
package. It does not appear in any export map (`ses/tools.js`, `ses/index.js`,
`ses/dist/ses.cjs`, or `ses/dist/ses.mjs`). Importing it would require
reaching into the package's internals by path, which is fragile. The
implementation is four lines and fully documented — we own it.

### Why not use `Function()` replacement instead

An alternative approach is to replace `Function(` with `(()=>null)(` throughout
the bundle, neutralising the `Function()` constructor entirely. We chose not to
because:

1. The Rspack module system uses `Function` internally for legitimate purposes
   (e.g. module factory evaluation in some configurations).
2. Blanket `Function` suppression would be harder to reason about and test.
3. The `import` evasion is the minimal, well-understood fix.

---

## Issue 3 — Missing Rspack runtime globals

### Error

Various `TypeError: Cannot read properties of undefined` crashes during
`compartment.evaluate()` before the container registration line is reached.

### Root cause

The Rspack IIFE bootstrap relies on several browser/Worker globals that SES
removes from the Compartment's `globalThis`:

| Global | Used for | Effect if missing |
|---|---|---|
| `self` | `self["chunk_catalogRemote "]` jsonp array | `TypeError: Cannot set properties of undefined` |
| `self["chunk_<name> "]` | Rspack jsonp chunk push | `r.forEach is not a function` |
| `document` | `document.createElement("script")` in `__webpack_require__.l` | `TypeError: document is not defined` |
| `document.getElementsByTagName` | Script deduplication in `__webpack_require__.l` | `TypeError` |
| `document.head.appendChild` | Script insertion | `TypeError` |
| `setTimeout` | Script-load timeout in `__webpack_require__.l` | `TypeError` |
| `clearTimeout` | Clear script-load timeout | `TypeError` |

None of these are needed for our actual goal (evaluating the plugin factory).
They are all part of the Rspack runtime's **network chunk loading subsystem**
(`__webpack_require__.l`), which we never trigger — we have the full source text.

### Fix

Endow the Compartment with minimal stubs for each missing global:

```ts
{
  // Rspack jsonp runtime
  self: {
    "chunk_catalogRemote ": { forEach: () => {}, push: () => {} }
  },
  // Script injection stubs (no-op — we don't want network loading)
  document: {
    getElementsByTagName: () => [],
    createElement: () => ({ setAttribute: () => {}, src: "", onerror: null, onload: null }),
    head: { appendChild: () => {} },
  },
  setTimeout:  () => 0,
  clearTimeout: () => {},
  // Needed for container.get() which returns a Promise
  Promise,
}
```

**Important:** these stubs grant **no real authority**. `document.createElement`
returns a plain object, not a real `HTMLElement`. `appendChild` is a no-op.
The real `document` is never exposed to the compartment. A remote plugin
cannot inject scripts into the host page, read the DOM, or make network
requests via this stub.

### Note on the trailing space in the chunk key

Rspack names the jsonp array `chunk_<containerName> ` with a **trailing space**.
This is an artefact of how Rspack concatenates the unique chunk name. The stub
key must include the trailing space or `r.forEach(t.bind(null,0))` will throw
because it finds the key on a different object or not at all.

---

## Issue 4 — `document.defaultView` returns `undefined`

### Error

```
TypeError: Cannot convert undefined or null to object
  at hasOwnProperty
  at u (module 6984)
```

### Root cause

The MF runtime module 6984 (`CurrentGlobal`) sets up the federation global
state registry (`__FEDERATION__`) on **two** targets: `globalThis` and
`document.defaultView`:

```js
// module 6984 (CurrentGlobal)
let i = "object" == typeof globalThis ? globalThis : window;
let s = (() => { try { return document.defaultView } catch { return i } })();
let l = s;
// ...
h(i);   // sets up __FEDERATION__ on globalThis
h(s);   // sets up __FEDERATION__ on document.defaultView  ← crash if s is undefined/null
```

where:
```js
function h(e) {
  u(e, "__VMOK__")   // Object.hasOwnProperty.call(e, "__VMOK__") → TypeError if e is null/undefined
  // ...
}
```

Our original `documentStub` did not include a `defaultView` property, so
`document.defaultView` returned `undefined`. Then `h(undefined)` threw
`Cannot convert undefined or null to object` inside `hasOwnProperty.call`.

### Fix

Add `defaultView` to the document stub, pointing at the same plain object
used for `self`. In a real browser `document.defaultView === window`, so using
the same object for both is semantically correct:

```ts
const globalThisProxy: Record<string, unknown> = {};

const documentStub = {
  getElementsByTagName: () => [],
  createElement: () => ({ ...scriptStub }),
  head: { appendChild: () => {} },
  defaultView: globalThisProxy,   // ← must be a non-null object
};

const selfStub = globalThisProxy;  // document.defaultView === self
```

---

## Issue 5 — `Date.now()` locked in secure mode

### Error

```
TypeError: secure mode Calling %SharedDate%.now() throws
  at Date.now
  at i (module 6984)
  at Object.l (federation init)
  at t.init (federation instance bootstrap)
```

### Root cause

SES's `lockdown()` replaces `Date.now` with a function that throws in
"secure mode" to prevent timing-based side-channel attacks. The MF runtime
calls `Date.now()` during instance initialisation for versioning/timestamping.

### Fix

Endow a stub `Date` object with a no-op `now()`:

```ts
Date: { now: () => 0 },
```

`0` is a valid timestamp and has no semantic impact on the MF container
registration or plugin loading path.

---

## Issue 6 — Bare global assignment swallowed by SES scope chain

### Error

No error thrown — but `compartment.globalThis[containerName]` is `undefined`
after `compartment.evaluate()` completes successfully.

### Root cause

The Rspack IIFE always ends with:

```js
var __webpack_exports__ = __webpack_require__.x();
catalogRemote = __webpack_exports__   // ← bare undeclared identifier
```

In a normal browser, `catalogRemote = value` on an undeclared variable in
sloppy mode creates a property on `window` (the global). Inside a SES
Compartment, the source is evaluated inside a nested scope chain:

```
with (scopeTerminator) {
  with (globalObject) {       ← endowments proxy
    with (moduleLexicals) {
      with (evalScope) {
        /* source runs here */
      }
    }
  }
}
```

The assignment `catalogRemote = __webpack_exports__` is intercepted by the
`with (globalObject)` proxy — which stores it in the proxy's own record, not
in the `compartment.globalThis` object that callers read. The value is set
internally but is never visible from outside.

This is distinct from `globalThis.catalogRemote = value`, which explicitly
targets the object that `compartment.globalThis` reflects.

### Investigation

We confirmed this by tracing the assignment:

```js
// Instrumented source:
logger.info("x() returned:", typeof __webpack_exports__, JSON.stringify(Object.keys(__webpack_exports__||{})));
catalogRemote = __webpack_exports__;
logger.info("catalogRemote set to:", typeof catalogRemote);
```

Output: `x() returned: object ["get","init"]`, `catalogRemote set to: object`.

The assignment succeeded — but `c.globalThis.catalogRemote` was still
`undefined` afterwards.

### Fix

Replace the bare assignment in the source text before evaluation:

```ts
source.replace(
  `${containerName}=__webpack_exports__`,
  `globalThis["${containerName}"]=__webpack_exports__`,
)
```

`globalThis[...]` inside a SES Compartment evaluates to the Compartment's
own `globalThis`, which **is** the object that `compartment.globalThis`
reflects. The assignment now lands in the right place.

### Why we do NOT prepend `"use strict"`

An earlier version of the fix prepended `"use strict"` to force strict mode,
under the assumption it would make the runtime behaviour more predictable.
This was wrong: in strict mode, `catalogRemote = __webpack_exports__` where
`catalogRemote` is undeclared throws a `ReferenceError` — which means the
container is never registered at all. The bare-assignment fix above eliminates
the need for strict mode entirely.

---

## Issue 7 — Dev server bundles contain devtools (`isomorphic-ws`)

### Error

```
TypeError: isomorphic_ws.default is not a constructor
  at createWebsocket
  at (SES make-evaluate.js:92)
```

### Root cause

`@module-federation/rsbuild-plugin` injects additional devtools runtime code
into the `remoteEntry` bundle **only in development mode** (when serving via
`rsbuild dev`). This devtools runtime includes:

- Live manifest polling and hot-reload coordination
- A WebSocket client (`isomorphic-ws`) for connecting back to the Rsbuild dev
  server HMR endpoint
- Source-map annotation helpers
- Type-extraction utilities (`@module-federation/third-party-dts-extractor`)

The `isomorphic-ws` package exports its WebSocket class as `module.default`.
Inside a SES Compartment, the module was evaluated in the **host realm** — not
inside the compartment. Its exports object is not endowed into the compartment.
When the bundle calls `new isomorphic_ws.default(url)`, `isomorphic_ws.default`
is `undefined` inside the compartment scope, producing `TypeError: ... is not
a constructor`.

### Why it does not appear in production builds

`rsbuild build` generates a clean IIFE with only the MF runtime and the user's
plugin code. The devtools injection is a dev-only plugin hook in Rsbuild that
is not active when `NODE_ENV=production`.

### Fix — use production artifacts only

**The CompartmentLoader must only evaluate production-built bundles.**

Dev server output is not an appropriate input for SES evaluation:

1. It contains devtools that assume a browser WebSocket environment
2. It contains HMR client code that tries to connect to a dev server
3. It may include source maps and un-minified code with patterns SES hasn't
   been tested against
4. From a security perspective, dev mode artifacts are instrumented and
   should never be the security boundary

**How to run the MF demo correctly:**

```bash
# Build production artifacts for the remotes
pnpm --filter @poc/catalog build
pnpm --filter @poc/cart build

# Serve them statically (not via rsbuild dev)
npx serve apps/catalog/dist -p 4001 --cors
npx serve apps/cart/dist    -p 4002 --cors

# Start the host dev server
pnpm --filter @poc/host dev
```

The host's **Run MF Demo** button fetches from ports 4001/4002 (production
artifacts) rather than 3001/3002 (dev server output).

### Security note

This constraint is also correct from a security standpoint: in any real
deployment, you would only ever load and evaluate **signed, audited, versioned**
production artifacts inside a SES Compartment. Evaluating dev server output
would be equivalent to evaluating untrusted code with debugging instrumentation
— exactly what SES is designed to prevent being the default.

---

## Summary of transforms applied

All transforms are applied in `sanitizeRemoteSource(source, containerName)` in
`apps/host/src/platform/compartment-loader.ts`, in this order:

```
raw remoteEntry source
        │
        ▼  ① split("eval(").join("(0,eval)(")
        │     Direct eval → indirect eval
        │     Fixes: SES_DIRECT_EVAL
        │
        ▼  ② .replace(IMPORT_PATTERN, (_, p1, p2) => `${p1}__import__${p2}`)
        │     import( → __import__(  inside any context
        │     Fixes: SES_IMPORT_REJECTED
        │
        ▼  ③ .replace(`${containerName}=__webpack_exports__`,
        │              `globalThis["${containerName}"]=__webpack_exports__`)
        │     Bare global assignment → explicit globalThis assignment
        │     Fixes: container invisible after evaluate()
        │     NOTE: no "use strict" — Rspack IIFEs must remain sloppy-mode
        │
        ▼
   safe source → compartment.evaluate(safeSource)
```

Additionally, `makeRspackEndowments()` provides these stubs at Compartment
construction time:

```
Endowment               Value                   Fixes
─────────────────────   ───────────────────────  ────────────────────────
document                stub with defaultView    Issues 3 + 4
document.defaultView    same object as self      Issue 4
self                    shared plain object      Issue 3
self["chunk_<n> "]      {forEach:()=>{},push:…}  Issue 3 (trailing space)
__webpack_require__     undefined (seeded)       Issue 3
setTimeout              () => 0                  Issue 3
clearTimeout            () => {}                 Issue 3
Date                    { now: () => 0 }         Issue 5
Promise                 real Promise             needed for container.get()
```

## What we deliberately do NOT fix

### Async chunk loading

The Rspack runtime in `remoteEntry.js` includes a full async chunk loader
(`__webpack_require__.f.j`, `__webpack_require__.l`). When the host calls
`container.get("./plugin")`, the MF runtime would normally load the plugin
code as a separate async chunk from the network.

We side-step this entirely: the expose chunk
(`__federation_expose_plugin.*.js`) is already evaluated when the compartment
evaluates the IIFE's startup sequence, because Rspack's `initializeExposesData`
registers the factory synchronously using `__webpack_require__.e(...).then(...)`.

In practice, `container.get("./plugin")` returns a Promise that resolves by
pulling from `__webpack_module_cache__` — no network request is made. This
works because Rspack bundles the expose chunk inline in the IIFE startup for
small remotes. If the expose chunk were split into a separate file, this
approach would need to be extended to also fetch and evaluate that chunk.

### Shared singleton semantics

Module Federation's shared scope (`__webpack_require__.S`) negotiates singleton
libraries (React, ReactDOM) between host and remotes. We set `shared: []` in
all MF configs and pass an empty object to `container.init({})`. This means
each remote bundles its own copy of any utilities it needs. This is intentional
for a logic-only plugin PoC with no UI framework.

### HMR / live reload

HMR across Compartment boundaries would require re-fetching the remote source,
re-running `sanitizeRemoteSource`, creating a new Compartment, and migrating
any live subscriptions. This is out of scope for a PoC.

---

## SES internals reference

| Symbol | Location | Purpose |
|---|---|---|
| `rejectSomeDirectEvalExpressions` | `ses/src/transforms.js` | Throws on `eval(` |
| `someDirectEvalPattern` | same | Regex: `/(^|[^.])(\beval)(\s*\()/g` |
| `rejectImportExpressions` | same | Throws on `import(` |
| `importPattern` | same | Regex: `/(^|[^.]\|\.\.\.)\bimport(\s*(?:\(\|\/[/*]))/g` |
| `evadeImportExpressionTest` | same | Renames `import` → `__import__` (not exported) |
| `SES_DIRECT_EVAL` | `ses/error-codes/` | Error code docs |
| `SES_IMPORT_REJECTED` | `ses/error-codes/` | Error code docs |

SES version at time of investigation: **1.15.0**

---

## Module Federation internals reference

| Location in bundle | Pattern | Why it's there |
|---|---|---|
| Module 2829 (`getSharedFallbackGetter`) | `eval(\`${n}\`)` | Runtime code-gen for shared dependency tree-shaking |
| `loadEntryDom` | `Function("callbacks", \`import("${t}")\`)` | Loads a remote entry via ESM `import()` |
| `loadEntryNodeVm` | `Function("callbacks", \`System.import("${t}")\`)` | Same, SystemJS variant |
| `sdkImport` | `Function("name","return import(name)")(e)` | MF SDK internal module loader |

MF plugin version at time of investigation: **@module-federation/rsbuild-plugin 2.5.0**

All four `import(` occurrences are guarded — they only execute when
`FEDERATION_ALLOW_NEW_FUNCTION` is falsy or when a live remote URL is provided.
Neither condition applies in our compartment-based loader.
