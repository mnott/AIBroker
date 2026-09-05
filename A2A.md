# AIBroker for A2A

**AIBroker is an [A2A](https://a2a-protocol.org) agent (protocol v0.3.0), and it brings two things to an A2A deployment that are hard to get elsewhere: a fleet of named agent sessions you can task over the wire, and a compact, machine-checkable report format — Agentish — that any A2A agent can adopt as a declared extension without running AIBroker at all.**

If you are building on A2A, this document is for you. It has three parts, and you only need the one that matches your situation.

---

## 1. You run an A2A agent and want cheaper, verifiable agent-to-agent reports

You do not need AIBroker for this. Agentish is an A2A **extension**, declared in your AgentCard and carried in ordinary message parts.

**Why it exists.** Free-text status between agents is expensive to send and impossible to check. A report that says "done, all tests pass" cannot be distinguished from one that ran nothing. Agentish makes the report a typed, validated object: a reply cannot claim success (`r=+`) unless it lists its tests, names a passing gate, and carries proof — and a validator refuses the contradiction. It is terser than prose as a side effect; the point is that "done" becomes checkable.

**Declare it** in your AgentCard:

```json
{
  "capabilities": {
    "extensions": [
      {
        "uri": "urn:aibroker:a2a:ext:agentish:2",
        "description": "Agentish v2 — compact, validated agent-to-agent reports",
        "required": false,
        "params": { "version": "2", "spec": "AG2. msg=kind line+k=v lines. …" }
      }
    ]
  }
}
```

**Mark a part** as Agentish with `metadata: { "agentish": "2" }` on a text part.

**Validate** — dependency-free, works in CI, no daemon:

```bash
npx aibroker agentish check message.txt --json   # exit 0 clean, 1 on errors, 2 on usage
```

Stable error codes (`E_R_UNPROVEN`, `E_T_OMITTED`, …) mean you can gate a pipeline on it. If a peer has not activated the extension, fall back to prose — it is optional by design.

The format is small enough to keep in a system prompt; `npx aibroker agentish spec` prints it.

---

## 2. You want to expose your own agents to A2A clients

AIBroker sits in front of named sessions — long-running agents, each with its own context. Exposing one makes it an A2A skill that any conformant client can task.

```bash
aibroker a2a setup                       # generate a token, expose the endpoint, verify the card
aibroker a2a expose <session> --as "…"   # opt-in: nothing is public until you say so
```

**What a client then gets**, at your public URL:

- a conformant AgentCard at `/.well-known/agent-card.json`, validated against a vendored copy of the A2A schema;
- `message/send` that delivers to the named session and returns a `Task` you poll with `tasks/get`;
- `contextId` threading for multi-turn, idempotent `messageId` (a retry never double-delivers), `input-required` when the session asks a question back, task expiry, and `failed` with an error artifact on delivery failure;
- declared `securitySchemes` (bearer); TLS is your edge — Tailscale Funnel, or the nginx/Caddy stanza the setup prints.

**The security model is opt-in and non-enumerable.** Nothing is exposed by default. A task to a session you did not expose is refused *indistinguishably* from a task to a session that does not exist — the card is not a directory of everything you run, only of what you chose to publish. This mirrors AIBroker's inbound rule: a route names its session; the payload never chooses one.

Incoming task text is delivered to the session **framed as external data, not as an instruction** — an A2A message cannot impersonate the operator.

---

## 3. You want your agents to task other A2A agents

```bash
aibroker a2a card  <url>                 # fetch and inspect any agent's card
aibroker a2a send  <url> --skill s --body -
aibroker a2a check <url>                 # conformance-test any agent: card → schema → send → poll
```

`aibroker a2a check` runs against **any** A2A agent, not only AIBroker — a card fetch, a schema validation, a `message/send`, and a poll to a terminal state, reported as a PASS/FAIL table. Useful whether or not you adopt anything else here.

---

## Conformance and limits

- Targets **A2A v0.3.0**; the schema is vendored with its source and retrieval date under `src/a2a/schema/`.
- Not yet: streaming (`message/stream`) and push notifications — declared `false` in the card, honestly.
- Agentish carries a stable URN today (`urn:aibroker:a2a:ext:agentish:2`); the spec and validator will move to their own package once the format settles, and the URN stays.

Depth: [`docs/a2a.md`](docs/a2a.md) for the full A2A surface, [`docs/agentish.md`](docs/agentish.md) for the format and its validator rules.
