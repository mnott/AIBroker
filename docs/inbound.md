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
aibroker inbound add mail Home --mode message \
  --fields subject,from.address,snippet \
  --note "Gmail arrival: triage, then hand on to the right session"
```

The secret is printed **once**. `aibroker inbound list` never shows it again — printing
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

## When the funnel lies

Tailscale Funnel can report itself healthy while refusing every connection from
the internet: `funnel status` prints "Funnel on", the serve config is intact,
the node is Online, and the ingress relays reset every connection. Twice now the
outage was found only when a human noticed a message that never arrived.

Do not trust a local check. The tailnet resolver answers the funnel hostname
with the node's own `100.x` address, so a `curl` on that machine is answered by
the same daemon that would answer a real request — a green that means nothing.
The only honest probe resolves the hostname through a **public** resolver,
connects to the ingress address, and sets SNI by hand.

`funnel-watchdog.ts` does that every five minutes and, on three consecutive
failures, reconnects the node — which is what clears the state. It is
deliberately reluctant: one relay answering counts as up, an inconclusive probe
resets the streak rather than building toward a bounce, and a cooldown keeps a
fault it cannot fix from becoming a reconnect loop. A reconnect drops live
tailnet connections for a moment, so it happens on proof or not at all.

Set `AIBROKER_FUNNEL_WATCHDOG=0` to turn it off.

---

## Feeding a route from a polling source

Most sources cannot call a webhook. The pattern for those — and the trap in it —
is worth stating once, because getting it wrong floods whatever is downstream.

Keep the "already sent" marker **on the item**, not in a timestamp:

```javascript
// Gmail via Apps Script. The label is the marker.
const QUERY = 'is:unread -label:aibroker-sent';
const MAX_PER_RUN = 20;

function forward() {
  const sent = GmailApp.getUserLabelByName('aibroker-sent')
            || GmailApp.createLabel('aibroker-sent');

  for (const thread of GmailApp.search(QUERY, 0, MAX_PER_RUN)) {
    const res = UrlFetchApp.fetch(HOOK, { /* … */ muteHttpExceptions: true });
    if (res.getResponseCode() !== 202) return;   // leave unmarked; retry next run
    thread.addLabel(sent);                        // mark ONLY after a 202
  }
}
```

Three things are load-bearing:

**The marker lives on the item.** A single `lastRun` timestamp skips anything
arriving out of order and cannot survive a run that dies halfway. A label is
idempotent, visible in Gmail, and reversible — remove it to force a resend.

**Mark only after a confirmed 202, and stop the run on anything else.** Marking
an unsent item loses it permanently; carrying on through an outage burns the
rest of the batch against a dead endpoint.

**Cap the batch.** On 2026-08-03 a run with no cap and a broken marker forwarded
five months of mail in one burst — 91 tasks filed before the rate limit stopped
it. A cap turns a backlog into several quiet runs.

> **Gmail specifics that cost an afternoon.** `newer_than:` takes `d`/`m`/`y`
> only — `5m` means five *months*, not minutes, and there is no minute
> granularity. Deep links should use `?authuser=<email>`, never `/u/0/` (which
> is positional and means a different mailbox on a different machine), and
> `#all/<threadId>` rather than `#inbox/`, which breaks once a thread is
> archived.

---

## Which sources belong here

A route earns its keep when the event is **rare**, **already meaningful**
(someone upstream decided it matters), **timely** (knowing now beats knowing
later), and **survivable if missed** while the machine is off.

Good fits: a server reporting a stuck queue or a failed cron; an app you own
raising an unhandled error or a form submission; a domain approaching expiry; a
human replying to something you sent.

**A bad fit, learned the hard way: undifferentiated mail.** "A message arrived"
is not a decision anyone made — it fails *rare* and *already meaningful*, and
the hard part was never latency but classification. Routing a whole inbox
through here on 2026-08-03 put twenty messages into a working session before the
route was pulled. Where the deciding has not happened yet, a scheduled sweep is
the right tool; a channel is for events that are already alerts.

If classification really is needed, use two hops: the event reaches a **dedicated
triage session** — never a session doing other work — and that session forwards
what matters with `aibroker_send_to_session`. Judgement stays somewhere with
context and rules, and every hop is in the audit trail.
