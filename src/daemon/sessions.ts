/**
 * daemon/sessions.ts — `aibroker sessions <cmd>`.
 *
 * Snapshot / restore / checkpoint the set of open Claude Code sessions so they
 * survive a reboot. A reboot kills sessions without an `/exit`, so:
 *   1. `checkpoint` (before a planned reboot) tells each session to persist state,
 *   2. `snapshot` (auto, every 5 min) records each open session's name + directory,
 *   3. `restore` (after login) reopens each in its own iTerm2 tab and runs `go`.
 *
 * THE MANIFEST IS A REGISTRY, NOT A MIRROR.
 * An earlier version rewrote the manifest with exactly the sessions that were open
 * at snapshot time. That destroys itself at the worst possible moment: shutting
 * down is precisely when the live set drains to zero, so the 5-minute agent would
 * happily persist `[]` over a good restore list. (Observed: five consecutive
 * "Snapshotted 0 session(s)" while the user was /exit-ing tabs by hand.)
 *
 * So: snapshot MERGES by cwd and stamps `lastSeen`. A session that disappears
 * stays in the manifest — that's the whole point of a restore list. Entries leave
 * only by explicit `forget` or by `prune` on age. Every write keeps a `.bak`.
 *
 * Subcommands:
 *   snapshot                                  merge open sessions -> manifest
 *   restore    [--dry-run] [--only NAME]      reopen every session in a new tab
 *   checkpoint [--message M] [--only NAME] [--dry-run] [--timeout S]
 *                                             ask each to save state, VERIFIED
 *   list [--verbose]                          show the manifest
 *   forget NAME                               drop an entry
 *   prune [--older-than DAYS] [--dry-run]     drop entries not seen in a while
 *   install | uninstall                       manage the 5-min snapshot LaunchAgent
 */
import { execFileSync, execSync } from "node:child_process";
import { writeFileSync, readFileSync, existsSync, mkdirSync, copyFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, basename, dirname } from "node:path";
import { createHash } from "node:crypto";
import { WatcherClient } from "../ipc/client.js";
import { captureSession, typeIntoSession } from "../transport/sync-facade.js";
import { DAEMON_SOCKET_PATH } from "./index.js";

const HOME = homedir();
const AIBROKER_DIR = join(HOME, ".aibroker");
const MANIFEST = join(AIBROKER_DIR, "session-restore.json");
const MANIFEST_BAK = `${MANIFEST}.bak`;
const AGENT_LABEL = "com.aibroker.sessions-snapshot";
const AGENT_PLIST = join(HOME, "Library", "LaunchAgents", `${AGENT_LABEL}.plist`);

/** Entries unseen this long are prune candidates. Never auto-pruned. */
const DEFAULT_PRUNE_DAYS = 30;

interface DaemonSession { sessionId: string; name?: string; paiName?: string; kind?: string; }

interface Entry {
  name: string;
  cwd: string;
  /** ISO timestamp of the last snapshot that saw this session open. */
  lastSeen?: string;
  /** ISO timestamp of the first snapshot that ever saw it. */
  addedAt?: string;
}

/** On-disk shape. v1 was a bare Entry[]; readManifest() accepts both. */
interface Manifest { version: number; entries: Entry[]; }

// ── manifest I/O ────────────────────────────────────────────────────────────

function readManifest(): Manifest {
  if (!existsSync(MANIFEST)) return { version: 2, entries: [] };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(MANIFEST, "utf-8"));
  } catch (err) {
    // A corrupt manifest must never look like an empty one — that would let the
    // next snapshot "merge" into nothing and silently discard the restore list.
    throw new Error(`Manifest at ${MANIFEST} is not valid JSON (${(err as Error).message}). ` +
      `Fix it or restore from ${MANIFEST_BAK}; refusing to continue.`);
  }
  if (Array.isArray(raw)) return { version: 2, entries: raw as Entry[] }; // v1
  const m = raw as Partial<Manifest>;
  return { version: 2, entries: Array.isArray(m.entries) ? m.entries : [] };
}

