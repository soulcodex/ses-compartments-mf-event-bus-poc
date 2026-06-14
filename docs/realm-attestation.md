# Realm Attestation — Certificate-Based Authentication Between Realms

> **Status:** this document describes **two variants**.
> 1. **Host-anchored (implemented in this PoC)** — the host generates each realm's
>    id and stamps it on every message; a peer compares that stamp against an
>    origin-signed certificate. No per-realm keys. The host/registry is trusted.
>    This is what the **Counter Exchange** demo runs.
> 2. **Key-possession (stricter alternative)** — each realm holds a non-extractable
>    key and proves possession per session; works even if the relay is *not*
>    trusted. Specified in the lower half of this document; not implemented.

This extends the PoC from *capability isolation* (a realm can only do what its
endowments allow) to *origin authentication* (a realm can prove **which origin it
was served from**, and peers refuse to exchange data with a realm they cannot
attest).

---

## Table of contents

- [Where this fits — and where it does not](#where-this-fits--and-where-it-does-not)
- [Implemented design (this PoC): host-anchored, keyless](#implemented-design-this-poc-host-anchored-keyless)
- [Threat model](#threat-model)
- **Stricter alternative — key-possession (not implemented):**
- [Why a static certificate fails](#why-a-static-certificate-fails)
- [The construction: ephemeral key + server-issued certificate](#the-construction-ephemeral-key--server-issued-certificate)
- [Protocol](#protocol)
- [Why this defeats the attack](#why-this-defeats-the-attack)
- [The linchpin assumption: private-key isolation](#the-linchpin-assumption-private-key-isolation)
- [Integration into this PoC](#integration-into-this-poc)
- [What it proves / does not prove](#what-it-proves--does-not-prove)
- [Open questions](#open-questions)

---

## Where this fits — and where it does not

The PoC already has an **unforgeable identity mechanism for in-thread
compartments**: the host hands each compartment a `makeScopedBus({ compartmentName, ... })`
endowment and *stamps the `source` itself* (`packages/shared/src/scoped-bus.ts`).
A compartment never asserts who it is — holding the catalog-scoped bus reference
*is* the proof that it is catalog. That is the object-capability (OCAP) model: the
capability is the credential.

So this attestation layer is **not** for the in-thread case, where it would be
pure ceremony. It earns its place exactly where the OCAP reference graph cannot
reach:

| Boundary | Identity mechanism | Needs crypto? |
|---|---|---|
| In-thread compartment → host bus | Host stamps `source` from the reference it handed out | **No** — capability *is* identity |
| Worker → host bridge | Host knows which `MessagePort` the message arrived on | **No** — bind to the port, not `msg.source` (see note below) |
| Realm ↔ realm, end-to-end, relay untrusted | Receiver gets serialized data with a self-asserted source and no reference binding | **Yes** — this document |

> **Aside — a one-line bug this design does *not* fix.**
> `apps/host/src/platform/worker-bus-bridge.ts` publishes with `msg.source`
> (self-asserted by the worker, `plugin-worker.ts:76`) instead of the `name` it
> spawned the worker with. A malicious worker can post `source: "catalog"` and be
> believed. The correct fix there is **not** a certificate — it is to use the
> bound `name`, because the transport already binds identity to a port. Attestation
> is for the case where there is **no** such trustworthy transport binding.

In this PoC the chosen boundary is: **each realm requests a certificate from the
web server it was served from, and a peer refuses to exchange data with a realm it
cannot attest.** The two variants below differ only in *what makes a realm-id
unspoofable* — a trusted host stamp, or a private key.

---

## Implemented design (this PoC): host-anchored, keyless

This is the variant the **Counter Exchange** demo runs. It trusts the host /
registry to assign and stamp realm-ids, and uses an origin certificate purely to
bind `realm-id → role/origin`. **No per-realm keypair, no per-message signatures.**

### Trust model

- **Trusted:** the host and its **registry** — it assigns each realm an id the
  realm cannot choose, stamps that id on every message the realm publishes, and
  exposes the live id set. (This is a *stronger* trust assumption than the
  key-possession variant, which trusts neither the relay nor the host stamp.)
- **Untrusted:** other realms, especially an injected malicious one.
- **Issuer servers:** the origin each realm was served from; trusted to certify
  the role of realms it serves.

### The id is generated *out of the realm's control*

The realm does **not** pick or derive its own id. The host generates it
(`crypto.randomUUID()`), records it in the registry, and passes it into the realm
as an endowment. The realm then submits a **sign-request over that external id** to
its origin — once per realm, not per message. Because the host also **stamps that
id on every message** the realm sends (the realm cannot forge the stamp), a peer
can obtain the sender's true id from a source the sender does not control.

### The seven-step flow

```
1. host generates realmId, registers it, endows it to the realm
2. host registry.list() exposes the live realmIds (+ role/origin) to verifiers
3. realm calls attest.requestCertificate() → host POSTs the realmId to the realm's
   origin /attest → origin issuer signs a JWS { realmId, role, origin, iat, exp }
4. realm wants to exchange the shared variable x with peers
5. realm broadcasts attest:hello { cert } once
6. a receiving realm verifies, using values the sender cannot forge:
     envelope.realmId (host-stamped) === cert.realmId     ← compare id vs cert
     cert signature valid against the trusted issuer anchor for cert.origin
     cert not expired, and realmId present in the registry
   pass → record sender in attestedPeers ; fail → ignore the sender
7. each realm SENDS value:updated only to its attestedPeers — directed delivery,
   enforced by the (trusted) host bus. An unattested realm is in nobody's
   recipient set, so the host never delivers it the value: it cannot sniff.
   (Receivers also drop any value from a sender they have not attested, which
   defeats injection from a realm that broadcasts.)
```

### Why a stolen certificate is useless here

A malicious realm can read another realm's `attest:hello` off the bus and **replay
the certificate**. It still fails, because its own messages are stamped with *its*
host-assigned id, not the certificate's:

```
malicious realm                 host bus                 verifier (cart realm)
  │ replays HELLO { cert_catalog }  │  (host stamps THIS sender's id = M) │
  │─────────────────────────────────►│───────────────────────────────────►│
  │                                  │   envelope.realmId = M              │
  │                                  │   cert.realmId      = catalog-id    │
  │                                  │   M ≠ catalog-id → REJECT           │
```

So the certificate is **not a bearer token**: holding it grants nothing unless the
host also stamps the matching id on your messages — which only the genuine realm
gets. The origin certificate's job is narrow: bind `realm-id → role/origin`,
signed by an issuer the verifier trusts. The host stamp supplies the per-message
identity; no realm keypair or per-message signature is needed.

### Why an unattested realm cannot read, either

Confidentiality is not a separate mechanism — it falls out of *where the gate
sits*. The value lives inside each realm and is only obtainable through messages.
A realm sends `value:updated` **only to the peers it has attested** (directed
delivery, enforced by the host). A realm with no valid certificate is attested by
nobody, so it is in **nobody's recipient set** — the host never delivers it the
value. It cannot sniff, even though it subscribes to the topic. This is the key
correction over a broadcast bus: gating reads on the *receive* side fails (the
subscriber just ignores the gate); gating on the *send* side works (the bytes
never reach it).

### Gating the exchange (the demo)

The Counter Exchange demo runs **with and without** attestation via a toggle:

- **Without:** realms replicate every `value:updated`; the malicious realm's
  injected value propagates — the spoof succeeds. This is the baseline.
- **With:** realms exchange only with attested peers; the malicious realm's
  replayed certificate is rejected on id-mismatch and its value is ignored.

### Integration points (as built)

| Concern | Where |
|---|---|
| Generate + register + stamp realm-id | host `RealmRegistry` + `makeScopedBus(realmId)` stamps `EventEnvelope.realmId` |
| Issue certificate | origin server `POST /attest` signs a P-256 JWS; public key at `/issuer.jwk` |
| Realm-side capability | `attest` endowment: `requestCertificate()`, `verify(cert, expectedRealmId)` |
| Trust anchors | host fetches each origin's `/issuer.jwk` once, endows them per realm |
| Verification | the realm's own handler compares `envelope.realmId` vs `cert.realmId` |
| Directed delivery | `bus.publish(topic, payload, recipients)` — host delivers only to subscriptions whose `realmId` ∈ recipients; realms send the value to `[self, ...attestedPeers]` |

---

## Threat model

**Principals**

- **Realm A / Realm B** — legitimate SES compartments, each loaded from its own
  origin (`catalog` from `:4001`, `cart` from `:4002`).
- **Issuer servers** — the web servers each realm was served from. They act as
  certificate issuers (mini-CAs) for the realm they served.
- **Relay** — the host `PlatformEventBus`. Routes messages; is *not* trusted for
  authenticity in this model.
- **Malicious realm M** — an injected compartment. May share an origin/bundle with
  a legitimate realm, may read any data that crosses the bus, and may publish
  arbitrary messages onto it.

**Attacker capabilities (in scope)**

- Read every byte that transits the relay (envelopes, attached certificates).
- Inject and replay arbitrary messages onto the relay.
- Load a copy of the same bundle a legitimate realm uses (so any *static* secret
  baked into the bundle is known to M).

**Out of scope**

- A compromised **host/relay** that mounts a denial-of-service (drops all
  messages). Authenticity is defended; availability is not — consistent with the
  PoC's existing "SES is not an availability boundary" stance.
- A compromised **issuer server** (if the CA is evil, it can mint any identity).
- An attacker that can read a *legitimate* realm's isolated private key. That
  isolation is the security assumption — see [the linchpin](#the-linchpin-assumption-private-key-isolation).

**Security goal.** When Realm B receives a message claiming `source: "catalog"`,
B can verify *on its own* that the message was produced by a realm the
catalog-issuer certified — and that it is fresh, not a replay — without trusting
the relay and without any prior shared secret with A.

---

---

# Stricter alternative — key-possession (not implemented)

> Everything below specifies the **stronger** variant that does **not** trust the
> host stamp: each realm holds a non-extractable private key and proves possession
> per session. Use it if the relay/host is later distrusted or the design goes
> cross-process / cross-origin where no trusted stamper exists. The PoC does not
> build this; it is kept as the design target.

## Why a static certificate fails

The naive design — *"bake a certificate into each realm; a realm without a valid
certificate is not trusted"* — is exactly the one you flagged as broken, and it
is worth spelling out why, because the failure drives the whole design.

```
1. Legitimate catalog realm ships with CERT_catalog (a static blob).
2. catalog attaches CERT_catalog to every message; cart trusts messages
   carrying a valid CERT_catalog.
3. Malicious realm M loads the same catalog bundle (same origin) OR simply reads
   CERT_catalog off the bus — it is sent in the clear with every message.
4. M now attaches CERT_catalog to its own forged messages.
   cart verifies CERT_catalog, sees it is valid, and trusts M as catalog.  ✗
```

The certificate is a **bearer token**: possession alone grants the identity.
Anything sent on the wire can be copied; anything baked into a shared bundle is
known to anyone with the bundle. A static certificate authenticates the *bundle*,
never the *running instance*. This is the spoof: M extracts the static
parameter/certificate and impersonates the module.

The fix has two parts, both of which replace *static* artifacts with *dynamic*,
*per-instance*, *non-copyable* ones:

1. **Bind the certificate to a secret only the live instance holds**, so copying
   the certificate is useless without the secret. → *ephemeral per-realm key.*
2. **Bind each accepted message to a fresh challenge**, so a captured signed
   message cannot be replayed later. → *receiver nonce.*

Your phrasing — *"a dynamic parameter such as realm id, sent to the server, signed
and returned to start comms"* — is exactly part (1): the realm id is dynamic
because it is derived from a freshly generated key, and the server's signature
over it is the certificate.

---

## The construction: ephemeral key + server-issued certificate

Each realm, **at boot, inside its own compartment**, generates a fresh asymmetric
keypair. The private half never leaves the compartment (ideally a non-extractable
`CryptoKey`). The **realm id is derived from the public key** — concretely, the
RFC 7638 JWK thumbprint, `realmId = base64url(SHA-256(canonical-JWK(pubKey)))`.

This makes the realm id a *dynamic parameter* in the precise sense you described:

- It is different on every load (fresh key → fresh thumbprint).
- It is not a value an attacker can choose or precompute for someone else's key.
- It is cryptographically bound to a private key the attacker does not have.

The **certificate** is the issuer server's signature binding that realm id (and
public key) to a claimed identity:

```
CERT = sign_issuerPrivKey(
  {
    realmId,                 // thumbprint of THIS instance's public key
    publicKey,               // the instance's public key (JWK)
    identity:   "catalog",   // the role the issuer vouches for
    issuer:     "https://catalog.example:4001",
    issuedAt,   expiresAt,   // short lifetime — minutes, not days
  }
)
```

Modeled as a JWS/JWT, this is just *"a JWT whose `sub` is the realm's public-key
thumbprint, signed by the origin server."* The realm presents `CERT` to peers; to
*act* as catalog it must additionally **sign each message with the private key**
whose thumbprint is in `CERT`. A peer therefore checks two independent things:

1. The issuer signed `CERT` → "the catalog server vouches that the holder of key
   `pubKey` may speak as catalog."
2. The message signature verifies against `pubKey` from `CERT` → "this specific
   message was produced by the holder of that key."

M can copy `CERT` (step 1 still passes) but cannot produce a valid message
signature (step 2 fails) because it does not hold the private key. **The bearer
token is gone.**

---

## Protocol

### Phase 1 — Issuance (realm ↔ its own origin server)

The realm authenticates to the server it was served from. The server already has
grounds to vouch for it — it served the bundle, over TLS, possibly under an
authenticated session — so it signs the realm's *self-generated* public key.

```
catalog realm                         catalog server (:4001)
  │  generate keypair (priv stays in compartment)
  │  realmId = thumbprint(pubKey)
  │
  │  POST /attest  { realmId, pubKey, identity: "catalog" }
  │─────────────────────────────────────────────────────────►│
  │                                          authenticate caller
  │                                          (TLS / session / origin)
  │                                          CERT = sign( realmId,
  │                                              pubKey, identity,
  │                                              iat, exp )
  │◄─────────────────────────────────────────────────────────│
  │  hold { CERT, priv } in the compartment; priv never leaves
```

The realm id travels *to* the server and the signature comes *back* — exactly the
round trip you described. The dynamic element is that `realmId`/`pubKey` are fresh
per instance, so the returned `CERT` is not a reusable static artifact.

### Phase 2 — Peer verification ("comprobation between realms")

Verification is realm-to-realm; the bus only relays. To stop replay, the receiver
contributes a **fresh challenge nonce** — the second dynamic parameter. A captured
signed message is bound to one nonce and is worthless against the next.

```
catalog realm            relay (host bus)            cart realm
  │  publish HELLO {CERT_catalog}  │                      │
  │───────────────────────────────►│─────────────────────►│
  │                                │     verify CERT_catalog with
  │                                │     catalog-issuer pubKey  (trust anchor)
  │                                │     pick fresh nonce N
  │                                │◄─────────────────────│  CHALLENGE { N }
  │◄───────────────────────────────│
  │  sig = sign_priv( N ‖ msgHash )│                      │
  │  publish MSG {payload, CERT,   │                      │
  │     nonce:N, sig}              │                      │
  │───────────────────────────────►│─────────────────────►│
  │                                │     1. CERT signed by trusted issuer?
  │                                │     2. sig verifies vs CERT.pubKey?
  │                                │     3. nonce == the N I just issued,
  │                                │        and unused, and unexpired?
  │                                │     all yes → accept as catalog
```

For request/response or streaming traffic, the established session can carry a
monotonic counter signed under the same key so each subsequent message stays
fresh without a new round trip; the nonce handshake is the session bootstrap.

### Trust anchors — how a realm knows the issuer's public key

"Comprobation between realms" requires each verifier to hold the **issuer public
keys** it is willing to trust. Two practical options, in increasing strictness:

- **Host-endowed anchor set.** The host constructs every compartment, so it endows
  each realm with `trustAnchors: { "catalog-issuer": pubKey, "cart-issuer": pubKey }`
  — only the issuers for peers this realm is policy-allowed to talk to. This
  cleanly ties attestation to the existing **permissions** model: the policy says
  *which topics*, the anchor set says *whose identity*.
- **Fetched over TLS from a well-known endpoint** (`/.well-known/realm-issuer.jwks`)
  so the anchor distribution does not depend on the host. Stricter, but moves trust
  to TLS + the well-known origin.

This PoC should use the **host-endowed** option: it matches how every other
capability already reaches a compartment, and it keeps the demo self-contained.

---

## Why this defeats the attack

| Attack | Defense | Result |
|---|---|---|
| M reads `CERT_catalog` off the bus and re-attaches it | `CERT` only certifies a public key; speaking requires the matching private key | M cannot sign → step 2 fails |
| M loads the same catalog bundle to get its secrets | There is no static secret in the bundle; the key is generated fresh per instance and never serialized | M's bundle has a *different* key, with no `CERT` for it |
| M captures a fully-signed catalog message and replays it | Each accepted message is bound to a receiver-issued nonce (or signed counter) | Replayed nonce is stale/used → rejected |
| M asks the catalog server for a cert under identity `catalog` | Issuance is gated by the server's own authentication of the caller | Server refuses to certify M as catalog |
| M forges its own keypair and self-signs a "certificate" | Verifiers only trust certs signed by configured issuer anchors | Self-signed cert fails issuer check |

---

## The linchpin assumption: private-key isolation

Every guarantee above collapses to one requirement:

> **A realm's private key must be unreachable by any sibling realm, and must never
> cross the bus.**

If M can read catalog's live private key, M can mint fresh signatures and the
dynamic nonce buys nothing — the same way a stolen static cert did. So the dynamic
scheme does **not** remove the need for isolation; it *depends* on it. What it adds
is: given isolation, identity now survives crossing an *untrusted relay*, which the
raw OCAP capability could not do because a serialized message carries no reference.

This is precisely what SES is for, and the PoC already relies on it:

- `lockdown()` freezes intrinsics so M cannot monkey-patch `crypto.subtle` or
  `Object.prototype` to siphon another realm's key material.
- Each key lives in its own `Compartment` `globalThis`; there is no shared mutable
  state unless the host endows it.
- Using a **non-extractable** `CryptoKey` means even the realm that owns it cannot
  serialize it — it can only *use* it to sign — so it cannot be leaked by accident
  or coercion onto the bus.

The honest boundary statement, in the README's voice: *this proves authenticity
under the assumption that compartment isolation of private keys holds; it does not
prove that isolation, which rests on SES and the host endowment discipline.*

---

## Integration into this PoC

Concrete touch points, smallest blast radius first. None of this replaces the
existing capability model — it layers on top.

**1. A `crypto` capability endowment.** Add a narrow, host-built capability
alongside `bus` and `logger`:

```ts
// what the realm sees — it can generate a key and sign, never export the key
new Compartment({
  bus: scopedBus,
  logger,
  attest: {
    generateIdentity(): Promise<{ realmId, pubKeyJwk }>,  // priv kept internal
    sign(bytes): Promise<Uint8Array>,                     // with the internal key
    verify(certOrSig, ...): Promise<boolean>,             // against trust anchors
  },
});
```

Backed by `crypto.subtle` with a **non-extractable** private key. Endowing
`sign`/`verify` rather than the raw key keeps to the PoC's OCAP discipline —
"endow the authority, not the material."

**2. Extend the envelope.** Today `EventEnvelope` is
`{ id, topic, source, timestamp, payload }` (`packages/shared/src/event-bus.ts`).
Add an authenticator without disturbing existing fields:

```ts
type AuthenticatedEnvelope = EventEnvelope & {
  cert:  string;        // the issuer-signed certificate (JWS)
  nonce: string;        // the receiver-issued challenge it answers
  sig:   string;        // sign_priv(nonce ‖ hash(topic,source,payload,timestamp))
};
```

The relay copies these through untouched — it does not verify them, by design.

**3. Verification in the *subscriber*, not the bus.** Because comprobation is
between realms, the check belongs at the receiving realm's subscribe wrapper, not
in `PlatformEventBus.publish`. Extend `makeScopedBus`'s `subscribe` so the handler
only fires after `attest.verify(envelope, expectedIssuerFor(envelope.source))`
passes; drop-and-log otherwise. This keeps the host bus a dumb relay and makes the
trust decision the realm's own.

**4. Trust anchors via permissions.** Extend `CompartmentPolicy`
(`packages/shared/src/permissions.ts`) with the issuer anchors for the peers each
realm may hear from:

```ts
catalog: {
  canPublish:   ["catalog:item-selected"],
  canSubscribe: ["cart:item-added"],
  trustAnchors: { cart: CART_ISSUER_PUBKEY },   // catalog will verify cart's certs
},
```

`malicious` gets `trustAnchors: {}` — it can verify no one and (with no cert of its
own) is verified by no one, on top of already having no publish/subscribe rights.

**5. A mock issuer for the demo.** Add a tiny `/attest` endpoint to each remote's
dev server (or a stub the host injects) that signs `{ realmId, pubKey, identity }`
with a per-origin issuer key. A new demo button — *"Run Spoof Attack"* — would have
the malicious realm replay catalog's `CERT` and a captured message, and the log
would show cart **rejecting** it on the signature/nonce check. That mirrors the
existing "Run Malicious Plugin" / "Run Mutation Attack" demos and makes the
guarantee visible.

**Sketch of the new flow against the existing loader:**

```
CompartmentLoader.loadRemoteInCompartment(...)
  → compartment endowed with { bus, logger, attest }
  → realm boot: attest.generateIdentity() → POST /attest → hold CERT
  → on publish: scoped-bus attaches { cert, nonce, sig }
  → on deliver: scoped-bus.subscribe verifies before invoking handler
       ├─ issuer check  (trustAnchors[source])
       ├─ signature check (cert.pubKey)
       └─ freshness check (nonce issued-by-me, unused, unexpired)
```

---

## What it proves / does not prove

**Proves**

| Property | Mechanism |
|---|---|
| Origin authenticity across an untrusted relay | Issuer-signed cert binds identity to a per-instance public key |
| Spoof resistance to certificate theft | Speaking requires the non-extractable private key, not the cert |
| Replay resistance | Each accepted message bound to a fresh receiver nonce / signed counter |
| Independence from the host's honesty *for authenticity* | Verification is realm-to-realm; the bus only relays |
| Continuity with the existing model | Anchors ride on `permissions`; `sign`/`verify` are endowments like `bus` |

**Does not prove**

- **Availability.** A malicious relay can still drop or stall messages. Unchanged
  from the PoC's existing stance.
- **Confidentiality.** Payloads are signed, not encrypted; the relay still reads
  them. Add per-pair key agreement (ECDH) if peers must hide content from the relay.
- **Private-key isolation itself.** Assumed from SES + endowment discipline; this
  layer *depends on* it rather than establishing it.
- **Issuer honesty.** A compromised origin server can certify anyone as anything.
- **Compromised-host key theft.** A host that breaks compartment isolation to read
  a private key defeats everything — but such a host already owns the PoC entirely.

---

## Open questions

- **Key lifetime / rotation.** Short cert expiry forces re-attestation round trips;
  pick a window (single demo session vs. minutes) and decide whether to re-issue on
  expiry or tear the realm down.
- **Revocation.** Bus-level CRL/short-TTL vs. an issuer "is this realm id still
  good?" endpoint. Short TTL is simplest for a PoC.
- **Nonce bookkeeping.** Receivers must remember issued/seen nonces within the
  validity window — bounded memory, needs an eviction policy.
- **Algorithm choice.** Ed25519 (compact, fast) vs. ECDSA P-256 (broadest
  `crypto.subtle` support today). P-256 is the safe default for browsers.
- **Does the host *also* verify?** Optionally yes, as defense-in-depth, but the
  model deliberately does not *rely* on it — the realm is the verifier of record.
```
