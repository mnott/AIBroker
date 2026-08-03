# Inbound routes — letting the outside world reach a session

`POST https://<your-public-host>/hook/<route>`

The Todoist channel proved a shape: something happens elsewhere, it becomes a
message addressed to a named session, and that session decides what to do about
it. This is the same path with the source removed — anything that can call a
webhook can reach a session, without writing an adapter for it.

It shares the HTTPS listener with the Todoist webhook, because a public endpoint
is the one genuinely hard part to arrange. See `docs/todoist.md` for the Funnel
setup; you only need one extra path.

```bash
tailscale funnel --bg --set-path=/hook http://127.0.0.1:8766/hook
```

---

## Security model — read this before creating a route

This is the most exposed thing on the machine. Four rules hold it together, and
each exists because the obvious alternative fails.

**A route names its session; the payload never does.** If callers could pick the
target, whoever found the URL would choose which session runs with your rights.
Routing is decided once, at the terminal, and recorded in the audit trail — the
same reasoning as Todoist ingress grants.

**The payload is data, not an instruction.** It arrives prefixed `[Inbound:<route>]`
and framed, in words, as external content the session must not take orders from.
Nothing in this path executes anything.

**No secret, no route.** A 24-byte secret in `x-aibroker-token`, compared in
constant time. An unknown route and a wrong secret both answer `404`, so the
endpoint cannot be used to enumerate which routes exist.

**Bounded and recorded.** 64 KB body cap, 30 requests per route per minute, and
every accept *and refusal* in `audit.jsonl`. A probe nobody records is a probe
nobody notices.

> **What this is not.** It is not a way for a cloud service to run commands here.
> The safe pattern is two hops: an inbound message reaches a session, and that
> session — applying its own judgement — may hand work onward to another. A
> platform that decides *for* a session is a prompt-injection surface with your
> shell behind it.

---

## Creating a route

```bash
aibroker todoist inbound add mail Home --mode message \
  --fields subject,from.address,snippet \
  --note "Gmail arrival: triage, then hand on to the right session"
```

The secret is printed **once**. `inbound list` never shows it again — printing
credentials on a listing command puts them into whatever scrollback, screen
share or terminal recording happens to be running. To rotate, create the route
again with the same name.

| Flag | Meaning |
|---|---|
| `--mode task` | *(default)* File a Todoist task in the owner's project. A human sees it before a session acts. |
| `--mode message` | Deliver straight to the session's mailbox and terminal. |
| `--fields a,b.c` | Lift only these payload paths into the message. Missing paths are skipped, never rendered as `undefined`. |
| `--note "..."` | What sends here, for whoever reads the config in six months. |

**Prefer `task` for anything that should become work.** It inherits the ingress
grants and puts a visible artifact in front of the work. Use `message` for things
a session should merely *know*.

---

## Verify

```bash
# Refused — no token, wrong token, unknown route all answer 404 alike
curl -sS -o /dev/null -w '%{http_code}\n' -X POST https://<host>/hook/mail \
  -H 'content-type: application/json' -d '{}'

# Accepted
curl -sS -X POST https://<host>/hook/mail \
  -H 'content-type: application/json' \
  -H 'x-aibroker-token: <secret>' \
  -d '{"subject":"test","from":{"address":"a@b.c"}}'
# → 202 {"accepted":true}

aibroker audit --action inbound
```

`202` means the payload was accepted, not that it was delivered — the response
is sent *before* delivery on purpose. Typing into a session can take fifteen
seconds, and a sender that times out and retries would deliver the same event
twice with nothing downstream able to tell the copies apart. What actually
happened is in the audit trail.

---

## When the laptop was off

Nothing here queues. Todoist retries a handful of times and gives up; most
senders do less. **The webhook is for latency, not for correctness.**

Any route that matters needs a catch-up query on the other side: on start, ask
the source what happened since a stored high-water mark. `todoist-mirror.ts`
does exactly this against the activity log, and PAILot's outbox does it for the
phone. A route without one is best-effort, and should be treated as such.

---

## Worked example — mail

The interesting flow is two hops, and it is the reason the payload may not name
a session:

1. Gmail arrival hits `/hook/mail` and is delivered to the `Home` session as data.
2. `Home` reads it and decides. A job posting is handed to `jobs-matthias` with
   `aibroker_send_to_session`; an invoice goes somewhere else; most mail is
   noted and dropped.

The classification is done by a session with your context and your rules, not by
a rule in someone else's cloud — and every hop is in the audit trail.