/** Write with a .bak of the previous content. The only path that touches the file. */
function writeManifest(entries: Entry[]): void {
  mkdirSync(AIBROKER_DIR, { recursive: true });
  if (existsSync(MANIFEST)) {
    try { copyFileSync(MANIFEST, MANIFEST_BAK); } catch { /* best effort */ }
  }
  const payload: Manifest = { version: 2, entries };
  writeFileSync(MANIFEST, JSON.stringify(payload, null, 2) + "\n");
}

async function liveSessions(): Promise<DaemonSession[] | null> {
  // null (not []) on failure — the caller MUST distinguish "daemon unreachable"
  // from "genuinely nothing open", or an outage looks like a clean desk.
  try {
    const res = await new WatcherClient(DAEMON_SOCKET_PATH).call_raw("sessions", {});
    const list = (res as { sessions?: DaemonSession[] }).sessions;
    return Array.isArray(list) ? list : null;
  } catch {
    return null;
  }
}

/** id -> tty for every open iTerm2 session (";"-delimited to dodge newline issues). */
function ttyMap(): Record<string, string> {
  const script = `tell application "iTerm2"
  set out to ""
  repeat with w in windows
    repeat with t in tabs of w
      repeat with s in sessions of t
        set out to out & (id of s) & "|" & (tty of s) & ";"
      end repeat
    end repeat
  end repeat
  return out
end tell`;
  const raw = execFileSync("osascript", ["-e", script], { encoding: "utf-8" });
  const m: Record<string, string> = {};
  for (const pair of raw.split(";")) {
    const [id, tty] = pair.split("|");
    if (id && tty) m[id.trim()] = tty.trim();
  }
  return m;
}

/** tty -> cwd of the `claude` process (authoritative; $HOME is valid). */
function cwdForTty(tty: string): string | null {
  const base = tty.replace("/dev/", "");
  let out: string;
  try { out = execSync(`ps -t ${base} -o pid=,comm=`, { encoding: "utf-8" }); } catch { return null; }
  const procs: { pid: string; comm: string }[] = [];
  for (const line of out.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(.*)$/);
    if (m) procs.push({ pid: m[1], comm: m[2] });
  }
  const getCwd = (pid: string): string | null => {
    try {
      return execSync(`lsof -a -d cwd -p ${pid} -Fn 2>/dev/null`, { encoding: "utf-8" })
        .split("\n").find((l) => l.startsWith("n"))?.slice(1) || null;
    } catch { return null; }
  };
  const claudeProc = procs.find((p) => /(^|\/)claude$/.test(p.comm));
  if (claudeProc) {
    const cwd = getCwd(claudeProc.pid);
    if (cwd && cwd.startsWith("/")) return cwd;
  }
  for (const p of procs) {
    const cwd = getCwd(p.pid);
    if (cwd && cwd !== HOME && cwd.startsWith("/") && !cwd.startsWith(join(HOME, ".claude"))) return cwd;
  }
  return null;
}

/** PAI-style launch: --name label + advance-entered "/Name <name>\ngo". */
function launchCmd(cwd: string, name: string): string {
  const sq = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
  const ansiC = name.replace(/'/g, "");
  const prompt = `$'/Name ${ansiC}\\\\ngo'`; // \\n survives AppleScript literal -> \n -> zsh newline
  return `cd ${sq(cwd)} && claude --name ${sq(name)} --dangerously-skip-permissions ${prompt}`;
}

function osascript(osa: string): void { execFileSync("osascript", ["-e", osa]); }

function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }

function hash(s: string): string { return createHash("sha1").update(s).digest("hex"); }

/**
 * Merge identity for an entry.
 *
 * NOT cwd alone. Several distinct sessions legitimately share a directory —
 * "Home" and "Solar" both live in $HOME, "Jobs Matthias" has numbered siblings —
 * and keying on cwd silently collapses them, so restore reopens one and drops
 * the rest. Losing a session is worse than the cost of this choice: renaming a
 * session leaves its old name behind as a twin, which `prune` ages out and
 * `forget` removes on demand.
 */
function keyOf(name: string, cwd: string): string { return `${name}\u0000${cwd}`; }

