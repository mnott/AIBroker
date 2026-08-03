# Outbound — acting in systems we have no connector for

`aibroker outbound` · MCP tool `aibroker_outbound`

The mirror image of [inbound routes](./inbound.md), and the more valuable half.

## Why this exists

Automation platforms are full of hands and empty of judgement. TinyCommand
ships **2,023 actions against 414 triggers**, and its biggest business
integrations — Salesforce, Zoom — have actions *only*. Its agents run in a cloud
with no access to your files, your machine, or you; that is why Anthropic and
OpenAI appear in its catalogue as **actions**, not triggers. Models are
something those workflows call, never something that drives them.

We are the inverse: judgement, local context, and a human reachable by voice —
with no connector to Stripe or HubSpot and no intention of writing one.

So a session decides, and POSTs `{action, params}` at a webhook the platform
already exposes. Its workflow fans that out to whichever of its actions it
needs. **We never learn an API, never hold a vendor credential, and never
maintain a connector** — the platform holds all three, which is the one thing it
is genuinely good at.

## Registering a target

```bash
aibroker outbound add ops https://hooks.example.com/v1/webhook/abc123 \
  --header x-ops-token \
  --note "TinyCommand: refunds, CRM updates, Slack, Linear"
```

The secret is generated and printed **once** — put it on the receiving workflow.
`aibroker outbound list` never shows it again. Re-add the target to rotate.

URLs must be `https`. A shared secret and whatever a session decided do not go
over plain HTTP.

## Calling it

```
aibroker_outbound(target: "ops", action: "refund",
                  params: { orderId: "A-1421", amount: 1420, reason: "damaged" })
```

The body on the wire is deliberately dull:

```json
{ "action": "refund", "params": { … }, "session": "session:Home", "at": "…" }
```

That shape is a contract with a workflow somebody drew on a canvas, so it stays
fixed; everything specific belongs in `params`.

## Constraints, and why each is there

**Targets are named at the terminal, never derived from a payload.** A session
that could call an arbitrary URL is a session with an unbounded egress channel.
Naming one is a decision, and it is recorded.

**Every call is audited** — target, action, parameters, and outcome, success or
failure. An action taken in someone else's system with no local trace is the
worst of both worlds: it happened, and nothing here can say so.

**Rate limited** to 20 calls per target per minute, and timed out at 20 seconds.
Generous for decisions, useless for a loop.

**Ask before consequences.** Nothing in this path enforces approval, because
approval is a judgement. Where an action moves money, messages someone outside,
or deletes something, get the human's yes first — you have PAILot, and a voice
question takes five seconds.

## The shape this makes possible

> A complaint arrives. A session reads it, opens the order, checks it against
> your own records on disk, and decides a refund is due. It asks you on your
> phone. You say yes. It then issues the Stripe refund, updates the CRM, posts
> to Slack and files the ticket — through one webhook, in one call.

Five business systems touched. No integration written. One decision made by
something that could read the context and ask a human.

See [channels.md](./channels.md) for the inbound half of the same model.
