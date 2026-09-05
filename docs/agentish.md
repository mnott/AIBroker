# Agentish v2 (AG2)

The wire format sessions use to talk to each other — a manager arming a
worker, a worker reporting back, one session asking another a question. Not
for the operator, and not for git: those stay prose. AG2 is for the traffic
between agents, where every report is budget spent before any work happens.

## Why

Prose restates the task to prove it was understood, hedges where a fact would
do, and buries the one field a reader needs — did the gate pass — inside a
paragraph. AG2 replaces that with a kind line and `k=v` lines using
one-letter keys, so:

- a report costs as few tokens as the facts it carries,
- a reader (machine or human) can check it instead of parsing it, and
- claiming success is a token (`r=+`) a validator can hold you to, not a tone.

## The spec

This is the format itself, as it is told to every session that must speak it:

```
AG2. msg=kind line+k=v lines. kinds T R S Q A X. keys i id g goal o own n forbid d steps p proof u out l limits r res c changes t tests G gate I inst m images # nums w worst x next z note(<200ch). sep |. outcomes + - ~ ? !. @n=path declared once then reused; @n:12=file:line. tests as Name+ Name-. no prose, no articles, never restate, unknown=?. r=+ only if all t +.
```

This string is exported as `AG2_SPEC` from `src/agentish/index.ts` — a
dependency-free module, so it can be lifted into its own package with a
directory move once the format stops changing shape. `src/daemon/agentish.ts`
re-exports the same names for anything already importing that path. AG2_SPEC
is prepended to every arming a managed session receives — see
`docs/managed-sessions.md`.

### Extensions beyond the spec

`src/agentish/index.ts` also accepts one field the string above does not
mention:

```
AG2.1 extension: y why(≤600ch)
```

`why` (`y=`) gives a report room to explain a result that is not a plain
pass — accepted only in `R`, `Q` and `X`. This is this validator's own
addition, not (yet) part of the sibling project's spec — see Origin, below.
`aibroker agentish spec` prints both lines; `spec --json` carries them as
separate fields.

## Reading a message

The first line is the kind (`T` task, `R` report, `S` status, `Q` question,
`A` answer, `X` refusal). Every line after it is `key=value`, one per line,
in any order. A line starting with `@` and containing `=` is not a field —
it declares a symbol (`@1=/path/to/repo`), so later lines and later messages
in the same thread can write `@1` instead of repeating the path. `@1:42`
means file `@1`, line 42.

Multi-part values inside one field (`chg`, `own`, `do`, …) are separated with
`|`. `test` is the one exception: its entries are space-separated —
`test=Name+ Name-` — each ending in an outcome character: `+` pass, `-` fail,
`~` partial, `?` unknown, `!` blocked. `res` and `gate` are each a single
outcome character, not a list.

Carrying AG2 over A2A instead of AIBroker's own IPC: see
`docs/a2a-agentish-extension.md`.

### A task (`T`)

```
T
i=fix-flaky-retry
g=stop test/retry.test.ts flaking under load
o=@1=/repo/src/net/retry.ts
d=read @1, reproduce under load, fix, add a regression test
p=paste the failing run, then the fixed run
u=R with c=@1:lines t=RegressionAdded+ RetryTest+ G=+/-
t=RegressionAdded+ RetryTest+
```

`t=` here is the contract: whatever `R` comes back must name exactly these
tests — see "The T ↔ R test-set check", below.

### A report (`R`)

```
R
i=fix-flaky-retry
res=+
chg=@1:88 widened the backoff jitter window
test=RegressionAdded+ RetryTest+
gate=+
p=pasted the passing run
```

`res=+` here is only accepted because `gate=+`, `p` is non-empty, and every
named test passed — see "Proof gating", below. Reporting a `-` or a `~`
instead requires a `y=` explaining why; so does naming a `worst=` issue.

## CLI

```
aibroker agentish spec [--json]                       the format, plus the extensions this validator adds
aibroker agentish check <file|-> [earlier...] [--json] validate a message; earlier messages supply @n symbols
aibroker agentish measure <file> <prose-file>          token count, agentish vs. a prose twin
aibroker agentish stats [--since YYYY-MM-DD] [--json]  AG2 vs. prose on real traffic — see "Measuring", below
```

Without `--json`, `check` prints one `ERR ...` line per problem, then a
one-line summary (`T 6 fields 1 symbols ok`). `-` reads the message from
stdin. With `--json`, `check` prints:

```json
{"version":"2","kind":"T","fields":{"...":"..."},"errors":[{"code":"E_REQUIRED","message":"T requires t","line":1}],"ok":false}
```

`spec --json` prints `{"version":"2","spec":"...","extensions":"...","uri":"urn:aibroker:a2a:ext:agentish:2"}`.

**Exit codes** (`check`, `measure`): `0` the message is valid, `1` it parsed
but failed validation, `2` the invocation itself was wrong — bad usage, or a
file that could not be read. This distinction exists so a CI step can tell
"the message you gave me is bad" from "I couldn't even read what you gave
me" without parsing stderr.

## Validator rules

Every failure carries a stable `code` — part of the contract once a CI
pipeline depends on it, so a code is added here when a new check is added,
never repurposed for a different one.

