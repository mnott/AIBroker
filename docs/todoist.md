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

### Tailscale Funnel (recommended)

**Funnel, not Serve.** Serve is reachable only from inside your tailnet, and Todoist's servers are not in it. This is the single easiest mistake to make.

```bash
tailscale funnel --bg --https=8443 http://127.0.0.1:8766
tailscale funnel status
```

Constraints worth knowing:

- Funnel listens only on **443, 8443 or 10000**.
- A port cannot be Serve and Funnel at the same time — if 443 is already a Serve, use 8443.
- Requires MagicDNS, HTTPS certs, and the `funnel` node attribute in your tailnet policy.

Your endpoint is then `https://<host>.<tailnet>.ts.net:8443/todoist`.

### Alternatives

Any of these work, since the receiver only needs a proxy that terminates TLS and forwards to `127.0.0.1:8766`:

- **Cloudflare Tunnel** — `cloudflared tunnel --url http://127.0.0.1:8766`
- **Caddy / nginx** on a real domain with Let's Encrypt
- **Direct exposure** — set `TODOIST_WEBHOOK_BIND=0.0.0.0`. The daemon logs a warning, because this puts an execution ingress straight on the network. Prefer a proxy.

---

## 2. Create the Todoist app

In Todoist: **Settings → Integrations → App Management → Add new integration**.

1. Name it (Todoist's brand rules forbid "Todoist" as the primary name — e.g. `AIBroker Bridge`).
2. Copy the **Client secret**. This signs the webhooks.
3. Set an **OAuth redirect URL** — any URL on your endpoint, e.g. `https://<host>.<tailnet>.ts.net:8443/oauth`. It does not need to serve anything, but the app cannot be authorised without one.
4. Open **Webhooks** and set:
   - **Callback URL**: `https://<host>.<tailnet>.ts.net:8443/todoist`
   - **Events**: `item:added`, `item:completed`, `reminder:fired`
5. **Save the settings**, then **activate the webhook**, then **install the app for yourself**.

> **Copy the client secret from the clipboard button, not by eye.** It is 32 hex characters and `0`/`4`/`d` are easy to transpose; a single wrong character means every webhook fails HMAC verification and is silently rejected as unsigned. Check `aibroker audit --action webhook` if deliveries never arrive.

> **Verify the settings persisted by reloading the page.** The settings form can report success while dropping the callback URL, the event checkboxes and the redirect URL. Reload and confirm all three are still there before moving on.

> The webhook only fires for accounts that have **installed** the app. If `Number of users: 0`, nothing will ever be delivered.

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
2. **The project it was filed in** — if that project has an `=owner` mapping. "Put it in the Whazaa list."
3. **`TODOIST_DEFAULT_OWNER`** — Inbox capture from a watch, where there is no project and no label.

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

```bash
# Signed requests only — unsigned must be refused
curl -s -o /dev/null -w "%{http_code}\n" -X POST -d '{}' \
  https://<host>.<tailnet>.ts.net:8443/todoist      # → 401
curl -s -o /dev/null -w "%{http_code}\n" -X POST -d '{}' \
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