/**
 * Union `fresh` (what is open right now) into `existing` (the restore list).
 *
 * Pure and exported so the property that actually matters is testable: this
 * never returns fewer entries than `existing`. Every historical way of losing
 * the manifest — /exit-ing tabs one by one, a daemon outage, an iTerm restart —
 * reaches this function as a small or empty `fresh`, and must be a no-op rather
 * than a truncation.
 */
export function mergeEntries(existing: Entry[], fresh: Entry[], now: string): Entry[] {
  const pending = new Map<string, Entry>();
  for (const e of fresh) pending.set(keyOf(e.name, e.cwd), e);

  const merged = existing.map((e) => {
    const k = keyOf(e.name, e.cwd);
    if (!pending.has(k)) return e; // not open now — keep it; that IS the point
    pending.delete(k);
    return { ...e, lastSeen: now };
  });
  for (const e of pending.values()) merged.push(e);
  return merged;
}

function ago(iso?: string): string {
  if (!iso) return "never";
  const days = (Date.now() - Date.parse(iso)) / 86_400_000;
  if (!Number.isFinite(days)) return "never";
  if (days < 1) return "today";
  if (days < 2) return "1d ago";
  return `${Math.floor(days)}d ago`;
}

// ── subcommands ─────────────────────────────────────────────────────────────

/**
 * Merge the currently-open sessions into the manifest. Never removes anything.
 * Returns null when the live set could not be determined (nothing was written).
 */
async function doSnapshot(): Promise<{ merged: Entry[]; seen: number } | null> {
  const sessions = await liveSessions();
  if (sessions === null) {
    console.error("Daemon unreachable — manifest left untouched.");
    return null;
  }

  const ttys = ttyMap();
  const now = new Date().toISOString();
  const fresh: Entry[] = [];
  for (const s of sessions) {
    if (s.kind !== "claude") continue;
    const tty = ttys[s.sessionId];
    if (!tty) continue;
    const cwd = cwdForTty(tty);
    if (!cwd) continue;
    fresh.push({ name: s.paiName || basename(cwd), cwd, lastSeen: now, addedAt: now });
  }

  const merged = mergeEntries(readManifest().entries, fresh, now);
  writeManifest(merged);
  return { merged, seen: sessions.filter((s) => s.kind === "claude").length };
}