| Check | Code | Message |
|---|---|---|
| message has no non-blank lines | `E_EMPTY` | `empty message` |
| first line is not `T R S Q A X` | `E_KIND` | `unknown kind "…"; one of T R S Q A X` |
| more than 25 non-blank lines | `E_TOO_LONG` | `N lines > 25` |
| a line is neither `@n=path` nor `key=value` | `E_PARSE` | `not k=v: "…"` |
| the same field appears twice | `E_DUP` | `duplicate key K` |
| a field this kind requires is missing | `E_REQUIRED` | `KIND requires k` |
| a field this kind does not accept | `E_KEY` | `unknown key K` |
| `id`/`res`/`gate`/`num`/`img`/`chg` fails its shape rule | `E_SHAPE` | `k: bad shape` (or, for `test`, `test: every entry ends with + - ~ ?`) |
| a `chg` entry names an `@n` never declared | `E_REF_UNDECLARED` | `chg uses undeclared symbol @n` |
| `res=+` without gate `+`, non-empty `p`, and every test `+` | `E_R_UNPROVEN` | `r=+ without proof` |
| `res` is `-`/`~`, or `worst` is set, with no `y` | `E_REQUIRED` | `R requires y` |
| `note` over 200 characters | `E_Z_LEN` | `note > 200 chars (restating the task)` |
| `why` over 600 characters | `E_Y_LEN` | `y > 600 chars (extension field too long)` |
| an `R`'s `test` names differ from the matching `T`'s | `E_T_OMITTED` / `E_T_UNREQUESTED` | `t omitted: Name` / `t unrequested: Name` |

Shape rules: `id` matches `^[a-z0-9][\w.-]*$`; `res` and `gate` are each one
outcome character; `num` holds only digits, `,`, `.` and spaces; each
`|`-separated `img` entry contains `/` or ends `.png`/`.jpg`/`.jpeg`/`.pdf`;
each `|`-separated `chg` entry contains an `@ref` or a `/`.

### Proof gating

`res=+` is a claim this validator holds a message to, not a tone: it is
rejected unless `gate=+`, `p` (`prove`) is non-empty, and every `test` entry
also ends `+`. Reporting `res=-` or `res=~`, or naming a `worst=` issue,
requires `y=` — otherwise a partial result reads exactly like one nobody
looked at.

### The T ↔ R test-set check

When an `R` shares its `id` with an earlier `T` in the same `check` call
(the `T` passed via `earlier`), the two `test` fields are compared by name,
ignoring outcome: every name the `T` asked for must appear in the `R`
(`t omitted: Name` if not), and the `R` may not name a test the `T` never
asked for (`t unrequested: Name`). This is what makes "ran a test that was
never in the plan" and "silently skipped one that was" both visible to a
validator instead of only to a careful reader.

## Measuring

`agentish measure` compares one message against a prose twin somebody wrote
to make the point — a demonstration, not a measurement. `agentish stats`
reads the real audit log instead: every `send` between two sessions is
already recorded there (`src/daemon/audit.ts`), body included, so
`agentishStats()` (`src/daemon/agentish-stats.ts`) classifies each one by
running it through the actual validator — `ag2` only if `check()` finds no
errors and recognises the kind — and reports counts, mean and median tokens
per class, a ratio, and a per-day table.

**What is measured**: real inter-session `send` traffic, classified by the
same code that would reject a malformed AG2 message — not a hand-picked
pair, and not a shape guess.

**What is not measured**: semantic loss. A shorter message that omits
context a reader needed is not a win this number can see; the ratio says
nothing about whether either side actually communicated.

**The token heuristic, and its bias**: `approxTokens` in
`agentish-stats.ts` is `ceil(chars / 4) + half a token per run of
non-alphanumeric characters` — no tokenizer dependency, so it is a proxy,
not a real count. AG2 is dense with `|`, `@`, `=` and other punctuation that
this heuristic undercounts relative to a real tokenizer, more than it
undercounts prose. That means the printed ratio **understates** AG2's true
cost — it is a floor on the real saving, never a ceiling. `formatStatsReport`
prints this caveat every time, next to the number, not instead of it.

**Reading the ratio**: `prose mean tokens / ag2 mean tokens`. `1.0` means no
saving; higher means AG2 is cheaper; the true saving is at least this much,
given the bias above. Every `send` before **2026-09-05** predates AG2 and is
counted as prose regardless of its shape — the format did not exist yet, so
nothing from before that date can honestly be called AG2.

```
aibroker agentish stats --since 2026-09-05
```

## Use in CI

A team with no AIBroker daemon can still run the validator: it lives in one
dependency-free module (`src/agentish/index.ts`), so vendoring that file (or,
once split out, installing it as its own package) is enough for a CI step
that checks a message file before it goes anywhere:

```sh
node dist/daemon/cli.js agentish check message.txt --json
echo "exit: $?"   # 0 valid · 1 invalid content · 2 bad usage or unreadable file
```

Branch on `errors[].code` from the JSON output rather than on `message` text
— codes are the stable part of this contract (see the table above); messages
may be reworded.

## Origin

This validator is a port. A sibling project's Python tool
(`tools/agentish.py`) worked out the shape of the base checks first; only the
keys AIBroker's `AG2_SPEC` actually declares are carried over here. `why`
(the AG2.1 extension), proof gating, the T ↔ R test-set check, and the
`--json`/error-code CLI surface are this project's own additions — not yet
proposed back to the sibling, and not guaranteed to match it field for field
until they are.
