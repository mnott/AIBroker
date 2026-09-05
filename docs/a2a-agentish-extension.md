# AG2 as an A2A extension

Agent2Agent (A2A) is a transport-and-envelope protocol: it defines how one
agent finds another (AgentCard), how a message gets from one to the other
(`message/send`, `message/stream`), and what a message is built of (`Message`
→ `Part[]`). It says nothing about what the words inside a text part mean.

Agentish v2 (AG2 — see `docs/agentish.md`) is exactly that: a wire format for
what one agent tells another about a job — a kind line plus `k=v` lines
instead of prose. This document defines AG2 as an **A2A extension**, so any
A2A agent can declare "I understand AG2" in its AgentCard, and any other A2A
agent can check that declaration before sending AG2 text instead of prose.

Source: `src/a2a/agentish-extension.ts`. Tests:
`test/a2a-agentish-extension.test.ts`.

## Why an extension, not a new protocol

A2A already solved discovery, auth, streaming, and task lifecycle. AG2 solves
none of those — it only shapes the text inside a `Part`. Building a separate
protocol for AG2 would mean re-solving everything A2A already has; declaring
it as an A2A extension means AG2 gets all of that for free, and only has to
define the one thing A2A leaves open: what its `metadata` and `params`
objects carry.

A2A's own extension mechanism exists for exactly this shape of addition. Per
the specification, §4.6 ("Extensions") and its stable-release counterpart,
v0.3.0 §5.5.2.1 ("AgentExtension Object"):

- an extension is declared with a `uri`, an optional human-readable
  `description`, a `required` flag, and an optional `params` object of
  extension-specific configuration;
- `required: false` means a client that ignores the extension can still
  talk to the agent — the extension only adds meaning on top of the base
  protocol, it does not change how the base protocol behaves.

That is the right shape for AG2: an agent that never activates the extension
still gets ordinary `Message`/`Part` traffic; one that does gets a validator
and a spec string it can hold the other side to.

## The AgentCard fragment

`agentCardExtension()` builds the `AgentCard.capabilities.extensions[]` entry
(A2A spec v0.3.0 §5.5.2, "AgentCapabilities Object", which carries
`extensions?: AgentExtension[]`):

```json
{
  "uri": "urn:aibroker:a2a:ext:agentish:2",
  "description": "Agentish v2 (AG2): a compact kind+k=v wire format for agent-to-agent task reports. params.spec carries the format; params.validator names the CLI that checks a message against it.",
  "required": false,
  "params": {
    "version": "2",
    "spec": "AG2. msg=kind line+k=v lines. kinds T R S Q A X. keys i id g goal o own n forbid d steps p proof u out l limits r res c changes t tests G gate I inst m images # nums w worst x next z note(<200ch). sep |. outcomes + - ~ ? !. @n=path declared once then reused; @n:12=file:line. tests as Name+ Name-. no prose, no articles, never restate, unknown=?. r=+ only if all t +.",
    "spec_url": "docs/agentish.md",
    "extensions": "y why(≤600ch)",
    "validator": "aibroker agentish check"
  }
}
```

`urn:aibroker:a2a:ext:agentish:2` is a `urn:`, not an `https:` URL. A2A
extension URIs are identifiers, not fetchable locations — nothing in the
spec requires dereferencing one — so an `https://` URI pointing at a domain
nobody has registered or serves would read as a real, resolvable address
and be lying about it. `params.spec_url` is the resolvable pointer instead:
`docs/agentish.md`, resolved against whichever aibroker package or
repository checkout the reader installed from.

`params.extensions` is `AG2_EXTENSIONS`, imported straight from
`daemon/agentish.ts`: a short string documenting what this validator accepts
beyond `AG2_SPEC` itself (currently just the `y`/`why` field). This module
carries it through opaquely — it does not parse or reshape it, so it stays
correct however that string's format evolves.

## Example: an AG2 `T` and its `R` reply over A2A

A `Message` carrying an AG2 task arming, built with `ag2Part()`:

```json
{
  "messageId": "...",
  "role": "user",
  "parts": [
    {
      "kind": "text",
      "text": "T\ni=demo\ng=goal\nd=step\nt=Name\n@1=/repo\np=proof\nu=out",
      "metadata": { "agentish": "2" }
    }
  ]
}
```

And the `R` reply, tagged the same way (`@1` in scope because the `T`
message above is passed as `earlier` when validating this one):

```json
{
  "messageId": "...",
  "role": "agent",
  "parts": [
    {
      "kind": "text",
      "text": "R\ni=demo\nr=+\nt=Name+\nc=@1:12 changed line\nG=+\np=pasted proof\nx=next step",
      "metadata": { "agentish": "2" }
    }
  ]
}
```

`Part.kind`/`text`/`metadata` here match A2A's `TextPart` (spec v0.3.0
§6.5.1: `{ kind: "text", text, metadata? }` — `Part` itself is the
`TextPart | FilePart | DataPart` union at §6.5). `metadata.agentish: "2"` is
this extension's tag: the one piece of information a receiver needs before
it decides whether to run `text` through the AG2 grammar at all.

