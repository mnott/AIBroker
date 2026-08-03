# Todoist as an inbound channel

File a task from your phone, your watch, or the web and it reaches the Claude session that owns it. No polling: Todoist pushes.

```
watch / phone / web
        │  task filed, or a reminder fires
        ▼
   Todoist cloud ──HTTPS+HMAC──▶ public endpoint ──▶ 127.0.0.1:8766 (aibroker daemon)
                                                          │
                                                    dispatch(project, body)
                                                          ▼
                                                  the owning Claude session
```

Every step is recorded in [the audit trail](../README.md#7-audit-what-one-session-did-to-another).

---

## Why webhooks, and why reminders matter

Polling forces a choice between latency and cost and gets both wrong. The decisive detail is that **`reminder:fired` is a webhook event**: a task with a reminder pushes *at* the reminder time.

Due dates do **not** push — a task merely becoming due fires nothing. So schedule work by setting a **reminder**, not a due date, and "run the sweep at 09:00" needs no timer anywhere in this system.

---

## Security model — read this before enabling

A task arriving here becomes an instruction a session acts on **with your full rights**. Todoist's own webhook payload documents that `initiator` may be *"a collaborator from a shared project"*. Without a boundary, anyone on any project shared with you has a path to your machine.

Four things constrain it:

| Control | Effect |
|---|---|
| **HMAC signature** | Every request must be signed with the app's client secret. Unsigned or wrongly signed → `401`, recorded. |
| **Project allowlist** | Only explicitly listed project IDs can reach a session. Everything else is acknowledged and dropped. |
| **Fail closed** | An empty allowlist accepts *nothing*, and the daemon refuses to start the receiver at all. |
| **Loopback bind** | The receiver listens on `127.0.0.1`. Something else terminates TLS in front of it. |

The allowlist is deliberately **explicit rather than a resolved subtree**: a project you add later does not silently become an execution ingress: it has to be granted.

Todoist's **Inbox cannot be shared**, which is why including it is safe and why it is the natural target for quick capture from a watch.

---

## 1. Expose an HTTPS endpoint

Todoist calls from the public internet, so the endpoint must be publicly reachable. The receiver binds to loopback and expects a TLS terminator in front.

Two hard constraints decide everything here:

| Constraint | Consequence |
|---|---|
| **Todoist silently refuses any URL with a port.** | The endpoint must be on **443**. `https://host:8443/todoist` is *accepted by the form and never saved* — no error, the webhook simply stays *Not configured*. |
| **Serve is tailnet-only; Todoist calls from the public internet.** | Port 443 must be **Funnel**, not Serve. |

Together those mean: **Funnel on 443, no port in the URL.** This is the single easiest thing to get wrong, and both halves fail quietly.

### Tailscale Funnel

```bash
tailscale funnel --bg --https=443 --set-path=/todoist http://127.0.0.1:8766/todoist
tailscale funnel status
```

Constraints worth knowing:

- Funnel listens only on **443, 8443 or 10000** — and only 443 gives a portless URL.
- A port cannot be Serve and Funnel at the same time. If 443 is already a tailnet-only Serve, moving it to Funnel makes **every path on that port public**; move anything that should stay private to another port first.
- Requires MagicDNS, HTTPS certs, and the `funnel` node attribute in your tailnet policy.

Your endpoint is then `https://<host>.<tailnet>.ts.net/todoist`.

You also need a **tailnet-only Serve on 443** for the OAuth landing, because Todoist rejects a redirect URL that carries a port:

```bash
tailscale serve --bg --https=443 --set-path=/oauth http://127.0.0.1:8766/oauth
```

### Alternatives

Any of these work, since the receiver only needs a proxy that terminates TLS and forwards to `127.0.0.1:8766`:

- **Cloudflare Tunnel** — `cloudflared tunnel --url http://127.0.0.1:8766`
- **Caddy / nginx** on a real domain with Let's Encrypt
- **Direct exposure** — set `TODOIST_WEBHOOK_BIND=0.0.0.0`. The daemon logs a warning, because this puts an execution ingress straight on the network. Prefer a proxy.

---

## 2. Create the Todoist app

> **Once created, this app is load-bearing — do not delete it.** It is the only thing that makes Todoist an inbound channel: the daemon authenticates as it, its webhook carries every `[Task]` work order, and its client secret signs every delivery. The App Management console gives no hint of this, because the app does nothing *visible* — it looks exactly like an experiment somebody started and abandoned. On 2026-08-03 it was nearly deleted for that reason. Deleting it silently ends every phone-to-session route until the whole of section 2 is redone and the account re-authorised.

In Todoist: **Settings → Integrations → App Management → Add new integration**.

1. Name it (Todoist's brand rules forbid "Todoist" as the primary name — e.g. `AIBroker Bridge`).
2. Copy the **Client ID** and the **Client secret**. The secret signs the webhooks; the id is needed for the OAuth step below.
3. Set an **OAuth redirect URL**: `https://<host>.<tailnet>.ts.net/oauth` — **no port**.
4. Open **Webhooks** and set:
   - **Callback URL**: `https://<host>.<tailnet>.ts.net/todoist` — **no port here either**
   - **Events**: `item:added`, `item:completed`, `reminder:fired`

> **Neither URL field accepts a port, and they fail differently.** The redirect URL says so — *"Invalid URL"* under the field. The callback URL says nothing at all: the form accepts the text, `Activate webhook` appears to do nothing, and the status stays *Not configured* forever. If activation seems broken, the port is the first thing to remove.
5. **Save the settings**, then **activate the webhook**.

> **The save button is at the bottom of the dialog and is easy to miss entirely.** `Save settings` lives in a sticky footer inside the settings modal. If the browser window is shorter than the modal, that footer is clipped off-screen and there appears to be no way to save at all — the form then looks like it "silently drops" everything you type. Zoom out (`⌘-`) until the footer with `Cancel` / `Save settings` is visible before filling anything in.

> **Fill the app fields first, save, and only then touch the Webhooks block.** Editing the OAuth redirect URL re-renders the webhook sub-form and clears the callback URL and every event checkbox without saying so.

> **Copy the client secret from the clipboard button, not by eye.** It is 32 hex characters and `0`/`4`/`d` are easy to transpose; a single wrong character means every webhook fails HMAC verification and is silently rejected as unsigned. Check `aibroker audit --action webhook` if deliveries never arrive.

> **Verify the settings persisted by reloading the page.**

> `Number of users` in the console is not a reliable signal — it can read `0` for an account that has genuinely authorised the app. Trust `aibroker todoist status` instead.

---

## 2a. Authorise the account — the step that is easy to miss

**Todoist does not deliver webhooks to the account that created the app.** Delivery is switched on per user when that user completes the OAuth flow, and the console's *Install for myself* button is not that flow. An app that is listed under *Installed* can still have authorised nobody.

Todoist's own guidance is to run the flow by hand: open the authorize URL, read the `code` out of the address bar with developer tools, then exchange it from something that can POST. That instruction describes a missing endpoint — so the daemon serves it:

```bash
aibroker todoist auth                       # prints the authorize URL, mints a state
aibroker todoist auth --scope data:read_write,data:delete   # if the bridge should delete tasks
```

Open the URL, approve, and Todoist returns you to the redirect URL. The daemon answers it: it checks the state, makes the token exchange itself, stores the token at `~/.aibroker/todoist-oauth.json` (mode `0600`), and tells you on the page whether it worked. The token value is never logged and never enters the audit trail — only the fact of an authorisation and its scope.

```bash
aibroker todoist status
```

```
Authorised 2026-08-02T12:49:42.948Z
Scope: data:read_write
Expires: 2026-08-02T13:49:42.949Z (54 min)
Refresh: automatic — refreshed on demand before it expires
Live check: OK — the token works right now.
```

**The live check is the point.** Reading the stored file answers "did we ever authorise", not "does it work" — and for twenty hours this command reported `Authorised` while every call returned `401`. The one command you would run to diagnose a lapsed grant said everything was fine.

`401` with `error_code 477` means the token is invalid or expired. If the app has **refresh tokens disabled**, Todoist issues tokens with no refresh path and no `expires_in`, and the only remedy when one dies is re-authorising by hand — which is why a grant appeared to lapse twice in twenty hours. Enable refresh tokens on the app in the App Management console and the daemon renews them itself.

The attempt is good for 15 minutes and for exactly one callback. A callback with no pending authorisation behind it is refused *before* the client secret is spent.

Start narrow with those three events. Add more once loop behaviour is proven — `note:added` in particular is what agent comments trigger.

---

## 3. Find your project IDs

```bash
curl -s -H "Authorization: Bearer $TODOIST_API_TOKEN" \
  https://api.todoist.com/api/v1/projects | jq -r '.results[] | "\(.id)  \(.name)"'
```

Or ask any session with the Todoist MCP for `find-projects`.

---

## 3a. Granting a project, while you are using it

The allowlist began as one environment variable read at daemon start. Grants can also be made at runtime, which is what makes "create me a project and let me talk to that session" a thing you can ask for rather than a file edit and a restart:

```bash
aibroker todoist ingress list
aibroker todoist ingress add <projectId>=<owner> --name "Claude 🤖/Whazaa"
aibroker todoist ingress remove <projectId>
```

Effective on the next webhook, no restart. Every change is recorded in the audit trail, because granting a project the right to execute in your sessions is exactly the kind of change that should be.

**Deleting the project revokes its grant automatically.** A grant outliving the thing it points at reads as though access is still open — and if the id were ever reused, it silently would be. The boundary only ever shrinks on its own.

**Sub-projects are folders, not owners** — but only if you say so. A project nested under an allowed one is *not* automatically allowed: organising tasks into `Jobs Matthias / Executive Search 🎯` moves them outside the allowlist and every one is refused, silently, precisely when someone tidies up.

```bash
aibroker todoist ingress add <rootId>=<owner> --subtree
```

grants the project **and every project nested under it, at any depth**, each inheriting the root's owner. A folder is not a second owner.

**A granted root often has no owner** — `Claude 🤖` is a container, not a session — and its children are named after the sessions they serve: `Home`, `SL`, `Whazaa`. In that case a child takes **its own name** as its owner, matched against running sessions and configured aliases with separators folded, so `Jobs Matthias` resolves to `jobs-matthias`. An ancestor that *does* name an owner still wins, because `Executive Search 🎯` under `Jobs Matthias` belongs to jobs-matthias rather than to a session of its own. A name matching nothing leaves the owner unset and the ordinary rules apply — inventing an owner from an unrecognised name would be worse than falling through.

Names are read from the project tree **by id**. Todoist's project search returns nothing for names containing emoji, so anything resolving a project by name would report one that plainly exists as absent.

Still opt-in, and the residual risk is worth stating plainly: a project shared with you and later moved under a granted root inherits execution rights nobody considered for it. Grant subtrees to roots you own.

Without `--subtree`, a grant covers exactly one project, which is the old behaviour and remains the right default for anything shared.

Resolution keys on **project id, never on name**. Todoist's project search returns nothing for names containing emoji — `Executive Search 🎯` is invisible to a name query — so a resolver that fell back to matching names would report "no such project" for one that plainly exists.

**Owner names must be dispatchable.** An owner is a curated PAI alias, not merely the title of a running tab. A grant pointing at a name dispatch cannot resolve looks perfectly configured and routes nowhere; the audit says `unlaunchable`, which is the only sign you get.

---

## 4. Configure the daemon

In `~/.aibroker/env`:

```bash
# Client secret from the App Management Console. Signs every webhook.
TODOIST_CLIENT_SECRET=<32-hex-client-secret>
# Client id from the same page. Only used by the OAuth landing.
TODOIST_CLIENT_ID=<32-hex-client-id>
# TODOIST_OAUTH_PATH=/oauth        # must match the registered redirect URL

TODOIST_WEBHOOK_PORT=8766
TODOIST_WEBHOOK_PATH=/todoist
# TODOIST_WEBHOOK_BIND=127.0.0.1   # only change behind your own firewall

# Explicit allowlist: "<projectId>[=owner]", comma-separated.
# With an owner, tasks filed there route to that session.
# Without one, they fall through to TODOIST_DEFAULT_OWNER.
TODOIST_INGRESS_PROJECTS=<inboxId>,<busRootId>,<projectId>=whazaa,<projectId>=telex

# Where an Inbox task with no label goes — the watch case.
# Leave unset to drop unroutable tasks instead of guessing.
TODOIST_DEFAULT_OWNER=broker
```

Restart the daemon and confirm:

```
todoist-webhook: listening on 127.0.0.1:8766/todoist, 4 ingress project(s), default owner broker
```

If instead you see `not configured` or `TODOIST_INGRESS_PROJECTS is empty — refusing to accept every project`, the receiver is deliberately not running.

---

## 5. How a task is routed

Most explicit wins:

1. **A `pai:<name>` label** — `pai:whazaa` goes to the Whazaa session wherever it was filed *within the allowlist*.
2. **A name at the front of the text** — `pai send a whatsapp message` goes to the PAI session, and the address is stripped so the session receives `send a whatsapp message`.
3. **The session already holding the task** — a comment follows the work it belongs to.
4. **The project it was filed in** — if that project has an `=owner` mapping. "Put it in the Whazaa list."
5. **A bare `<name>` label** — one tap in Todoist's picker, but *below* the project mapping.
6. **`TODOIST_DEFAULT_OWNER`** — Inbox capture from a watch, where there is no project, no label and no name.

**A bare label ranks below the project, and that ordering was paid for.** A task moved from Clickr into the AIBroker project kept its old `clickr` label; the label won, and a comment meant for AIBroker was delivered to Clickr with nothing anywhere reporting a conflict. A label survives a move. A project mapping is a standing decision about that project. When they disagree, the container is the better evidence and the label is most likely a leftover — and the disagreement is recorded in the audit as a near miss rather than resolved in silence.

`pai:<name>` still outranks everything, because typing the prefix is a deliberate act where a tap may be years old.

Text beats project deliberately: what you wrote is more considered than where quick-capture happened to put it.

### Addressing by text

A label costs several taps on a phone and more on a watch. The first word of what you were going to type anyway costs nothing:

```
pai send a whatsapp message      → PAI session, body "send a whatsapp message"
clickr: check the permissions    → Clickr session ("name:" and "name," also work)
Buy milk on the way home         → default owner, text untouched
```

Two rules keep this from misfiring:

- **Only names already known are accepted** — running sessions plus every owner in `TODOIST_INGRESS_PROJECTS`. Otherwise `Home improvements` becomes a work order for the Home session.
- **A one-word task is never an address.** There would be nothing left to act on.

An owner named in config is addressable even when its session isn't running: the task routes and delivery reports that nobody is home, which is more useful than reading the word as prose.

### Near misses

`@pai do x` as plain text, a `PAI` label, a `pai` label — each *looks* like an instruction about where the task should go, none of them parse, and all three used to land on the default owner in silence. A request that isn't honoured is now recorded:

```
aibroker audit --action webhook
```

The record carries `nearMiss` alongside the `rule` that actually chose the owner, so "it went somewhere unexpected" is answerable after the fact rather than a matter of memory. The task is still delivered — a routing miss must not swallow the work.

A label **cannot** smuggle a task in from outside the allowlist. The boundary is the project; the label only chooses among sessions you already trust.

### Create, then classify

Filing a task first and labelling it second is the common workflow, and it used to fall through a hole: at `item:added` the task is not yet routable and is correctly ignored, while the event that *makes* it routable is an `item:updated` — which is not actionable. The event that mattered was precisely the one nothing subscribed to.

`item:updated` is now acted on for exactly one thing: the **transition from unroutable to routable**. Routable means both halves hold — the task is in an ingress project *and* names an owner.

| Change | Result |
|---|---|
| `pai:<name>` label added to a task in an ingress project | dispatched |
| task moved into an ingress project, already labelled | dispatched |
| renamed, re-described, re-prioritised while already routable | ignored |
| edited while still unroutable | ignored |
| an update reporting a completion | ignored — completion is its own event |
| our own `pai-running` claim write | ignored — not a routing label, routability unchanged |

Subscribing to `item:updated` wholesale would be worse than the gap it closes: every edit would become a work order. A transition is not an event type, and that distinction is the whole safety property.

Todoist supplies `event_data_extra.old_item` for updates a user made directly. Without it there is nothing to compare, so the update is ignored — acting would mean dispatching on an edit that cannot be characterised.

### What is ignored

| Situation | Why |
|---|---|
| Project not in the allowlist | The security boundary |
| `item:completed` | Completion is you saying *done* — it must never start work, **unless** it is a recurring task carrying a `pai:<name>` label (see below). A completion hook may still run; see §7a. |
| Content starting with 🤖 | Written by an agent; ignored to prevent echo loops |
| Empty task content | Nothing to act on |
| No owner and no default | Refuses to guess |
| A repeated delivery | Todoist retries; work must not run twice |

A delivered task carries a `[todoist:<taskId> in:<projectId>]` trailer so the session can answer on it and file follow-ups in the right place. When more than one open task in the project shares a title, the body also carries a warning: two identically named tasks are indistinguishable in a list, so an answer posted on one is — to whoever is watching the other — indistinguishable from being ignored.

---

## 6. Verify

**Test from outside the tailnet, or you are not testing anything.** MagicDNS resolves your Funnel hostname to its *tailnet* address, so a plain `curl` from your own machine connects peer-to-peer on `100.x` and never touches the Funnel ingress. It returns a perfectly convincing `401` while the public path is completely untested. Force the public address:

```bash
dig +short @8.8.8.8 <host>.<tailnet>.ts.net       # → 185.40.x.x (Funnel ingress)

# Signed requests only — unsigned must be refused, over the PUBLIC path
curl -s -o /dev/null -w "%{http_code}\n" -X POST -d '{}' \
  --resolve <host>.<tailnet>.ts.net:8443:<ingress-ip> \
  https://<host>.<tailnet>.ts.net:8443/todoist      # → 401
curl -s -o /dev/null -w "%{http_code}\n" -X POST -d '{}' \
  --resolve <host>.<tailnet>.ts.net:8443:<ingress-ip> \
  https://<host>.<tailnet>.ts.net:8443/wrong        # → 404
```

Then file a task in an ingress project and watch it arrive:

```bash
aibroker audit --action webhook --bodies
```

```
16:04:11 [a1b2c3d4] you@example.com ⇒ Whazaa  webhook:delivered
       | Run the sweep
```

Nothing arriving at all usually means the webhook was never activated, or the app has no installed users.

---

## 7. Answering, and the loop that must not happen

A task is often a question. The answer belongs on the task, not in a terminal the asker is not looking at.

```
todoist_reply(taskId, text)     # posts a comment; does NOT complete the task
```

Every delivery carries what a reply needs:

```
[todoist:<taskId> in:<projectId>]
```

Completion is deliberately left to the human. An answer nobody has read is not done, and a completed task drops out of the list taking its comments with it.

### The checkbox as a Run Now button

Ticking a **recurring** task does not close it — Todoist advances the due date and the task stays open. That makes the checkbox a natural trigger, and `item:completed` arrives within a second, unambiguously.

So completion dispatches when **all three** hold:

- the task **recurs** — completing it is a reschedule, not an ending
- it carries an explicit **`pai:<name>` label** — it was built to be dispatched
- it does **not** carry `pai-running` — a runner has already claimed this tick

Everything else about completion is unchanged. Ticking off a one-off task, or a recurring one with no routing label, starts nothing: get that wrong and finishing something starts the thing you thought you were finishing.

**Creating a trigger does not fire it.** A recurring, labelled task filed into an ingress project is a *definition* — adding a crontab line does not run the job. It runs when its reminder fires, or when you tick it. Without that rule, filing a click-to-run task dispatches it once on creation and again on the first tick: one intent, two runs, half a second apart.

**A failed claim is recorded, not just logged.** The claim write can fail — a `401` means the token is invalid or expired — and when it does the dispatch still proceeds, because refusing to run the work because a label write failed is the worse trade. But the outcome is audited either way (`todoist-claim: claimed` / `failed`), since a successful claim and a failed one were otherwise indistinguishable from outside: the label is simply absent, and an unclaimed dispatch is exactly what a poller reads as a fresh request. On a `401` the token is refreshed and the write retried once. Todoist's guidance is explicit — *"do not wait and retry the same invalid or expired token"* — so the `retry_after` in the body is backoff metadata, not an invitation to present the same credential again. Where there is no refresh token, nothing helps and the error says to re-authorise.

**Whichever path dispatches also claims the task.** The webhook adds `pai-running` before dispatching and removes it again if the dispatch never landed. Honouring another runner's claim is only half an interlock — a path that dispatches and leaves the task unclaimed lets the next poller see an advanced due date with nothing on it, conclude the box was ticked, and run the same work again.

**A finished run releases its own claim** — after completing the task, not before. `todoist_reply(taskId, text, {release: true})` posts the answer and removes `pai-running`, but only while the task is **not overdue**. Until then the release is refused, with the reason in `releaseRefused`.

The risk being guarded is precise: a task that is *unclaimed and overdue* is ordinary overdue work, and the next poll dispatches it. Finishing is two steps that are not atomic and the ordering is not enforceable from here, so the state is checked rather than trusted. Refusing early makes the failure "a claim stuck until a timer releases it", which is the direction to fail in.

The test is *"is it still overdue"*, deliberately, and not *"has the due date advanced past the occurrence recorded at claim time"*. The latter breaks the moment anything legitimately moves the date **backwards** — a manual trigger consumes a scheduled occurrence, and restoring it is a correct repair that would otherwise make this refuse a release on a run that genuinely finished. A stuck claim caused by a repair.

"Cannot tell" — no due date, or the task cannot be read — allows the release, because a guard that strands a session unable to clear its own claim is the same silence one step along. Nothing else here takes it off on success — the webhook only releases on a failed dispatch or at the deadline — so a session that finishes and says nothing leaves the trigger suppressed until its next occurrence: one silently missed run, indistinguishable from a run nobody asked for.

**A claim nobody comes back for is released** — at the next occurrence, less a small margin. A session that dies mid-turn would otherwise leave the trigger claimed forever: the webhook skips it, and the routine is dead until someone notices it stopped.

The deadline is the *next scheduled run*, not a duration, and that distinction is the whole design. A claim that survives into the next occurrence blocks the very trigger it was guarding, so the occurrence is the real bound — and Todoist has already told us where it is, since completing a recurring task advances the due date before the event reaches us.

A fixed window cannot do this job. Anything flat sits behind an adaptive per-task timer only for short tasks and *in front of it* for long ones, so the less informed release fires first: a four-hour sweep with a three-hour window has its claim released mid-run, and the next poll — seeing an unclaimed, overdue task — starts a second one alongside it. That is the duplicate the interlock exists to prevent, produced by the backstop.

Nothing is released in its first two hours, so a run may overrun its own period once. With no known occurrence, twelve hours — a number chosen to clear an adaptive poller's default rather than to be right.

Elapsed time only, never "the session looks gone": the hub has returned an empty session list while nineteen sessions were running, and a recovery that trusts that spawns a duplicate per task. Releasing twice is harmless — removing an absent label is a no-op — which is why two releasers are safe where two dispatchers would not be.

`pai-running` is the interlock between mechanisms. A poller that claims a tick sets it before doing anything else, so a crash leaves the task visibly in flight rather than silently dispatched twice — and the webhook path honours it, because two mechanisms watching one checkbox must not both fire.

### Filing work for yourself — later, yes; instantly, no

Scheduling your own work is the point of this channel. A click-to-run task with a recurrence — *"Job sweep — run it and mail me the list, every day at 08:00"* — is agent-authored on purpose and must fire when its time comes.

What must not happen is the **write bouncing straight back**. A task a session creates in an ingress project fires `item:added` immediately, routing dispatches it, and the session receives its own note as a work order it never asked for. On 2026-08-01 a session probing due-date parsing handed itself twelve test tasks in four minutes.

So the 🤖 mark suppresses the *echo*, not the task:

| Event | Marked content |
|---|---|
| `item:added` | dropped — this is the write bouncing back |
| `note:added` | dropped — same, for comments |
| `reminder:fired` | **delivered** — the schedule is why the task exists |

```
todoist_task(content, {projectId, description, dueString})
```

applies the mark. Reach for a raw Todoist tool only for projects that reach nobody. As with replies, the mark is applied by the writer rather than trusted to the caller — "remember the prefix" is not a safety mechanism.

Due dates still fire nothing. If you want a task to come back to you, give it a **reminder**.

### Do not create a project you already have

A session knows itself by its alias, `jobs-matthias`. The project a human made for it is called `Jobs Matthias`. A session comparing those literally finds nothing and creates a second project; work then splits across two lists and the human watches the wrong one.

```
todoist_ingress(action: "resolve", owner: "jobs-matthias")
→ { found: true, projectId: "…", projectName: "Claude 🤖/Jobs Matthias" }
```

Resolve before creating. Owner matching folds separators, so every written form of the name finds the same project.

### A hook for the moment a box is ticked

Completion dispatches nothing, by design. But it is not nothing: the comment thread on a ticked task leaves every list at that instant, and a one-off task disappears from any "open tasks" query entirely — so a poller cannot see it either. There is no second chance.

```bash
# ~/.aibroker/env
TODOIST_ON_COMPLETED=/usr/local/bin/pai task archive {taskId} --quiet
```

Unset by default. `{taskId}` is substituted; the command runs **without a shell**, because the id arrives from the internet and a shell would make it part of a command line.

**Give an absolute path.** Under launchd the daemon's `PATH` is `/usr/local/bin:/usr/bin:/bin` — no Homebrew, no node global bin — so a bare command name that works in your terminal may simply not exist here.

**The exit code is the contract.** A non-zero exit is recorded as `hook-failed` with the stderr tail; success is recorded as `archived` rather than `ignored`. A hook that failed quietly would turn "recorded, no action taken" into a claim about something that did not happen, which is the one thing the audit trail exists to prevent.

### Never open a blocking prompt for a channel message

A multi-select or any modal freezes the session, and whoever sent the task is not at that terminal to answer it. Decide routine choices and say which you took; if it genuinely needs the human, ask **on the channel** with `todoist_reply` and stop. A question on a task can be answered from a phone. A modal cannot.

---

## Turning it off

```bash
tailscale funnel --https=8443 off          # close the public endpoint
```

Removing `TODOIST_CLIENT_SECRET` from `~/.aibroker/env` and restarting stops the receiver; deleting the app in Todoist stops the pushes at source.

---

## Notes and limits

- **Attachments** are not consumed yet. Todoist supports images on comments, so photograph-a-business-card is possible, but the receiver currently forwards task title and description only.
- **Comment-back** is not implemented. When an agent writes progress notes onto a task, prefix them with 🤖 so the receiver ignores its own echo, and subscribe to `note:added` only once that is in place.
- **Bodies are recorded in full** in the audit trail, including anything a task contains. If you file secrets into a task, they are on disk in `~/.aibroker/audit.jsonl`.
