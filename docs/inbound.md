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

## Subscribing a session to a repository's issues

The common case has its own verb, because doing it by hand is two steps with a
secret carried between them:

```
aibroker_subscribe_issues  repo: https://forge.example.org/owner/name
```

A session calls this itself — *"subscribe me to that repository's issues"* — and
it creates the route **and** registers the webhook on the forge. The secret never
leaves the daemon unless the forge could not be reached.

**A session can only subscribe itself.** There is no target parameter: the owner
is resolved from the caller's own identity. That is what keeps the property this
whole document rests on — a caller still cannot choose which session runs with
your rights, and a session filling its own mailbox gains nothing it did not
already have. A check fails the build if a target parameter is ever added.

**GitHub, Gitea and Forgejo.** Only registration differs; the events themselves
name their fields identically, which is why one field list serves all three.
Forgejo serves the Gitea API surface — the instance this was written against
answers `/api/v1/version` with `12.0.4+gitea-1.22.0`.

**Subscribing twice is safe.** The route name is derived from the repository, so
a second call re-points the existing route and keeps its secret rather than
accumulating duplicates. A forge that already has the hook answers `422`, which
counts as success for the same reason.

Two defaults come from watching real traffic rather than from taste:

| Default | Why |
|---|---|
| `coalesce: 25s by issue number` | One action by a person is several events on the forge. Opening an issue with an assignee fires `opened` **and** `assigned` within a second. Grouping by issue turns that back into the one thing that happened. |
| `ignore: sender.login=<account>` | Filters a named account outright. Useful when your sessions genuinely post as a separate bot account; useless when they share your credential, which is why it is no longer what prevents the loop. |
| echo suppression (automatic) | A session that comments causes an event on that issue, which returns as something to consider, which produces another comment. Nothing looks wrong until a session is talking to itself. Every write records the issue it touched, and an event about that issue within 90 seconds is dropped as the echo of it. No configuration, and no account name to get wrong. |

### What you need configured

| Variable | Without it |
|---|---|
| `AIBROKER_FORGE_TOKEN` | The route is still created and the URL and secret are handed back for you to paste into the forge once. Needs repository write scope. |
| `AIBROKER_PUBLIC_HOST` | Falls back to the Tailscale funnel hostname, which is usually right. Only set it if that is wrong. |
| `AIBROKER_FORGE_BOT_LOGIN` | Nothing, in the normal case. The account is asked of the forge itself; this is only the fallback for a forge that will not answer `/user`. |

**Why the account is asked rather than configured.** It was configured once, and
on the first live write the configured name and the token's real account turned
out to be different. Nothing checked, and two rules failed silently in opposite
directions: the self-ignore filtered a login that never arrived, and the custody
rule on `close` compared against a name that had opened nothing. A name that
describes a credential should not be typed twice — the forge knows, so it is
asked.

**And why sharing your own credential is still fine.** If your sessions post as
you, no account name can separate "my own echo" from "a person wrote to me" —
filtering that account would silence exactly the comments the route exists to
carry. Echo suppression asks a different question, "did we just do this", which
does not depend on who signed it.

**Where echo suppression does NOT reach.** It knows about writes that went
through the daemon, because that is where the record is kept. A session with its
own script talking to the forge directly appears in no such record and will get
its own events back — which is fine when that script posts as a **separate bot
account**, because then the account filter above does the job properly. The two
mechanisms cover different cases and neither covers both:

| Written by | What stops the echo |
|---|---|
| `aibroker_issue` / `aibroker issue` | the write record — works whatever account it posts as |
| a repo-local script with its own bot credential | `ignore: sender.login=<bot>` |
| a repo-local script sharing your account | nothing; give it a bot account or route it through the daemon |

**Forges expand `issues` into sub-events.** Forgejo turns a request for `issues`
into `issues`, `issue_assign`, `issue_label` and `issue_milestone`. Coalescing
folds most of that into the parent issue; if a particular kind proves noisy in
practice, drop it with `ignore` rather than guessing in advance — a filtered
event is still recorded, so a route gone quiet can be told from one being
filtered.

