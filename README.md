# SES Compartments Event Bus PoC

A proof of concept demonstrating that two SES Compartments can communicate
through a host-owned event bus while preserving strict capability boundaries.

---

## Table of Contents

- [What this PoC proves](#what-this-poc-proves)
- [What this PoC does not prove](#what-this-poc-does-not-prove)
- [Architecture](#architecture)
- [Worker-based isolation](#worker-based-isolation)
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

---

## What this PoC does not prove

- **Availability** — SES provides no CPU or memory quotas; infinite loops are still possible
- **Host integrity** — a compromised host can do anything; a trusted host is assumed
- **Formal verification** — this is a conceptual demonstration, not a formally verified system
- **Performance** — no benchmarks are included
- **Full browser coverage** — some browser-specific globals may behave differently depending on lockdown options

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

**Run the browser demo**

```bash
pnpm dev
```

Open the URL printed by Rsbuild. Five buttons are available:

- `Run Happy Path` — catalog → cart → catalog full flow (in-thread)
- `Run Malicious Plugin` — blocked publish and subscribe attempts
- `Run Mutation Attack` — payload mutation after publish is ignored
- `Run Worker Demo` — same happy-path flow, each compartment in its own Worker thread
- `Clear Logs` — resets the log panel

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

---

## Future improvements

| Improvement                 | Description                                                       |
| --------------------------- | ----------------------------------------------------------------- |
| ~~Worker-based execution~~  | ✅ Implemented — see [Worker-based isolation](#worker-based-isolation) |
| Message schema registry     | Dynamic registration of event topics and schemas at runtime       |
| Async RPC layer             | Request/response patterns over the event bus                      |
| Plugin lifecycle management | Load, pause, resume, and unload plugins without restarting        |
| Runtime metrics             | Per-compartment publish/subscribe counters and latencies          |
| Per-plugin quotas           | Rate-limit publish calls per compartment                          |
| Module loading via SES      | Allow plugins to use `import` via SES import hooks                |
| Revocable capabilities      | Allow the host to revoke bus access from a compartment at runtime |

---

## License

MIT