The current in-development spec draft (`a2a-protocol.org/latest`, not yet a
tagged release) reshapes `Part` around a `oneof text/raw/url/data` and drops
the `kind` discriminator; it also moves `extensions: string[]` onto `Message`
itself rather than requiring a text part's `metadata` to fully identify it.
This module targets the stable, widely-deployed v0.3.0 JSON-RPC shape.
Re-check both documents before adapting `A2ATextPart` if the draft ships.

## Activation

A2A negotiates which declared extensions are actually in play per request,
via the `A2A-Extensions` header (HTTP/JSON-RPC binding) or equivalent gRPC
metadata — a comma-separated list of extension URIs the client wants active
for that call (spec `topics/extensions`, "Extension Activation"; formalized
as a registered header in the current draft's header registry, §14.2.2,
"A2A-Extensions Header"). The header carries extension URIs as opaque
identifiers, so a `urn:` value belongs there exactly as an `https:` one
would. A client that wants AG2 traffic sends:

```
A2A-Extensions: urn:aibroker:a2a:ext:agentish:2
```

This extension is declared `required: false` (see the AgentCard fragment
above) and, like every A2A extension, is negotiated per request through
that header — never assumed. An agent that omits the header, or never sends
it, still gets ordinary `Message`/`Part` traffic; it just does not get the
option of an AG2 tag being meaningful to the other side, and per spec a peer
should not send AG2-shaped text to it without activation. Nothing in
`agentish-extension.ts` reads or writes this header: activation is a
transport concern, and this module is transport-free by design (see Not yet
provided, below).

## Validation

- `isAg2Part(part)` — is this a `TextPart` tagged as AG2? True if either
  `metadata.agentish === "2"` (the tag `ag2Part()` emits) or the part
  advertises a `mediaType`/`mimeType` of `text/x-agentish`
  (`AGENTISH_MEDIA_TYPE`) — a sender using the emerging draft's per-part
  media type instead of `metadata` is still recognized, even though
  `ag2Part()` itself only ever emits the `metadata` form today. Cheap, no
  grammar check.
- `validateAg2Part(part, earlier?)` — `isAg2Part` first, then runs `part.text`
  through `check()` from `daemon/agentish.ts`. Returns `{ ok, errors }`;
  `errors` is the same list `check()` produces, so a caller can print it
  straight through. `earlier` carries prior messages' texts so `@n=path`
  symbols they declared stay in scope, matching `check()`'s own contract.

## For an A2A implementer who does not run AIBroker

Nothing above requires AIBroker on both ends. A peer implementing A2A on its
own stack, in any language, only needs three things to interoperate:

1. **Declare the extension entry** in its own AgentCard — copy the JSON
   fragment under "The AgentCard fragment" verbatim (or regenerate it from
   `params.spec`/`params.spec_url` if `AG2_SPEC` changes upstream).
2. **Mark outgoing AG2 parts** the same way `ag2Part()` does: a `TextPart`
   with `metadata: { "agentish": "2" }` (or, per the newer draft,
   `mediaType: "text/x-agentish"`) alongside `A2A-Extensions:
   urn:aibroker:a2a:ext:agentish:2` on the request that carries it.
3. **Validate incoming AG2 text with the standalone validator** —
   `npx aibroker agentish check <file|->` — rather than reimplementing the
   grammar; that binds all interoperating peers to one source of truth for
   what counts as valid AG2, whether or not they run any other part of
   AIBroker.

**When a peer does not activate the extension** — it never sent
`A2A-Extensions` with this URI, or its AgentCard never declared it — fall
back to plain prose in the `Message`. Because this extension is
`required: false`, that is not an error state on either side: it means the
conversation continues as an ordinary A2A exchange, with AG2's savings
simply unavailable for it. Nothing about task delivery, streaming, or task
lifecycle changes; only the `text` inside `Part`s and whether it is checked
against `AG2_SPEC` does.

## Not yet provided

This module is a definition and a pair of helpers — nothing here sends a
byte. Serving AG2-capable A2A traffic still needs, roughly:

- a JSON-RPC endpoint implementing `message/send` (and, for streaming
  replies, `message/stream`) — currently there is no A2A server anywhere in
  this project;
- a mapping from an incoming `tasks/send`-shaped request onto AIBroker's own
  session mailbox, so an AG2 `T` arriving over A2A reaches the same place an
  AG2 `T` arriving over the daemon's own IPC does;
- an `AgentCard` served from the funnel host (see `docs/mesh.md`), with
  `agentCardExtension()`'s output placed in `capabilities.extensions`.

None of that is implemented, attempted, or scoped further here — this
document only names it so the next piece of work knows where it starts.

## See also

`docs/agentish.md` — the AG2 format itself, independent of any transport.
