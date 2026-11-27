# App channel

A generic chat/talk pane inside an app (CaseLeaf first) as a channel next to PAILot, WhatsApp and Telegram. The hub types the pane's messages into a Claude session (ingress source `appchannel`, same trust as the operator's other channels) and routes the session's replies back to the pane.

Code: `src/adapters/appchannel/` (`protocol.ts` pure frames, `channel.ts` routing, `server.ts` WebSocket endpoint, `client.ts` reference client, all exported from the package).

## Env

| Var | Default | Meaning |
|---|---|---|
| `APPCHANNEL_PORT` | `0` (disabled) | listen port |
| `APPCHANNEL_BIND` | `0.0.0.0` | bind address; use the Tailscale or LAN address |
| `APPCHANNEL_TOKENS` | empty (disabled) | `app=token,app2=token2`; an app may repeat to allow several tokens |

Endpoint: `ws://<host>:<port>/appchannel`. Tokens are never logged.

## Auth

Static per-app token, sent in `hello`, compared in constant time. Run it over Tailscale (WireGuard-encrypted) or terminate TLS in front for `wss`. Bad token or unknown app: `error auth`, connection closed. The first frame must be `hello` within 5 s. Pairing like PAILot is a later option.

## Frames (JSON, `v:1`, max 64 KiB)

Client to hub:

- `hello {app, paneId, token}`
- `message {id, session, text, context?: {doc?: {fileId, page?, selection?, marks?: string[], title?}, extra?: {...}}}` (selection max 8 KiB, marks max 200)
- `confirm {actionId, approve}`
- `ping`

Hub to client:

- `ready {sessions?}`
- `reply {session, text, inReplyTo?}`
- `action {actionId, session, action: {kind: "reply"|"mark"|"revise"|string, args}, needsConfirm: true}`
- `ack {id}`
- `error {code, message}`: `auth`, `bad_frame`, `hello_required`, `hello_timeout`, `session_not_found`, `rate_limited`, `unknown_action`, `deliver_failed`
- `pong`

The text typed into the session is a single line: `[CaseLeaf:doc file=<id> page=3 marks=a,b] "selected text" user text`. Newlines are collapsed, brackets and control characters stripped from ids, the app name reduced to `[A-Za-z0-9_-]`. Without document context: `[CaseLeaf] user text`.

## Session addressing

Every `message` names its `session` explicitly. The pane remembers its session; which session is the default (e.g. one per project) is the app's decision. The hub only requires that the session exists (`session_not_found` otherwise).

## Replies

When a session answers (`pailot_send` or the AIBP text path), `AppChannel.reply(session, text)` sends a `reply` frame to every pane that has talked to that session in the last 30 min. With no such pane the reply is dropped. A pane limit of 30 messages/min applies (`rate_limited`).

## Confirm flow

`AppChannel.requestAction(session, {kind, args})` sends an `action` frame (always `needsConfirm: true`) to the panes of that session and returns a promise: `{approved}` after the pane's `confirm`, or `{timeout: true}` after 10 min. Only a pane that received the action may confirm it. AIBroker never applies document actions; the app applies them itself after the user approves. `requestAction` is an API only (no CLI/IPC verb yet).

## CaseLeaf integration notes

- Connect to the ws/wss URL over Tailscale, send `hello` with the app token, wait for `ready`.
- Send `message` with `context.doc`: file id, page, current selection and marks. The iPad has no terminal, so this pane is the entry point to the session.
- Render `reply` frames in the pane.
- On `action`, show the proposed change to the user; only after approve apply it through CaseLeaf's own CLI (reply/mark/revise) and send `confirm {approve:true}`; on deny send `approve:false`.
- Maps to CaseLeaf #805, #807, #802.

Reference client:

```ts
const c = new AppChannelClient();
await c.connect({ url, app: "CaseLeaf", paneId: "ipad-1", token });
c.onReply((r) => render(r.text));
c.onAction((a) => ask(a).then((ok) => c.confirm(a.actionId, ok)));
c.send(sessionId, "summarise this clause", { doc: { fileId, page: 3, selection } });
```
