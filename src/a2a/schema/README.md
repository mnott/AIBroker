# Vendored A2A schema subset

Source: https://a2a-protocol.org/v0.3.0/specification/
Retrieved: 2026-09-05
Protocol version declared by this implementation: `"0.3.0"`

This is NOT the full A2A schema. It is the subset AIBroker's A2A server and
client actually produce or consume: `AgentCard` (name/description/url/
provider/version/capabilities/securitySchemes/security/skills/default
modes), `AgentSkill`, `AgentExtension`, `Task`/`TaskStatus`/`TaskState`,
`Message`, `TextPart` (the only `Part` kind emitted — `FilePart` and
`DataPart` are accepted on read as opaque per the spec's `Part` union but
never produced), and `Artifact`. Fields the spec defines but this project
never sets (gRPC bindings, `AgentInterface`/`additionalInterfaces`,
`AgentCardSignature`, push notifications, streaming) are out of scope and
not validated.

`types.ts` — the TypeScript shapes, each field commented with the spec
section it came from (section numbers as rendered on the page above, e.g.
"5.5 AgentCard Object", "6.1 Task Object", "6.4 Message Object", "6.5.1
TextPart Object", "6.7 Artifact Object", "8. Error Handling").

`validate.ts` — a small dependency-free structural validator for exactly
this subset: required fields present, correct primitive types, enums
constrained to the spec's `TaskState` values. It is not a JSON Schema
engine and does not attempt to validate the parts of the spec this project
does not use.

Method names: v0.3.0 uses `message/send`, `tasks/get`, `tasks/cancel`
(slash-separated, lowercase). An earlier pre-0.2 draft used `tasks/send`
for what is now `message/send`; this server accepts `tasks/send` as an
alias so an older client is not silently refused. The well-known discovery
path is `/.well-known/agent-card.json` (spec section on Agent Card
Discovery / IANA well-known URI registration).

Error codes are the standard JSON-RPC 2.0 codes plus the A2A-specific
range (`-32001`..`-32007`), both listed verbatim in `types.ts` from the
spec's "8.1 Standard JSON-RPC Errors" and "8.2 A2A-Specific Errors"
tables.

If a future change to this project needs a field not vendored here, add it
to `types.ts` with its section citation and extend `validate.ts` — do not
guess a shape from memory.