---

## Writing back — `aibroker_issue`

A route is one-directional: the tracker reaches the session and the session has
nothing to answer with. `aibroker_issue` is the return leg, and it is deliberately
NOT a general forge client.

**Subscription is the permission.** A session may act on a repository exactly
when a route already delivers that repository to it, and a session can only ever
subscribe itself. So the reach of this tool is the reach of the mailbox the
session already had, and there is no parameter anywhere that lets a caller pick
someone else's. Both refusals say which one it is — not subscribed, or
subscribed to somebody else — because "denied" without which is a debugging
session.

```
aibroker_issue { repo: "https://forge.example/owner/name", verb: "list" }
aibroker_issue { repo: …, verb: "comment", issue: 12, body: "Measured: …" }
```

**The same verbs are on the command line**, and that is not a convenience. A
newly published MCP tool does not appear in a session that is already running,
and making it appear needs a person at the keyboard — so a session can be
holding a finding, with the tool published, and be unable to post it. A shell
needs nobody:

```bash
aibroker issue https://forge.example/owner/name list
aibroker issue <repo> comment --issue 12 --body -   # long text on stdin
```

It asks the daemon rather than the forge, so the permission check and the
record of what was just written both still apply. Identity comes from the
environment the shell was launched in: running it in a pane is asking as that
pane, and there is no flag to claim otherwise.

| Read | |
|---|---|
| `list` | open issues (or `state: closed`/`all`), each with who opened it |
| `get` | one issue: title, body, state, labels, assignees |
| `comments` | the thread; `count: N` for the newest N |
| `labels` | the label names this repository actually has |
| `assets` | attachments on an issue |

| Write | |
|---|---|
| `new` | open one (`title`, `body`) |
| `comment` | add to the thread |
| `amend` | correct a comment you wrote (`--comment ID`) |
| `rewrite`, `retitle` | change body or title |
| `label`, `unlabel` | only names that already exist — see below |
| `claim`, `release` | take or drop the assignment |
| `close` | only issues this account opened — see below |

### Four refusals worth knowing about

**Every write is read back**, and one that cannot be confirmed returns a
`WARNING: … treat as unconfirmed` beside its result rather than plain success. A
network call returns and carries on; a write that failed while the caller
believed it succeeded stays invisible until somebody needs what it said.

**`close` is restricted to issues this account opened.** Receiving events about a
tracker is not the same as owning what is in it. A session reports a fix and
leaves the tick to a person — the refusal says so, and says to comment instead.

**Written text says which session wrote it.** Where sessions and the operator
share one credential, every comment carries the same author and the tracker
keeps no trace of which came from a person — permission does not care, but a
reader in six months has only the ticket. A signature line is appended, naming
the session; `amend` replaces it rather than stacking a second.

**`amend` refuses a comment signed by another session**, even though the forge
would allow it: sharing an account is not sharing authorship.

**`claim` refuses work already assigned to somebody else**, so two workers cannot
quietly take the same item.

**`label` refuses a name the repository does not have.** Labels are a vocabulary
somebody chose; a tool that creates one on a typo produces `bugg` next to `bug`
and no error anywhere.

### Reading is paged, and that is the point

Forges answer fifty and say nothing about the rest. `list` and `comments` follow
every page, because a truncated listing reads exactly like a complete one — and
on a long thread, "the newest two" out of an unpaged fetch is silently the 49th
and 50th *oldest*.

`get` returns chosen fields rather than the forge's own object, which nests a
full user record — including an email address — that nothing here needs.

### Credentials

`AIBROKER_FORGE_TOKEN` takes either an API token or `user:password`; the second
is sent as Basic auth. Attachments need the same credential — a plain fetch of a
private asset answers "Not Found", which reads as a missing file rather than a
locked one.

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
