# SES Compartments Event Bus PoC

A proof of concept demonstrating that two SES Compartments can communicate
through a host-owned event bus while preserving strict capability boundaries.

---

## Table of Contents

- [What this PoC proves](#what-this-poc-proves)
- [What this PoC does not prove](#what-this-poc-does-not-prove)
- [Architecture](#architecture)
- [Worker-based isolation](#worker-based-isolation)
- [Module Federation + SES isolation](#module-federation--ses-isolation)
- [SES + MF compatibility notes](./docs/ses-mf-compatibility.md)
- [Shared-variable demo — integrity vs confidentiality](#shared-variable-demo--integrity-vs-confidentiality)
- [How it works](#how-it-works)
- [Getting started](#getting-started)
- [SES Compartments explained](#ses-compartments-explained)
- [Endowments as capabilities](#endowments-as-capabilities)
- [Why the bus must be host-owned](#why-the-bus-must-be-host-owned)
- [Why payloads are cloned and hardened](#why-payloads-are-cloned-and-hardened)
- [Why shared mutable objects are dangerous](#why-shared-mutable-objects-are-dangerous)
- [Limitations](#limitations)
- [Future improvements](#future-improvements)

---

## What this PoC proves

| Property                    | Demonstrated by                                         |
| --------------------------- | ------------------------------------------------------- |
| Host owns authority         | Raw `PlatformEventBus` never reaches compartments       |
| Scoped capabilities         | Each compartment gets an attenuated bus view only       |
| Forbidden publish blocked   | `PermissionDeniedError` thrown on policy violation      |
| Forbidden subscribe blocked | `PermissionDeniedError` thrown on policy violation      |
| Payload immutability        | Mutation after publish does not affect receiver         |
| Receiver cannot mutate      | Hardened payload throws on write attempt                |
| No ambient authority        | `process`, `fetch`, `window`, `document` not accessible |
| Variable isolation          | Globals set in one compartment invisible in another     |
| Worker availability         | Each worker runs in its own OS thread; main thread stays responsive |
| Worker termination          | Host can call `terminate()` to kill a rogue plugin instantly |
| MF remote source in SES     | Rsbuild MF remote entry evaluated inside a SES Compartment  |
| MF capability isolation     | Remote code loaded via MF cannot escape its compartment     |
| MF event bus integration    | Compartment-loaded remotes communicate via the same host bus |
| Write integrity (variable)  | Malicious value modifier's forged `publish` denied — no fake value broadcast |
| Read is not gated (variable)| Malicious value reader sniffs the shared value via a leaked read capability, despite zero bus rights |

---

## What this PoC does not prove

- **Confidentiality** — the bus broadcasts and gates only *writes*; any party granted read access (a legitimate subscription, or a too-broadly endowed read capability) sees every payload. Payloads are validated and frozen, not encrypted. The variable demo demonstrates this directly: a zero-permission "malicious reader" still sniffs the shared value through a leaked `getSharedValues` endowment. See [Shared-variable demo — integrity vs confidentiality](#shared-variable-demo--integrity-vs-confidentiality).
- **Availability** — SES provides no CPU or memory quotas; infinite loops are still possible
- **Host integrity** — a compromised host can do anything; a trusted host is assumed
- **Formal verification** — this is a conceptual demonstration, not a formally verified system
- **Performance** — no benchmarks are included
- **Full browser coverage** — some browser-specific globals may behave differently depending on lockdown options
- **MF demo requires production artifacts** — dev server bundles include HMR devtools (`isomorphic-ws`) that fail inside a SES Compartment; only `rsbuild build` output is safe to evaluate
- **Source transforms are version-coupled** — `sanitizeRemoteSource` targets `@module-federation/rsbuild-plugin@2.5.0`; a different MF or Rspack version may produce a bundle with different patterns requiring new transforms

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│  Host Platform                                                          │
│                                                                         │
│  ┌───────────────────────┐     ┌─────────────────────────────────────┐  │
│  │   PlatformEventBus    │     │   Permission Policies               │  │
│  │                       │     │                                     │  │
│  │   subscribe(topic)    │◄────│   catalog  → publish + subscribe    │  │
│  │   publish(src, topic) │     │   cart     → publish + subscribe    │  │
│  │                       │     │   malicious→ nothing allowed        │  │
│  └───────────┬───────────┘     │   mutation → publish only           │  │
│              │                 └─────────────────────────────────────┘  │
│              │                                                          │
│  ┌───────────▼──────────────────────────────────────────────────────┐   │
│  │  SES lockdown()  ·  harden()  ·  structuredClone()               │   │
│  └───────────┬──────────────────────────────────────────────────────┘   │
└──────────────┼──────────────────────────────────────────────────────────┘
               │  scoped bus + logger (endowments only)
       ┌───────┼───────────────────────┐
       │       │                       │
       ▼       ▼                       ▼
┌─────────────────┐   ┌─────────────────┐   ┌─────────────────┐
│   Compartment   │   │   Compartment   │   │   Compartment   │
│    "catalog"    │   │     "cart"      │   │   "malicious"   │
│                 │   │                 │   │                 │
│  publishes:     │   │  publishes:     │   │  publishes:     │
│  catalog:item-  │   │  cart:item-     │   │  (blocked)      │
│  selected       │   │  added          │   │                 │
│                 │   │                 │   │  subscribes:    │
│  subscribes:    │   │  subscribes:    │   │  (blocked)      │
│  cart:item-     │   │  catalog:item-  │   │                 │
│  added          │   │  selected       │   │                 │
└─────────────────┘   └─────────────────┘   └─────────────────┘
```

### Event flow (happy path)

```
catalog                    host                      cart
   │                        │                          │
   │  publish(catalog:      │                          │
   │    item-selected)      │                          │
   │───────────────────────►│                          │
   │                        │  validate + clone        │
   │                        │  + harden payload        │
   │                        │  queueMicrotask()        │
   │                        │─────────────────────────►│
   │                        │                          │  receive event
   │                        │                          │  publish(cart:
   │                        │                          │    item-added)
   │                        │◄─────────────────────────│
   │                        │  validate + clone        │
   │                        │  + harden payload        │
   │                        │  queueMicrotask()        │
   │◄───────────────────────│                          │
   │  receive event         │                          │
```

---

## Worker-based isolation

The in-thread compartments above share the main thread. A single infinite loop
in a plugin freezes the entire page. The Worker mode adds a second isolation
layer by running each compartment in a dedicated OS thread.

### Architecture (Worker mode)

```
┌──────────────────────────────────────────────────────────────────────────┐
│  Main Thread — Host Platform                                             │
│                                                                          │
│  ┌─────────────────────────┐    ┌──────────────────────────────────────┐ │
│  │    PlatformEventBus     │    │       WorkerBusBridge                │ │
│  │                         │    │                                      │ │
│  │  subscribe(topic)       │◄───│  spawnPluginWorker(name, source)     │ │
│  │  publish(src, topic)    │    │  · spawns Worker per plugin          │ │
│  │                         │    │  · sends init message                │ │
│  └─────────────┬───────────┘    │  · forwards publish → bus            │ │
│                │                │  · forwards bus events → worker      │ │
│                │                │  · exposes terminate()               │ │
│                │                └──────────────────────────────────────┘ │
└────────────────┼─────────────────────────────────────────────────────────┘
                 │  postMessage / onmessage  (structured-clone boundary)
       ┌─────────┴─────────────────────────────┐
       │                                       │
       ▼                                       ▼
┌──────────────────────────┐     ┌──────────────────────────┐
│  Worker Thread           │     │  Worker Thread           │
│  "catalog"               │     │  "cart"                  │
│                          │     │                          │
│  ┌────────────────────┐  │     │  ┌────────────────────┐  │
│  │  SES lockdown()    │  │     │  │  SES lockdown()    │  │
│  │                    │  │     │  │                    │  │
│  │  Compartment       │  │     │  │  Compartment       │  │
│  │  "catalog"         │  │     │  │  "cart"            │  │
│  │                    │  │     │  │                    │  │
│  │  bus  (scoped)     │  │     │  │  bus  (scoped)     │  │
│  │  logger            │  │     │  │  logger            │  │
│  └────────────────────┘  │     │  └────────────────────┘  │
└──────────────────────────┘     └──────────────────────────┘
```

### Message protocol

All cross-thread communication is serialised via `postMessage`. No shared
memory is involved. The structured-clone algorithm enforces a hard data
boundary between threads.

```
Worker → Host                      Host → Worker
─────────────────────────────      ────────────────────────────────
{ type: "publish",                 { type: "init",
  topic, payload, source }           name, policy, pluginSource }

{ type: "log",                     { type: "deliver",
  level, source, message }           envelope }

{ type: "ready", name }

{ type: "error", source, message }
```

### Worker event flow

```
Worker "catalog"          Main Thread (host)          Worker "cart"
       │                        │                           │
       │  postMessage           │                           │
       │  { type: "publish",    │                           │
       │    topic, payload }    │                           │
       │───────────────────────►│                           │
       │                        │  PlatformEventBus         │
       │                        │  validate + clone         │
       │                        │  + harden                 │
       │                        │  postMessage              │
       │                        │  { type: "deliver",       │
       │                        │    envelope }             │
       │                        │──────────────────────────►│
       │                        │                           │  SES Compartment
       │                        │                           │  handler runs
       │                        │                           │  postMessage
       │                        │                           │  { type: "publish",
       │                        │                           │    topic, payload }
       │                        │◄──────────────────────────│
       │                        │  PlatformEventBus         │
       │                        │  validate + clone         │
       │                        │  + harden                 │
       │                        │  postMessage              │
       │                        │  { type: "deliver" }      │
       │◄───────────────────────│                           │
       │  SES Compartment       │                           │
       │  handler runs          │                           │
```

### What worker isolation adds

| Property                  | In-thread compartments    | Worker compartments               |
|---------------------------|---------------------------|-----------------------------------|
| Capability isolation      | ✅ SES scoped bus          | ✅ SES scoped bus (same)           |
| Payload immutability      | ✅ harden()                | ✅ structuredClone (postMessage)   |
| Thread isolation          | ❌ shares main thread      | ✅ dedicated OS thread             |
| Main thread blocking      | ❌ plugin can block UI     | ✅ plugin cannot block main thread |
| Instant plugin kill       | ❌ not possible in-thread  | ✅ worker.terminate()              |
| Shared memory risk        | ⚠️ possible via endowments | ✅ postMessage boundary enforces it|

---

## Module Federation + SES isolation

This is the most advanced layer in the PoC. It proves that a Micro-Frontend
remote built with Rsbuild Module Federation can have its entry bundle fetched
as source text and evaluated inside a SES Compartment — preserving the exact
same capability isolation as hand-written plugins.

### Workspace structure

```
ses-compartments-mf-event-bus-poc/      ← pnpm workspace root
  packages/
    shared/                             ← @poc/shared
      src/
        schemas.ts                      schemas + EventTopic
        permissions.ts                  policies per compartment
        errors.ts                       PermissionDeniedError, ValidationError
        sanitize.ts                     structuredClone + harden
        event-bus.ts                    PlatformEventBus
        scoped-bus.ts                   makeScopedBus
        logger.ts                       makeLogger, hostLogger, addLogSink

  apps/
    host/                               ← @poc/host  (port 3000)
      src/platform/
        compartment-loader.ts           ← CompartmentLoader (fetch → evaluate → extract)
        compartment-factory.ts          in-thread factory
        worker-bus-bridge.ts            worker bridge
        lockdown.ts                     initializeSES()
      tests/
        compartment-loader.test.ts      34 exhaustive MF isolation tests

    catalog/                            ← @poc/catalog  (port 3001)
      src/plugin.ts                     MF-exposed catalog plugin

    cart/                               ← @poc/cart  (port 3002)
      src/plugin.ts                     MF-exposed cart plugin
```

### Architecture (MF + SES mode)

```
┌──────────────────────────────────────────────────────────────────────────┐
│  apps/host  (Main Thread)                                                │
│                                                                          │
│  ┌─────────────────────┐    ┌────────────────────────────────────────┐  │
│  │  PlatformEventBus   │    │  CompartmentLoader                     │  │
│  │  (host-owned)       │◄───│                                        │  │
│  │                     │    │  1. fetch(remoteEntry.js) → text       │  │
│  │  validate           │    │  2. new Compartment({ bus, logger })   │  │
│  │  clone + harden     │    │  3. compartment.evaluate(sourceText)   │  │
│  │  route events       │    │  4. extract container from globalThis  │  │
│  └─────────────────────┘    │  5. container.init({})                 │  │
│                             │  6. factory = container.get("./plugin")│  │
│                             │  7. exports = factory()                │  │
│                             └────────────────────────────────────────┘  │
└──────────────────────────────┬───────────────────────────────────────────┘
                               │  scoped bus + logger  (endowments only)
                               │  NO process, fetch, window, document
                ┌──────────────┴──────────────┐
                │                             │
                ▼                             ▼
  ┌──────────────────────────┐  ┌──────────────────────────┐
  │  SES Compartment         │  │  SES Compartment         │
  │  "catalog"               │  │  "cart"                  │
  │                          │  │                          │
  │  source: apps/catalog    │  │  source: apps/cart       │
  │  remoteEntry.js          │  │  remoteEntry.js          │
  │  (fetched as text,       │  │  (fetched as text,       │
  │   built by Rsbuild MF)   │  │   built by Rsbuild MF)   │
  │                          │  │                          │
  │  bus  (scoped)           │  │  bus  (scoped)           │
  │  logger                  │  │  logger                  │
  │  NO host globals         │  │  NO host globals         │
  └──────────────────────────┘  └──────────────────────────┘
       │  publishes                    │  subscribes
       │  catalog:item-selected        │  catalog:item-selected
       │                               │  publishes cart:item-added
       └──────────── host bus ─────────┘
```

### MF loading flow

```
Host                         CompartmentLoader              SES Compartment
  │                                │                               │
  │  loadRemoteInCompartment(...)  │                               │
  │───────────────────────────────►│                               │
  │                                │  fetch(remoteEntry.js)        │
  │                                │──── HTTP GET ────────────────►│
  │                                │◄─── source text ─────────────│
  │                                │                               │
  │                                │  new Compartment({ bus, logger })
  │                                │──────────────────────────────►│
  │                                │                               │
  │                                │  compartment.evaluate(source) │
  │                                │──────────────────────────────►│
  │                                │        registers container    │
  │                                │        on compartment.globalThis
  │                                │◄──────────────────────────────│
  │                                │                               │
  │                                │  container.init({})           │
  │                                │  container.get("./plugin")    │
  │                                │──────────────────────────────►│
  │                                │◄── factory() → exports ───────│
  │◄───────────────────────────────│                               │
  │  { exports, compartment,       │                               │
  │    cleanup() }                 │                               │
```

### Key design choice: skip MF shared scope

Standard Module Federation uses a shared scope to negotiate singleton
dependencies (React, ReactDOM, etc.) between host and remotes. This PoC
deliberately sets `shared: []` in every app's MF config.

Why: shared singletons require all compartments to access the same object
instance, which requires passing that object through the endowments boundary
— a non-trivial bridging problem. Remotes in this PoC are **logic-only plugins**
with no UI framework dependency, so shared scoping is unnecessary.

### SES + MF source compatibility

Evaluating a real Rsbuild MF `remoteEntry.js` inside `Compartment.evaluate()`
requires a source pre-processing step. Seven issues were encountered across the
full investigation:

| Issue | SES error / symptom | Root cause | Fix |
|---|---|---|---|
| 1 | `SES_DIRECT_EVAL` | `getSharedFallbackGetter` uses `eval()` for runtime code-gen | `eval(` → `(0,eval)(` |
| 2 | `SES_IMPORT_REJECTED` | Remote-entry loader uses `Function("callbacks",\`import("${url}")\`)` | `import` → `__import__` (SES evasion) |
| 3 | `TypeError` at runtime | `self`, `document`, `setTimeout` stripped by SES | Endow minimal no-op stubs |
| 4 | `TypeError: hasOwnProperty on undefined` | `document.defaultView` returns `undefined`; MF calls `h(defaultView)` | Add `defaultView: globalThisProxy` to document stub |
| 5 | `TypeError: Date.now() throws in secure mode` | SES locks `Date.now()` to prevent timing side-channels | Endow `Date: { now: () => 0 }` |
| 6 | Container `undefined` after eval (silent) | Bare `catalogRemote=__webpack_exports__` swallowed by SES `with`-scope | Replace with `globalThis["catalogRemote"]=__webpack_exports__` |
| 7 | `isomorphic_ws.default is not a constructor` | Dev server bundles inject HMR devtools (isomorphic-ws) absent from compartment | **Only evaluate production builds** (`pnpm build`, not `rsbuild dev`) |

Full investigation with root causes, regex references, and rationale:
**[docs/ses-mf-compatibility.md](./docs/ses-mf-compatibility.md)**

### Running the MF demo

> **Important:** The MF demo requires **production-built** remote artifacts.
> Dev server output (`rsbuild dev`) includes HMR devtools that fail inside
> a SES Compartment. See [Issue 7](./docs/ses-mf-compatibility.md#issue-7----dev-server-bundles-contain-devtools-isomorphic-ws) for the full explanation.

One command does everything — builds the remotes, serves them as static
production artifacts, and starts the host dev server:

```bash
pnpm demo:mf
```

What it runs under the hood:

```
pnpm build:remotes          # pnpm --filter @poc/catalog build
                            # pnpm --filter @poc/cart build
concurrently:
  pnpm --filter @poc/catalog serve   # serve dist -p 4001 (production)
  pnpm --filter @poc/cart serve      # serve dist -p 4002 (production)
  pnpm --filter @poc/host dev        # rsbuild dev at :3000
```

Then open `http://localhost:3000` and click **📦 Run MF Demo**. The host will:
1. Fetch `http://localhost:4001/remoteEntry.js` (catalog production build) as text
2. Fetch `http://localhost:4002/remoteEntry.js` (cart production build) as text
3. Sanitize each bundle (7 transforms — see compat notes)
4. Evaluate each inside its own SES Compartment with a scoped bus endowment
5. Trigger the event flow and log all communication

### What MF isolation proves

| Property                             | Mechanism                                             |
|--------------------------------------|-------------------------------------------------------|
| Bundler output is still isolatable   | Rsbuild-generated entry evaluates inside Compartment  |
| MF container API works in compartment| `container.init()` + `container.get()` succeed        |
| Capability isolation survives bundling| Remote cannot access `process`, `fetch`, `window`    |
| Same bus policy applies              | Same `scoped-bus` + `permissions` used for all modes  |
| MF globals do not leak               | Container registered on compartment globalThis, not window |
| Payload hardening survives MF boundary| `structuredClone` + `harden` apply to MF-sourced payloads |

### Test coverage (49 tests in `apps/host/tests/compartment-loader.test.ts`)

| Group | What is tested |
|---|---|
| Container registration | Valid container extracted · missing container throws · missing `.get()` throws · custom `containerName` |
| Plugin module loading | Factory returns exports · publish works · subscribe registers handler |
| Capability isolation | No `process`, `fetch`, `window` · restricted `document` stub (no real DOM) · no host env leakage · cross-compartment variable isolation |
| Bus capability enforcement | Allowed publish/subscribe · forbidden publish → PermissionDeniedError · forbidden subscribe → PermissionDeniedError · malicious remote fully blocked |
| Payload integrity | Payload cloned · payload hardened · post-publish mutation ignored · receiver mutation throws |
| Full integration | catalog→cart→catalog flow · cartSize accumulates · multiple sequential events |
| Error and edge cases | Syntax error in source · factory throw caught · cleanup() removes subscriptions · empty source throws · invalid payload → Zod error |
| MF container contract | `init()` called once · `get()` called with correct path · default modulePath · custom modulePath |
| Source sanitization | `eval(` → indirect eval · `import(` → `__import__` · dot-prefix exclusion · spread prefix · all occurrences replaced · regression: eval in source evaluates · regression: import in source evaluates · bare global assignment fixed · no `"use strict"` prepend |

---

## Shared-variable demo — integrity vs confidentiality

The variable demo (**🔢 Run Variable Demo**) is the graphic scenario. It renders a
live board of microfrontends that share one variable `x`. The variable *feels*
global, but it is physically a **local replica inside each compartment**, kept in
sync only by bus messages — set it on one card and watch every replica converge.
The demo makes one point: **the bus gates writes, but it cannot gate reads.**
Integrity is protected; confidentiality is not.

Each microfrontend holds its own `x`. A modifier never mutates its replica
directly — it broadcasts `value:updated`, and *every* replica (including the
sender's own) is updated only when that message arrives. Writes and reads of the
"global" travel the exact same path: the bus.

### The four roles

| Plugin | Policy | Behaviour |
|---|---|---|
| **value modifier** (×2) | publish + subscribe `value:updated` | Has a number input + **Set x** button; setting broadcasts the new value, replicated onto every card. |
| **value reader** | subscribe `value:updated` only | Replicates and displays the value read-only; its own publish attempt is denied. |
| **malicious value modifier** | nothing | Tries to forge and broadcast a fake value → every `publish` is denied with `PermissionDeniedError`. **Blocked.** |
| **malicious value reader** | nothing | Has no bus rights at all, yet **successfully sniffs the value**. |

### Why the malicious modifier is blocked but the malicious reader is not

The bus is the **only write path**, and `makeScopedBus` checks `canPublish`
before anything is published. The malicious modifier has no publish rights, so it
can never push a value other replicas would accept — **integrity holds**.

The malicious reader succeeds through a **deliberately planted vulnerability**: a
`getSharedValues()` read capability that the host endows into the demo
compartments. The bus enforces per-plugin policy; an **endowment does not**. A
read capability *is* authority (see [Endowments as capabilities](#endowments-as-capabilities)),
and handing it to a zero-permission plugin lets it read the value — even though
the bus correctly denies it a subscription. The snapshot it gets is frozen, so it
gains no *write* power; only confidentiality is lost, not integrity.

```
malicious modifier            host bus              malicious reader
   │ publish(value:updated)      │                        │ getSharedValues()
   │────────────X (denied)       │                        │──────────────┐
   │  PermissionDeniedError      │                        │   reads the  │
   │                             │   store (frozen)  ◄─────┘   shared store│
   │  integrity preserved        │                        │   confidentiality lost
```

**The fix** (what a real system should do): derive endowments from policy — never
give `getSharedValues` to a plugin whose policy has no subscribe rights — and
deliver reads **only** through the gated bus, so visibility follows the same
policy as publishing. The same confidentiality gap is discussed for the
cross-realm case in [docs/realm-attestation.md](./docs/realm-attestation.md)
(payloads are validated, not encrypted; any reader sees them).

---

## How it works

### 1. SES lockdown

`initializeSES()` calls `lockdown()` once before any plugin code runs.
This freezes all intrinsics and removes dangerous globals from the realm.

```ts
lockdown({
  errorTaming: "unsafe", // preserve error stacks
  stackFiltering: "verbose", // keep full traces
});
```

### 2. Compartment creation

Each plugin runs in its own `Compartment` with explicit endowments:

```ts
new Compartment({
  bus: scopedBus, // attenuated — only allowed topics
  logger: scopedLogger, // narrow — info/error only
  // no process, no fetch, no fs, no window
});
```

### 3. Scoped bus

The host wraps `PlatformEventBus` in a scoped object per compartment:

```
publish(topic, payload)
  └─ policy check (canPublish)   → PermissionDeniedError if denied
  └─ Zod schema validation       → ValidationError if invalid
  └─ structuredClone(payload)    → deep copy
  └─ harden(cloned)              → freeze deeply
  └─ queueMicrotask → deliver
```

### 4. Payload delivery

Subscribers receive a hardened `EventEnvelope`:

```ts
{
  id:        string,   // crypto.randomUUID()
  topic:     string,
  source:    string,   // name of the publishing compartment
  timestamp: number,
  payload:   T        // frozen — throws on mutation attempt
}
```

---

## Getting started

```bash
pnpm install
```

**Run the Node CLI demo**

```bash
pnpm demo:node
```

**Run the browser demo (in-thread + Worker scenarios)**

```bash
pnpm dev
```

Open the URL printed by Rsbuild. The following buttons are available:

- `Run Happy Path` — catalog → cart → catalog full flow (in-thread)
- `Run Malicious Plugin` — blocked publish and subscribe attempts
- `Run Mutation Attack` — payload mutation after publish is ignored
- `Run Worker Demo` — same happy-path flow, each compartment in its own Worker thread
- `Run Variable Demo` — a shared variable replicated across microfrontends: set it on one card and every replica converges; a malicious modifier is blocked, and a malicious reader sniffs without permission (see [Shared-variable demo — integrity vs confidentiality](#shared-variable-demo--integrity-vs-confidentiality))
- `Clear Logs` — resets the log panel and the variable board

**Run the MF demo (Module Federation + SES Compartments)**

```bash
pnpm demo:mf
```

Builds production artifacts for both remotes, serves them statically, and
starts the host dev server — all in one command. Then click **📦 Run MF Demo**.

**Develop remotes alongside the host**

```bash
# Start catalog and cart dev servers concurrently (dev mode, HMR enabled)
pnpm dev:remotes

# In a separate terminal
pnpm dev
```

> Note: `dev:remotes` starts the dev servers for MF hot-reload development.
> The **📦 Run MF Demo** button requires production artifacts (`pnpm demo:mf`).

**Build everything**

```bash
pnpm build          # builds all apps
pnpm build:remotes  # builds only catalog + cart (faster, for demo:mf prep)
```

**Run tests**

```bash
pnpm test
```

---

## SES Compartments explained

SES (Secure ECMAScript) is a subset of JavaScript designed to run untrusted
code safely in the same process. It has two main mechanisms:

**`lockdown()`** — freezes all shared intrinsics (`Object.prototype`, `Array`,
`Function`, etc.) so untrusted code cannot tamper with built-ins that trusted
code relies on.

**`Compartment`** — a lightweight isolated execution context. Each compartment
gets its own `globalThis` and only sees what the host explicitly endows. There
is no shared mutable state between compartments unless the host passes it in.

---

## Endowments as capabilities

In OCAP (Object Capability) design, a function or object is not just data — it
is _authority_. Endowing a compartment with a function grants it the power that
function represents.

```ts
// DANGEROUS — grants unrestricted file system access
new Compartment({ readFile });

// SAFE — grants only the ability to read a single known config value
new Compartment({ getPublicConfig: () => ({ version: "1.0" }) });
```

This PoC endows only two things per compartment:

- `bus` — a scoped capability limited to allowed topics
- `logger` — a narrow capability for logging only

Nothing else is accessible inside the compartment.

**A read capability is still authority.** The [variable demo](#shared-variable-demo--integrity-vs-confidentiality)
deliberately breaks this discipline to show the consequence: it endows a third
capability, `getSharedValues()`, which returns a snapshot of the shared store.
Because it is endowed uniformly — ignoring each plugin's bus policy — a plugin
with *no* subscribe rights can call it and read everything. The bus never sees
this access, so its permission checks are irrelevant. The lesson: scope every
endowment to the plugin's policy; a function that reveals data is as much a
granted authority as one that performs an action.

---

## Why the bus must be host-owned

If compartments shared a bus directly, either compartment could:

- subscribe to any topic, including internal or privileged ones
- publish on behalf of another compartment
- mutate shared subscriber lists
- intercept or suppress events meant for others

By keeping the bus host-owned, the host mediates every message. It can enforce
policies, validate payloads, log everything, and revoke access at any time
without compartments being aware.

---

## Why payloads are cloned and hardened

**`structuredClone(payload)`** produces a deep copy. If the sender retains a
reference to the original object and mutates it after publishing, the receiver
is unaffected — they see the value at publish time.

**`harden(cloned)`** deeply freezes the copy. Any attempt to mutate the
received payload throws a `TypeError` in strict mode. This prevents one
compartment from passing a trojan object whose properties change meaning after
delivery.

---

## Why shared mutable objects are dangerous

Consider this pattern without cloning:

```js
const payload = { itemId: "sku_123" };
bus.publish("catalog:item-selected", payload);
payload.itemId = "mutated_after_publish"; // receiver now sees wrong value
```

Or, without hardening, a handler could do:

```js
bus.subscribe("catalog:item-selected", (event) => {
  event.payload.itemId = "poisoned"; // affects every other handler
});
```

`structuredClone` + `harden` together eliminate both attack vectors.

But hardening only protects *integrity*. A shared object — or a shared read
capability over host state — still leaks *confidentiality*, because freezing data
does not stop anyone holding the reference from reading it. The variable demo's
`getSharedValues()` leak is exactly this: the snapshot it hands out is frozen (so
the sniffer cannot tamper with it), yet handing it out at all lets an unauthorized
plugin read the value. Freeze what you share — but more importantly, only share it
with plugins whose policy already permits the read.

---

## Limitations

### SES is not an availability boundary

SES prevents capability leakage but does not prevent resource exhaustion.
A compartment running in-thread can still:

- run an infinite loop and block the thread
- allocate unbounded memory
- call `bus.publish` in a tight loop flooding subscribers

The Worker mode in this PoC addresses thread blocking — each plugin runs in
its own OS thread and can be terminated instantly. However Workers still share
the process memory space, so memory exhaustion and CPU quotas remain unsolved.
Use process isolation (e.g. separate Node processes, iframes with CSP) for
stronger availability guarantees.

### Endowed functions are authority

Any function endowed into a compartment grants whatever power that function
has. Endowing `readFile` gives file system access. Endowing `fetch` gives
network access. Audit every endowment carefully.

### Hardened Maps and Sets

`harden()` freezes the Map/Set object itself (no new entries) but entries added
before hardening may still be mutable objects if they were not themselves
hardened. Always sanitize before hardening.

### Browser globals

In browsers, SES lockdown removes many globals from compartments, but `window`,
`document`, and `localStorage` exist on the host page. Do not endow them into
compartments unless you intend to grant full DOM authority.

### No module loading

Plugins in this PoC are evaluated as plain strings via `compartment.evaluate()`.
They cannot use `import` statements. Full module graph support requires SES
import hooks, which are more complex to configure correctly.

### MF source transforms are version-coupled

`sanitizeRemoteSource` applies textual transforms tuned for
`@module-federation/rsbuild-plugin@2.5.0` + `ses@1.15.0`. If either package
changes its IIFE shape, global-registration pattern, or eval/import usage, the
transforms will need updating. The compatibility notes in
[docs/ses-mf-compatibility.md](./docs/ses-mf-compatibility.md) document every
assumption so that future updates can be made precisely.

### MF dev artifacts cannot be evaluated

`rsbuild dev` injects HMR devtools (`isomorphic-ws`, live manifest polling,
source-map helpers) that are absent from compartment endowments and will crash
at evaluation time. Only `pnpm build` output is suitable for the
`CompartmentLoader`. This is also the correct security posture — never evaluate
dev-mode instrumented code as a trust boundary.

---

## Future improvements

| Improvement                       | Description                                                             |
| --------------------------------- | ----------------------------------------------------------------------- |
| ~~Worker-based execution~~        | ✅ Implemented — see [Worker-based isolation](#worker-based-isolation)   |
| ~~Module Federation + SES~~       | ✅ Implemented — see [Module Federation + SES isolation](#module-federation--ses-isolation) |
| Zephyr Cloud deployment           | Add `zephyr-rsbuild-plugin` to remotes for versioned CDN delivery       |
| Message schema registry           | Dynamic registration of event topics and schemas at runtime             |
| Async RPC layer                   | Request/response patterns over the event bus                            |
| Plugin lifecycle management       | Load, pause, resume, and unload plugins without restarting              |
| Runtime metrics                   | Per-compartment publish/subscribe counters and latencies                |
| Per-plugin quotas                 | Rate-limit publish calls per compartment                                |
| Module loading via SES import hooks | Allow plugins to use `import` via SES import hooks                    |
| Revocable capabilities            | Allow the host to revoke bus access from a compartment at runtime       |
| UI component isolation            | Extend MF remotes to expose React/Solid components through a membrane  |
| Cross-origin MF remotes           | CORS + CSP configuration for production cross-origin remote loading     |

---

## License

MIT
