/**
 * daemon/audit-cli.ts — `aibroker audit` — read the cross-session trail.
 *
 * Reads the file directly rather than going through the daemon: an audit trail
 * you cannot inspect when the daemon is down is not much of an audit trail.
 */
import { readAudit, auditPath, resolveBody, type AuditEvent } from "./audit.js";

function usage(): void {
  console.log(`aibroker audit — what one session did to another

  aibroker audit [--session NAME] [--action A] [--trace ID]
                 [--since ISO] [--limit N] [--bodies] [--json]

  --session NAME   only events where NAME acted or was acted upon
  --action A       send | dispatch | ask | launch | refuse
  --trace ID       follow one causation chain, both directions
  --since ISO      events at or after this timestamp (e.g. 2026-08-01)
  --limit N        last N events (default 40)
  --bodies         print full message bodies, not one-line previews
  --json           raw JSONL, for piping

Log: ${auditPath()}

Causation (--trace) is a heuristic: an action is attributed to the last
message its actor received. It reconstructs A→B→C chains in the ordinary
case; it is not proof that the message caused the action.`);
}

const ICON: Record<string, string> = {
  send: "→", dispatch: "⇒", ask: "?", launch: "+", refuse: "✗",
};

function oneLine(s: string, max = 100): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * The time an event happened, on the clock the reader is looking at.
 *
 * The file stores UTC, which is right — it is compared, sorted and moved
 * between machines. Printing that UTC time to a terminal is not. Every other
 * reading an operator takes while investigating is local: `date`, the manager's
 * status, the forge's own timestamps. Rendering this one in UTC put a silent
 * two-hour offset between lines of the same investigation, and on 2026-09-01 it
 * cost real time — an audit line at 11:51 was compared against a forge comment
 * at 13:51 and read as an hour and a half apart when they were two seconds.
 *
 * A clock that is wrong announces itself. A clock that is right in a different
 * zone does not, and the reader does the arithmetic without knowing they should.
 */
function localTime(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso.slice(11, 19); // unparseable: show what is stored
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`;
}

function render(e: AuditEvent, bodies: boolean): void {
  const time = localTime(e.ts);
  const icon = ICON[e.action] ?? "·";
  const chain = e.causedBy ? ` ⟵${e.causedBy}` : "";
  console.log(`${time} [${e.id}]${chain} ${e.actor} ${icon} ${e.target}  ${e.action}:${e.outcome}`);
  if (e.reason) console.log(`         ${oneLine(e.reason, 110)}`);
  if (e.body) {
    if (bodies) {
      // Pull the full text back from its sidecar when the line only holds a preview.
      const full = resolveBody(e) ?? e.body;
      for (const l of full.split("\n")) console.log(`       | ${l}`);
    } else {
      const more = e.bodyRef ? ` [+${(e.bodyBytes ?? 0) - e.body.length}B — see --bodies]` : "";
      console.log(`       | ${oneLine(e.body)}${more}`);
    }
  }
  const reply = e.meta?.reply;
  if (typeof reply === "string") console.log(`       < ${bodies ? reply : oneLine(reply)}`);
}

export async function runAudit(args: string[]): Promise<void> {
  const has = (f: string) => args.includes(f);
  const val = (f: string) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };

  if (has("--help") || has("-h")) { usage(); return; }

  const rawLimit = val("--limit");
  const limit = rawLimit !== undefined ? Number(rawLimit) : 40;
  if (!Number.isFinite(limit) || limit < 0) {
    console.error(`--limit expects a non-negative number, got "${rawLimit}"`);
    process.exitCode = 2;
    return;
  }

  const events = readAudit({
    session: val("--session"),
    action: val("--action"),
    trace: val("--trace"),
    since: val("--since"),
    // A trace is a whole chain; truncating it to the tail would hide the origin,
    // which is the part you opened it for.
    limit: has("--trace") ? undefined : limit,
  });

  if (has("--json")) {
    for (const e of events) console.log(JSON.stringify(e));
    return;
  }

  if (events.length === 0) {
    console.log(`No matching events in ${auditPath()}`);
    return;
  }

  const bodies = has("--bodies");
  for (const e of events) render(e, bodies);
  console.log(`\n${events.length} event(s). Follow a chain with: aibroker audit --trace <id>`);
}
