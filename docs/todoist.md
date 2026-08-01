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
Authorised 2026-08-01T15:40:29.589Z
Scope: data:delete,data:read_write
```

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
3. **The project it was filed in** — if that project has an `=owner` mapping. "Put it in the Whazaa list."
4. **`TODOIST_DEFAULT_OWNER`** — Inbox capture from a watch, where there is no project, no label and no name.

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

### What is ignored

| Situation | Why |
|---|---|
| Project not in the allowlist | The security boundary |
| `item:completed` | Completion is you saying *done* — it must never start work |
| Content starting with 🤖 | Written by an agent; ignored to prevent echo loops |
| Empty task content | Nothing to act on |
| No owner and no default | Refuses to guess |
| A repeated delivery | Todoist retries; work must not run twice |

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