async function doRestore(opts: { dryRun: boolean; only?: string }): Promise<void> {
  if (!existsSync(MANIFEST)) {
    console.error(`No manifest at ${MANIFEST} — run 'aibroker sessions snapshot' first.`);
    process.exit(1);
  }
  let entries = readManifest().entries;
  if (opts.only) entries = entries.filter((e) => e.name.toLowerCase().includes(opts.only!.toLowerCase()));
  let n = 0;
  for (const e of entries) {
    if (!e?.cwd || !e?.name) continue;
    if (!existsSync(e.cwd)) { console.error(`  skip (missing dir): ${e.cwd}`); continue; }
    if (opts.dryRun) { console.log(`  would open  ${e.name.padEnd(24)} ${e.cwd}`); n++; continue; }
    const esc = launchCmd(e.cwd, e.name).replace(/"/g, '\\"');
    osascript(`tell application "iTerm2"
  activate
  if (count of windows) = 0 then create window with default profile
  tell current window
    set newTab to (create tab with default profile)
    tell current session of newTab to write text "${esc}"
  end tell
end tell`);
    console.log(`  reopened ${e.name.padEnd(24)} ${e.cwd}`);
    n++;
    execSync("sleep 1"); // stagger so iTerm/claude don't stampede
  }
  console.log(opts.dryRun ? `Would reopen ${n} session(s).` : `Reopened ${n} session(s).`);
}

export type AckResult = "ok" | "no-ack" | "no-settle" | "unreadable";

/** Injected so the ack state machine can be tested against a simulated terminal. */
export interface SessionProbe {
  capture: (id: string) => string | null;
  send: (id: string, text: string) => void;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  onRetry?: (attempt: number, of: number) => void;
}

export const POLL_MS = 500;
/** Consecutive identical frames that mean "Claude stopped writing". */
export const SETTLE_TICKS = 4;
/** Distinct frames required before we believe the prompt was actually SUBMITTED. */
export const ACK_TRANSITIONS = 2;

/**
 * Send `message` to one session and prove it was consumed.
 *
 * A successful `write text` only means keystrokes reached the terminal — not
 * that Claude accepted the prompt. That gap is exactly what leaves you walking
 * to every tab by hand after a hiccup. So we watch the screen instead.
 *
 * The subtlety: "the screen changed" is NOT proof of submission. Text typed into
 * Claude's input box changes the screen too, so a send whose Enter was swallowed
 * looks identical to a successful one for one frame — and then freezes. We
 * therefore require ACK_TRANSITIONS *distinct* frames: a working Claude animates
 * (spinner, streaming tokens) and trivially clears the bar, whereas text sitting
 * unsubmitted in the box produces exactly one change and then stillness, so it
 * correctly fails and retries.
 *
 *   1. send, then poll for ACK_TRANSITIONS distinct frames -> genuinely submitted
 *   2. poll until SETTLE_TICKS identical frames            -> Claude finished
 *
 * Frame-diffing is deliberately content-agnostic: it never parses what `pause
 * session` prints, so it keeps working when that output changes.
 */
export async function sendVerified(
  sessionId: string,
  message: string,
  opts: { timeoutMs: number; retries: number },
  probe: SessionProbe,
): Promise<AckResult> {
  const before = probe.capture(sessionId);
  if (before === null) return "unreadable";

  let acked = false;
  for (let attempt = 1; attempt <= opts.retries && !acked; attempt++) {
    probe.send(sessionId, message);

    const seen = new Set<string>([hash(before)]);
    const ackDeadline = probe.now() + Math.min(8000, opts.timeoutMs);
    while (probe.now() < ackDeadline) {
      await probe.sleep(POLL_MS);
      const frame = probe.capture(sessionId);
      if (frame !== null) seen.add(hash(frame));
      // seen includes the pre-send frame, so N transitions == N+1 members.
      if (seen.size > ACK_TRANSITIONS) { acked = true; break; }
    }
    if (!acked && attempt < opts.retries) probe.onRetry?.(attempt + 1, opts.retries);
  }
  if (!acked) return "no-ack";

  // Wait for the reply to finish rather than for any particular string.
  const settleDeadline = probe.now() + opts.timeoutMs;
  let last = hash(probe.capture(sessionId) ?? "");
  let still = 0;
  while (probe.now() < settleDeadline) {
    await probe.sleep(POLL_MS);
    const cur = hash(probe.capture(sessionId) ?? "");
    if (cur === last) {
      if (++still >= SETTLE_TICKS) return "ok";
    } else {
      still = 0;
      last = cur;
    }
  }
  return "no-settle";
}

/** The real terminal, wired to whichever transport owns the session. */
const liveProbe = (log: (s: string) => void): SessionProbe => ({
  capture: (id) => captureSession(id, 60),
  send: (id, text) => { typeIntoSession(id, text); },
  sleep,
  now: () => Date.now(),
  onRetry: (attempt, of) => log(`      no response, retry ${attempt}/${of}…`),
});

async function doCheckpoint(opts: {
  message: string; only?: string; dryRun: boolean; timeoutMs: number;
}): Promise<void> {
  // Capture BEFORE asking anyone to pause. This is the authoritative record of
  // the working set, taken while every session is still alive — never leave it
  // to the periodic agent, which may not tick again before you shut down.
  if (!opts.dryRun) {
    const snap = await doSnapshot();
    if (snap) console.log(`Manifest updated: ${snap.merged.length} entr(ies) on record.\n`);
    else console.log("Warning: could not refresh the manifest (daemon unreachable).\n");
  }

  const self = (process.env.ITERM_SESSION_ID || "").split(":").pop() || "";
  const sessions = await liveSessions();
  if (sessions === null) { console.error("Daemon unreachable — cannot checkpoint."); process.exit(1); }

  const targets = sessions.filter((s) => {
    if (s.kind !== "claude") return false;
    if (s.sessionId === self) return false; // don't checkpoint the terminal we're in
    const label = s.paiName || s.name || s.sessionId;
    return !opts.only || label.toLowerCase().includes(opts.only.toLowerCase());
  });

  if (opts.dryRun) {
    for (const s of targets) console.log(`  would checkpoint  ${s.paiName || s.name || s.sessionId}`);
    console.log(`Would checkpoint ${targets.length} session(s).`);
    return;
  }

  const failed: { label: string; why: AckResult }[] = [];
  let ok = 0;
  for (const s of targets) {
    const label = s.paiName || s.name || s.sessionId;
    process.stdout.write(`  ${label.padEnd(24)} → "${opts.message}" … `);
    const res = await sendVerified(
      s.sessionId,
      opts.message,
      { timeoutMs: opts.timeoutMs, retries: 3 },
      liveProbe((m) => console.log(m)),
    );
    if (res === "ok") { console.log("saved"); ok++; }
    else {
      const why = res === "no-ack" ? "NO RESPONSE" : res === "no-settle" ? "STILL BUSY" : "UNREADABLE";
      console.log(why);
      failed.push({ label, why: res });
    }
  }

  console.log(`\n${ok}/${targets.length} session(s) checkpointed.`);
  if (failed.length) {
    console.log(`\n${failed.length} need a look before you reboot:`);
    for (const f of failed) {
      const hint = f.why === "no-ack" ? "never reacted — check the tab is at a prompt"
        : f.why === "no-settle" ? "still working — give it longer, or --timeout"
        : "could not read the tab";
      console.log(`  ${f.label.padEnd(24)} ${hint}`);
    }
    console.log(`\nRetry just those:  aibroker sessions checkpoint --only "<name>"`);
    process.exitCode = 1;
  } else {
    console.log("All sessions saved. Safe to reboot.");
  }
}

function doForget(name: string): void {
  const entries = readManifest().entries;
  const lower = name.toLowerCase();
  const keep = entries.filter((e) => e.name.toLowerCase() !== lower && e.cwd !== name);
  if (keep.length === entries.length) {
    console.error(`No manifest entry matching "${name}".`);
    process.exit(1);
  }
  writeManifest(keep);
  console.log(`Forgot ${entries.length - keep.length} entr(ies); ${keep.length} remain.`);
}

function doPrune(opts: { days: number; dryRun: boolean }): void {
  const entries = readManifest().entries;
  const cutoff = Date.now() - opts.days * 86_400_000;
  const stale = entries.filter((e) => e.lastSeen && Date.parse(e.lastSeen) < cutoff);
  if (!stale.length) { console.log(`Nothing unseen for ${opts.days}+ days.`); return; }
  for (const e of stale) console.log(`  ${opts.dryRun ? "would drop" : "dropped"}  ${e.name.padEnd(24)} ${ago(e.lastSeen)}`);
  if (opts.dryRun) { console.log(`Would drop ${stale.length} entr(ies).`); return; }
  const keep = entries.filter((e) => !stale.includes(e));
  writeManifest(keep);
  console.log(`Dropped ${stale.length}; ${keep.length} remain.`);
}

function installAgent(): void {
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>${AGENT_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${process.execPath}</string>
        <string>/usr/local/bin/aibroker</string>
        <string>sessions</string>
        <string>snapshot</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict><key>PATH</key><string>/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
    <key>StartInterval</key><integer>300</integer>
    <key>RunAtLoad</key><true/>
    <key>StandardOutPath</key><string>/tmp/aibroker-sessions-snapshot.log</string>
    <key>StandardErrorPath</key><string>/tmp/aibroker-sessions-snapshot.log</string>
</dict>
</plist>
`;
  mkdirSync(dirname(AGENT_PLIST), { recursive: true });
  writeFileSync(AGENT_PLIST, plist);
  const uid = process.getuid?.() ?? 0;
  try { execSync(`launchctl bootout gui/${uid}/${AGENT_LABEL} 2>/dev/null`); } catch { /* not loaded */ }
  execSync(`launchctl bootstrap gui/${uid} ${AGENT_PLIST}`);
  console.log(`Installed ${AGENT_LABEL} (snapshot every 5 min) -> ${AGENT_PLIST}`);
}

function uninstallAgent(): void {
  const uid = process.getuid?.() ?? 0;
  try { execSync(`launchctl bootout gui/${uid}/${AGENT_LABEL} 2>/dev/null`); } catch { /* not loaded */ }
  try { execSync(`rm -f "${AGENT_PLIST}"`); } catch { /* gone */ }
  console.log(`Removed ${AGENT_LABEL}.`);
}

function usage(): void {
  console.log(`aibroker sessions — snapshot/restore/checkpoint open Claude sessions

  snapshot                                    merge open sessions (name + dir) into the manifest
  restore    [--dry-run] [--only NAME]        reopen every session in its own iTerm2 tab
  checkpoint [--message M] [--only NAME] [--dry-run] [--timeout SECONDS]
                                              ask every open session to persist state and WAIT
                                              for each to finish (default message: "pause session",
                                              default timeout: 120s per session)
  list       [--verbose]                      show the current manifest
  forget NAME                                 drop an entry from the manifest
  prune      [--older-than DAYS] [--dry-run]  drop entries not seen in DAYS (default ${DEFAULT_PRUNE_DAYS})
  install | uninstall                         manage the 5-min auto-snapshot LaunchAgent (${AGENT_LABEL})

The manifest is a registry, not a mirror: closing a session does NOT remove it.
Entries leave only via 'forget' or 'prune'. Every write keeps a .bak.

Reboot flow:  aibroker sessions checkpoint  →  reboot  →  aibroker sessions restore`);
}

// ── dispatcher ──────────────────────────────────────────────────────────────

export async function runSessions(args: string[]): Promise<void> {
  try {
    await dispatch(args);
  } catch (err) {
    // A stack trace here is noise: the failures that reach this point (an
    // unparseable manifest, an unwritable ~/.aibroker) are things the user has
    // to go fix by hand, so print the sentence that tells them how.
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}

async function dispatch(args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  const has = (f: string) => rest.includes(f);
  const val = (f: string) => { const i = rest.indexOf(f); return i >= 0 ? rest[i + 1] : undefined; };
  /** `Number(x) || fallback` would turn a deliberate 0 into the default. */
  const num = (f: string, fallback: number): number => {
    const raw = val(f);
    if (raw === undefined) return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) throw new Error(`${f} expects a non-negative number, got "${raw}"`);
    return n;
  };

  switch (sub) {
    case "snapshot": {
      const snap = await doSnapshot();
      if (!snap) { process.exitCode = 1; break; }
      console.log(`Snapshotted ${snap.seen} open session(s); ${snap.merged.length} on record -> ${MANIFEST}`);
      for (const e of snap.merged) console.log(`  ${e.name.padEnd(24)} ${ago(e.lastSeen).padEnd(9)} ${e.cwd}`);
      break;
    }
    case "restore":
      await doRestore({ dryRun: has("--dry-run"), only: val("--only") });
      break;
    case "checkpoint":
      await doCheckpoint({
        message: val("--message") ?? "pause session",
        only: val("--only"),
        dryRun: has("--dry-run"),
        timeoutMs: num("--timeout", 120) * 1000,
      });
      break;
    case "list": {
      if (!existsSync(MANIFEST)) { console.log("(no manifest yet — run 'aibroker sessions snapshot')"); break; }
      const entries = readManifest().entries;
      console.log(`${entries.length} session(s) in ${MANIFEST}:`);
      for (const e of entries) {
        const seen = has("--verbose") ? `${ago(e.lastSeen).padEnd(9)} ` : "";
        console.log(`  ${e.name.padEnd(24)} ${seen}${e.cwd}`);
      }
      break;
    }
    case "forget": {
      const name = rest.find((a) => !a.startsWith("--"));
      if (!name) { console.error("Usage: aibroker sessions forget NAME"); process.exit(1); }
      doForget(name);
      break;
    }
    case "prune":
      doPrune({ days: num("--older-than", DEFAULT_PRUNE_DAYS), dryRun: has("--dry-run") });
      break;
    case "install": installAgent(); break;
    case "uninstall": uninstallAgent(); break;
    case "help": case "--help": case "-h": case undefined: usage(); break;
    default:
      console.error(`Unknown: aibroker sessions ${sub}`);
      usage();
      process.exit(1);
  }
}
