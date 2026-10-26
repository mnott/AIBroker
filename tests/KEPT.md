# Kept tests

Tests are governed: a test file stays only with evidence. (a) a real product bug it guarded (fixing commit), (b) it pins a security guard or destructive-operation block, (c) it pins an external contract other software depends on. One-time tests are discarded after use. Add a file here with its evidence or do not commit it. Run the core with `npm test` (`--test-concurrency=2`). `test/home-guard.ts` is the preload that redirects HOME; `test/linux/` holds the documented VM/Docker acceptance scripts.

| File | Class | Evidence |
| --- | --- | --- |
| test/inbound-signature.test.ts | b | webhook signature verification on the inbound route (8eac204) |
| test/todoist-webhook.test.ts | a,b | Todoist webhook HMAC check, claim and dispatch (d4675f0, 31065f5, 285e6f9) |
| test/todoist-oauth.test.ts | a,b | OAuth token handling and state check (d7c0475) |
| test/todoist-reply.test.ts | a | reply writes with the account credentials, no webhook echo loop (2ab8556, 3a1a46a) |
| test/inbound-echo.test.ts | a | a session never receives its own issue write back through the route (dfe2825) |
| test/a2a-schema.test.ts | c | A2A message/task schema other agents depend on |
| test/a2a-server.test.ts | c | A2A server endpoints and agent card, the wire peers call |
| test/aibp.test.ts | c | AIBP envelope wire protocol shared with PAILot |
| test/mqtt-broker-control-routing.test.ts | a,c | pailot/control/in reaches the control branch, not the session regex (8a293c2) |
| test/dispatch.test.ts | a | dispatch targets the right session/project (666ab09, d7c0475, 31065f5) |
| test/send-to-session-identity.test.ts | a | send_to_session identity; failed enumeration is not "not found" (9abd729) |
| test/name-authority.test.ts | a,b | user-chosen name outranks generated ones, so name-targeted sends hit the right session (9abd729, 0324273) |
| test/attach-routing.test.ts | a | names and PAILot routing follow the live attach pane |
| test/exited-session-safety.test.ts | a,b | never type into a shell left by an exited Claude (666ab09) |
| test/launch-guard.test.ts | a,b | launch refuses unsafe targets (9abd729) |
| test/drain-mailbox-worker-guard.test.ts | b | a worker never drains the pane owner's mailbox |
| test/pointer-guard.test.ts | b | pointer never typed into an input line with unsent text |
| test/manage-type-guard.test.ts | a,b | manager never types into the wrong pane or over operator text (ffb625f, fa10c02) |
| test/manage-operator-only.test.ts | b | only the operator can end or shorten a goal |
| test/shell-injection.test.ts | a,b | shell/AppleScript injection escaping (6e5631e) |
| test/home-guard.test.ts | b | tests cannot touch the real home directory |
| test/source-hygiene.test.ts | a | no invisible bytes (NUL) in source, shipped in two releases (3bdba07) |
| test/json-store.test.ts | a | durable state files must not overwrite themselves with an empty default (1d50424) |
| test/persistence.test.ts | a | session registry and voice config never delete themselves (d4675f0, 7265d38, 6b07e99) |
| test/session-names-durability.test.ts | a | session-names.json loss makes projects unroutable (1d50424) |
| test/message-queue.test.ts | a | PAILot queue: 95 MB buffered messages must not be lost (61f48f4) |
