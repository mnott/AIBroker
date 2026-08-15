/**
 * daemon/manage.ts — keep a session working on a standing objective.
 *
 * THE PROBLEM THIS SOLVES. A session driven by a goal decides at the end of a
 * cycle whether the goal was met, and then stops. Left alone it stops for the
 * night; re-armed, it works for as long as you let it. Two nights of running
 * that by hand produced sixteen hours of unattended work and a list of ways the
 * arrangement breaks, all of which are answered here.
 *
 * WHY IT LIVES IN THE DAEMON RATHER THAN IN A SESSION. The first version was a
 * script driven from another Claude session, which worked and cost that session
 * its whole context — and worse, talking to the manager meant interrupting the
 * manager, because observing occupied the same turn the instruction would have
 * arrived on. An instrument that consumes the channel it is watched through
 * cannot be redirected without being stopped. So: a process with a mailbox.
 * Writing to a mailbox never requires the reader to be idle.
 *
 * WHAT IT DOES NOT DO. It does not judge the work. It re-arms an objective, it
 * carries one-shot instructions from the operator into the next arming, and it
 * says what it did. Everything requiring judgement stays with the person.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";
import { log } from "../core/log.js";
import { readSessionContent } from "./session-content.js";
import { typeIntoSession } from "../transport/sync-facade.js";
import { discoverLiveSessions } from "../core/session-discovery.js";

const STATE_FILE = join(homedir(), ".aibroker", "managers.json");

/** How often every manager is looked at. Cheap: one content read per managed session. */
const TICK_MS = 20_000;

/**
 * A session with no goal is not working on one, whatever else it is doing.
 *
 * The first version also required a long silence, and that never fired: a
 * session answering messages moves its transcript and resets any quiet timer,
 * so the loop waited for a silence that conversation kept postponing. The grace
 * below exists only to avoid arming in the middle of the turn that just ended
 * the last goal.
 */
const NO_GOAL_GRACE_MS = 30_000;

/** Never re-arm twice inside this window, whatever the signals say. */
const REARM_COOLDOWN_MS = 90_000;

/**
 * How long an armed goal is believed before the manager stops waiting for it.
 *
 * Not a timeout on the work. A ceiling on the manager's willingness to sit on a
 * signal that may never arrive — an item can legitimately end without the
 * marker clearing, and a loop with no ceiling waits forever while every
 * heartbeat reads healthy.
 */
const GOAL_MAX_AGE_MS = 45 * 60_000;

/**
 * The status-line marker shown while a goal is armed.
 *
 * IT IS A PROXY AND IT LIES. Read off the terminal, it does not clear when the
 * goal is met — it once read "active" for ninety minutes after the session had
 * finished, committed six times and gone idle. It is used here only in
 * conjunction with the age ceiling above, never on its own.
 */
const GOAL_ACTIVE = /\/goal\s+active/i;

/** Verdicts that mean the session has run out of goal and said so. */
const OUT_OF_GOAL = [
  /goal could not be achieved/i,
  /goal not achieved/i,
  /could not achieve the goal/i,
];

export interface ManagedSession {
  sessionId: string;
  /** Human name at the time of starting, for logs only — sessions get renamed. */
  name: string;
  /** The standing objective, re-armed whenever it lapses. */
  objective: string;
  /** Operator instructions waiting to go out with the next arming. */
  pending: string[];
  /** Everything the manager has done, newest last, capped. */
  history: { at: string; what: string }[];
  lastRearmAt: number;
  lastChangeAt: number;
  lastHash: string;
  paused: boolean;
  /** The pane, so the process and thence the checkout can be found again. */
  tty?: string;
  /** Screen work forbidden — the operator has the machine. Survives re-arming. */
  noScreen?: boolean;
  /** When the current screen decision reverts by itself. A grant that only ends
   *  when somebody remembers to end it outlives the reason it was given for. */
  handsUntil?: number;
  /** Which state the timer was set in, so reverting means the opposite of it. */
  handsWas?: boolean;
  startedAt: number;
}

type State = Record<string, ManagedSession>;

/**
 * A duration nobody can print nonsense from.
 *
 * The defect this closes: a sentinel `0` meaning "no timestamp" was subtracted
 * from the clock and formatted as an age, so a log line read "armed 29,779,818
 * min" — the age of the Unix epoch, internally correct and externally absurd.
 * One code path was fixed; this closes the class, because the next path to
 * format a duration from a suspect timestamp would have printed it again.
 *
 * Anything beyond a month is not a duration in this system, it is a bad
 * subtraction, and saying so is more useful than a number with eight digits.
 */
const IMPLAUSIBLE_MS = 31 * 24 * 60 * 60_000;
function minutesSince(then: number, now: number): string {
  const ms = now - then;
  if (!Number.isFinite(ms) || ms < 0 || ms > IMPLAUSIBLE_MS) return "an unknown time";
  return `${Math.round(ms / 60000)} min`;
}

/**
 * Repair history lines produced by that defect, once, on load.
 *
 * Normally a log is struck forward rather than rewritten — a record that edits
 * its own history is worth less than one that does not. This is the exception
 * and it is narrow: the line is not a claim anybody needs to audit, it is a
 * garbled rendering of an event that did happen, produced by a bug that no
 * longer exists. What it records is preserved; only the impossible number goes.
 */
function repairHistory(s: State): boolean {
  let changed = false;
  for (const m of Object.values(s)) {
    for (const h of m.history ?? []) {
      const bad = h.what.match(/armed (\d{7,}) min/);
      if (bad) {
        h.what = h.what.replace(bad[0], "armed for an unknown time (a defect in this manager's own arithmetic, fixed 2026-08-15)");
        changed = true;
      }
    }
  }
  return changed;
}

function loadState(): State {
  try {
    if (existsSync(STATE_FILE)) {
      const s = JSON.parse(readFileSync(STATE_FILE, "utf8")) as State;
      if (repairHistory(s)) {
        saveState(s);
        log("[manage] repaired history lines left by the epoch-duration defect");
      }
      return s;
    }
  } catch (e) {
    log(`[manage] state unreadable, starting empty — ${(e as Error).message}`);
  }
  return {};
}

function saveState(s: State): void {
  try {
    writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
  } catch (e) {
    log(`[manage] could not save state — ${(e as Error).message}`);
  }
  for (const m of Object.values(s)) mirrorToRepo(m);
}

/**
 * Put what a session knows INTO THE PROJECT, not beside it.
 *
 * On one machine this is tidiness. Across machines it is the entire
 * synchronisation mechanism: git already moves work between developers, so
 * knowledge committed to the repository travels with the branch, merges with
 * the branch and arrives on every machine without anybody building a protocol
 * for it. Knowledge in a home directory reaches exactly one machine, and which
 * machine that is depends on where somebody happened to be sitting.
 *
 * The same argument in the other direction is why this file is not the record:
 * `~/.aibroker` is per-machine state — sockets, tokens, timers — and that is
 * correct for things that describe a machine. An objective describes the WORK,
 * so it belongs where the work is.
 *
 * Written as markdown rather than the state JSON because the reader is the next
 * agent to open the repository, possibly on another machine, possibly weeks
 * later. It should not need this program to make sense of what it finds.
 */
function mirrorToRepo(m: ManagedSession): void {
  try {
    // Resolve the pane NOW rather than trusting one recorded at creation.
    // A field captured once is a field that is absent on every record made
    // before it existed and wrong for any session that has since moved — and
    // both of those fail silently, which is how a mirror stops mirroring
    // without anybody noticing.
    const tty = m.tty ?? snapshotTty(m.sessionId);
    const proc = tty ? processReading(tty) : { isSession: false, pid: null };
    if (!proc.pid) return;
    const cwd = repoRootFor(proc.pid);
    if (!cwd) return;

    const dir = join(cwd, ".aibroker");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    const recent = m.history.slice(-12).map((h) => `- ${h.at} — ${h.what}`).join("\n");
    const body =
      `# Session: ${m.name}\n\n` +
      `_Written by the manager. It travels with this branch, which is the point:\n` +
      `whichever machine picks this work up next reads it here rather than\n` +
      `rediscovering it._\n\n` +
      `## Standing objective\n\n${m.objective}\n\n` +
      (m.pending.length ? `## Waiting to be carried into the next cycle\n\n${m.pending.map((p) => `- ${p}`).join("\n")}\n\n` : "") +
      (m.noScreen ? `## Screen\n\nScreen work is currently withheld - the operator has the machine.\n\n` : "") +
      `## Recent\n\n${recent || "- nothing yet"}\n`;

    const file = join(dir, `session-${m.name.replace(/[^A-Za-z0-9._-]/g, "-")}.md`);
    // Only write on change. A file rewritten every twenty seconds turns a
    // repository into a stream of no-op commits and trains everyone to ignore it.
    const before = existsSync(file) ? readFileSync(file, "utf8") : "";
    if (before !== body) writeFileSync(file, body);
  } catch (e) {
    log(`[manage] could not mirror into the repository — ${(e as Error).message}`);
  }
}

/** The pane device for a session, captured once at start. */
function snapshotTty(sessionId: string): string | undefined {
  return discoverLiveSessions().find((s) => s.id === sessionId)?.tty;
}

/** The checkout a process is sitting in, or null if it is not in one. */
function repoRootFor(pid: string): string | null {
  try {
    const cwdOut = execFileSync("/usr/sbin/lsof", ["-p", pid, "-a", "-d", "cwd", "-Fn"], {
      encoding: "utf8",
      timeout: 4_000,
    });
    const cwd = cwdOut.split("\n").find((l) => l.startsWith("n"))?.slice(1);
    if (!cwd) return null;
    const root = execFileSync("/usr/bin/env", ["git", "-C", cwd, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      timeout: 4_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return root || null;
  } catch {
    return null;
  }
}

let state: State = loadState();
let timer: NodeJS.Timeout | null = null;

function hash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return String(h);
}

function note(m: ManagedSession, what: string): void {
  // Local time, like the daemon log. A history stamped in UTC beside a log
  // stamped locally is two clocks in one investigation, and the whole point of
  // this record is to be read at three in the morning by someone in a hurry.
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  const at = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  m.history.push({ at, what });
  if (m.history.length > 40) m.history = m.history.slice(-40);
  log(`[manage:${m.name}] ${what}`);
}

/**
 * Resolve a session by whatever the caller knows — its id, or its name.
 *
 * The hook knows the working directory and the terminal session; a person
 * knows the name. Both have to land on the same record.
 */
export function resolveSession(idOrName: string): { sessionId: string; name: string } | null {
  const live = discoverLiveSessions();
  // The terminal's own id may arrive as "w3t1p0:UUID"; the pane is the UUID.
  const id = idOrName.includes(":") ? (idOrName.split(":").pop() ?? idOrName) : idOrName;
  const byId = live.find((s) => s.id === id || s.aibrokerId === id);
  if (byId) return { sessionId: byId.id, name: byId.paiName ?? byId.name ?? id };
  const needle = idOrName.toLowerCase();
  const byName = live.find(
    (s) => (s.paiName ?? "").toLowerCase() === needle || (s.name ?? "").toLowerCase().includes(needle),
  );
  if (byName) return { sessionId: byName.id, name: byName.paiName ?? byName.name ?? idOrName };
  return null;
}

/**
 * What is actually running in this pane, from the PROCESS TABLE.
 *
 * WHY THIS EXISTS AT ALL. Everything below used to be inferred from the text on
 * screen, and that is hopeless: three filters in a row settled on chrome, one of
 * them reporting a "use /clear to free up context" tip as the session's activity
 * for minutes. Parsing a terminal UI means guessing at somebody's prompt theme,
 * their status line and the framework's own banners — a proxy for a question the
 * operating system answers exactly.
 *
 * Each pane has a tty and the session process sits on it. That answers exactly
 * ONE question, which is the one worth asking here: is there a `claude` on this
 * tty at all, or is the pane a bare shell? A goal typed at a shell prompt runs
 * as shell commands — that has happened, and it was harmless only by luck.
 *
 * It does NOT answer "is it working". An earlier version read that from a
 * `caffeinate` child and it discriminated perfectly across five panes — and it
 * is still the wrong thing to depend on, because it is an implementation detail
 * of one client on one operating system. A signal that happens to correlate
 * today is the definition of a proxy, and this file has been caught by four of
 * them already. That question belongs to the transcript below, which is the
 * session's own record rather than a side effect of it.
 */
function processReading(tty: string): { isSession: boolean; pid: string | null } {
  const dev = tty.replace(/^\/dev\//, "");
  let out = "";
  try {
    out = execFileSync("/bin/ps", ["-t", dev, "-o", "pid=,ppid=,etime=,command="], {
      encoding: "utf8",
      timeout: 4_000,
    });
  } catch {
    // No processes on that tty, or ps refused. Either way nothing can be said.
    return { isSession: false, pid: null };
  }

  const rows = out
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const m = l.match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
      return m ? { pid: m[1], ppid: m[2], etime: m[3], cmd: m[4] } : null;
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);

  const claude = rows.find((r) => /(^|\/)claude$/.test(r.cmd.split(/\s+/)[0]));
  if (!claude) return { isSession: false, pid: null };

  return { isSession: true, pid: claude.pid };
}

/**
 * What the session is doing, from its own transcript — the authority.
 *
 * THE PROCESS TABLE WAS THE SECOND WRONG ANSWER. Reading the screen was the
 * first: three filters in a row settled on chrome. Then `caffeinate`, which
 * discriminated perfectly across five panes and is still wrong to depend on —
 * it is an implementation detail of one client on one operating system, and a
 * signal that happens to correlate today is the definition of a proxy. The
 * question was never "what did this spawn", it is "what is the session doing",
 * and the session writes that down itself.
 *
 * Every session keeps a JSONL transcript: one entry per message, each carrying
 * a timestamp, the tool being called by name, and real token usage. From it,
 * without parsing a single line of terminal output:
 *
 *   - WORKING or NOT: the last entry is a tool call awaiting its result, or it
 *     is finished text. No inference from spinners.
 *   - WHAT: the tool's own name, as the client recorded it.
 *   - CONTEXT: summed from usage rather than scraped off somebody's status bar,
 *     which required a particular status bar and gave nothing without it.
 *   - WHEN: the entry's timestamp, so "how long has this been going" is a
 *     subtraction rather than a guess.
 */
function transcriptReading(claudePid: string): {
  working: boolean | null;
  doing: string | null;
  contextK: number | null;
  lastAt: number | null;
} {
  const none = { working: null, doing: null, contextK: null, lastAt: null };
  try {
    // The transcript directory is named for the session's working directory,
    // which the process itself is the authority on.
    const cwdOut = execFileSync("/usr/sbin/lsof", ["-p", claudePid, "-a", "-d", "cwd", "-Fn"], {
      encoding: "utf8",
      timeout: 4_000,
    });
    const cwd = cwdOut.split("\n").find((l) => l.startsWith("n"))?.slice(1);
    if (!cwd) return none;

    const dir = join(homedir(), ".claude", "projects", cwd.replace(/\//g, "-"));
    if (!existsSync(dir)) return none;

    // The live transcript is the one being written. Newest wins; a session that
    // has not written for a long time will show that in its own timestamp
    // rather than being silently mistaken for a fresh one.
    const newest = readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => ({ f, m: statSync(join(dir, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m)[0];
    if (!newest) return none;

    // Only the tail is needed and these files reach tens of megabytes.
    const raw = execFileSync("/usr/bin/tail", ["-n", "40", join(dir, newest.f)], {
      encoding: "utf8",
      timeout: 4_000,
      maxBuffer: 8 * 1024 * 1024,
    });

    const msgs: any[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const j = JSON.parse(line);
        if (j.type === "assistant" || j.type === "user") msgs.push(j);
      } catch { /* a truncated first line is normal when tailing */ }
    }
    if (!msgs.length) return none;

    const last = msgs[msgs.length - 1];
    const lastAt = last.timestamp ? Date.parse(last.timestamp) : null;

    // A tool call with no result after it is work in flight. A finished
    // assistant message is a turn that has ended.
    const lastAssistant = [...msgs].reverse().find((m) => m.type === "assistant");
    const content = lastAssistant?.message?.content;
    const toolUse = Array.isArray(content) ? content.filter((c: any) => c.type === "tool_use") : [];
    const working = last.type === "assistant" ? toolUse.length > 0 : true;

    const doing = toolUse.length
      ? toolUse.map((t: any) => t.name).join(", ")
      : last.type === "user"
        ? "waiting on a tool result"
        : null;

    const u = lastAssistant?.message?.usage;
    const contextK = u
      ? Math.round(
          ((u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)) / 1000,
        )
      : null;

    return { working, doing, contextK, lastAt };
  } catch {
    return none;
  }
}

/**
 * The status line, assembled from the sources in order of authority.
 *
 * The transcript first, because it is the session's own record: the tool by
 * name, the context from real usage, the time of the last entry. The process
 * table second, for the one thing it settles — whether this is a session at
 * all. The screen last and only for the goal marker, which exists nowhere else.
 *
 * Each line says where it came from. That is not decoration: the pane readings
 * have been wrong for ninety minutes at a stretch, and a reader who cannot tell
 * which number came from the transcript and which was scraped off a status bar
 * cannot tell which one to doubt.
 */
function liveReading(sessionId: string, idleSec: number): string {
  const snap = discoverLiveSessions().find((s) => s.id === sessionId);
  const proc = snap?.tty ? processReading(snap.tty) : { isSession: false, pid: null };

  if (!proc.isSession) {
    return "  no session process on that pane — it is a bare shell, or the session has exited";
  }

  const t = proc.pid ? transcriptReading(proc.pid) : { working: null, doing: null, contextK: null, lastAt: null };
  const out: string[] = [];

  if (t.lastAt !== null) {
    const agoSec = Math.round((Date.now() - t.lastAt) / 1000);
    out.push(
      `  ${t.working ? "working" : "idle"} · last transcript entry ${agoSec < 90 ? `${agoSec}s` : `${Math.round(agoSec / 60)} min`} ago` +
        (t.doing ? ` · ${t.doing}` : ""),
    );
    if (t.contextK !== null) out.push(`  context ${t.contextK}k tokens (from the transcript's own usage, not the status bar)`);
  } else {
    out.push(`  a session is running, but its transcript could not be read — falling back to the screen`);
  }

  const content = readPane(sessionId);
  if (GOAL_ACTIVE.test(content)) {
    out.push(`  goal marker present on screen (a proxy — it lingers after a goal is met)`);
  }
  out.push(`  pane unchanged for ${idleSec}s`);
  return out.join("\n");
}

/**
 * What the session appears to be doing, right now, read fresh.
 *
 * EVERYTHING HERE IS A READING AND IS LABELLED AS ONE. The goal marker is
 * scraped off a status line and has been wrong by ninety minutes; "busy" is
 * inferred from a spinner. The point is not to be authoritative — it is that
 * asking the manager what is going on should not require going and looking, and
 * a reading you know is a reading beats no reading at all.
 */
function paneReading(content: string): string {
  if (!content) return "  the pane could not be read";

  const lines = content.split("\n").map((l) => l.trimEnd());
  const marker = GOAL_ACTIVE.test(content);
  // Two formats appear depending on the status line in use: "81% context used"
  // and "Context: 730K / 1000K". Reading only the first reported nothing at all
  // on a session using the second, which looks exactly like a session with no
  // context reading rather than a reader that cannot see this one.
  const ctx =
    content.match(/(\d{1,3})%\s*context\s*used/i)?.[1] ??
    (() => {
      const m = content.match(/Context:\s*([\d.]+)K\s*\/\s*([\d.]+)K/i);
      return m ? String(Math.round((Number(m[1]) / Number(m[2])) * 100)) : undefined;
    })();
  const busy = /·\s*↓|tokens\)|esc to interrupt|✻|✽/i.test(content);

  /**
   * What it is doing — taken from the STRUCTURE, not from guessing at prose.
   *
   * Three attempts failed before this one, each a filter over "which line looks
   * like real output": a blocklist of chrome (missed two entries), then a
   * word-count test (settled on a "Use /clear to start fresh" tip and reported
   * it as the session's activity for minutes on end). Both were proxies for a
   * question the terminal already answers explicitly.
   *
   * Looking at an actual pane settles it. Tool invocations are marked with a
   * bullet and name what is running. The activity line carries the elapsed time
   * and the tokens drawn. Those are the two facts worth having, they are
   * identifiable by their own markers rather than by their wording, and the tip
   * banner that fooled the last version shares a prefix with real output but
   * carries neither marker.
   */
  const doing = lines.filter((l) => /^\s*⏺/.test(l)).slice(-1)[0]?.replace(/^\s*⏺\s*/, "");
  const activity = content.match(/([A-Za-z]+…)\s*\(([^)]*)\)/);
  const elapsed = activity?.[2];

  const parts = [
    `  looks ${busy ? "busy" : "idle"}`,
    ctx ? `context ${ctx}%` : null,
    // The elapsed time is the number that tells you whether to worry. A session
    // ninety minutes into one turn is either deep in something or stuck, and
    // both are worth knowing; neither is visible from "busy".
    elapsed ? `on this turn ${elapsed.replace(/\s*·\s*/g, ", ")}` : null,
    `goal marker ${marker ? "present" : "absent"}${marker ? " (a proxy — it lingers after a goal is met)" : ""}`,
  ].filter(Boolean);

  return `  ${parts.join(" · ")}${doing ? `\n  doing: ${doing.trim().slice(0, 110)}` : ""}`;
}

/** The text actually typed at the session. Short goal, context by reference. */
function goalText(m: ManagedSession): string {
  const extra = m.pending.length ? ` OPERATOR, since you were last armed: ${m.pending.join(" ")}` : "";
  // The screen rule has to ride along with EVERY arming. Delivered once, it
  // lasts only until the session next reads a goal — and the goal is what tells
  // it what to do. So a standing rule that is not in the goal is a rule with a
  // lifetime of one turn, and the next arming would send it back to clicking.
  const hands = m.noScreen
    ? " THE OPERATOR HAS THE SCREEN: do no screen or pointer work at all, and do not ask for it. Everything else continues as normal. Where something would need checking on screen, write down what would need checking instead of checking it."
    : "";
  return `/goal ${m.objective}${hands}${extra}`;
}

/**
 * Did it land? Look for the goal's own words in the transcript.
 *
 * NOT "did the content change" — that was the first version and it could not
 * tell a goal that arrived from text stranded unsubmitted in the input line,
 * which is the exact failure it existed to catch. A session prints for a dozen
 * reasons; only the item's own words say the item is there.
 */
function seenInContent(content: string | undefined, fragment: string): boolean {
  if (!content) return false;
  return content.replace(/\s+/g, "").includes(fragment.replace(/\s+/g, ""));
}

function readPane(sessionId: string): string {
  try {
    return readSessionContent(sessionId, 60)?.content ?? "";
  } catch {
    return "";
  }
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function arm(m: ManagedSession, reason: string): Promise<boolean> {
  const text = goalText(m);
  const fragment = m.objective.slice(0, 40);

  /**
   * NEVER TYPE A GOAL INTO A BARE SHELL.
   *
   * This is not hypothetical. A predecessor of this loop went on typing after
   * its session had exited, and the goal landed at a zsh prompt: `/goal` became
   * "no such file or directory" and the sentences after it became commands —
   * `always`, `they`, `the`, all "command not found". Harmless that time
   * entirely by luck, since a goal is prose and prose is mostly not commands.
   * A goal whose wording happened to begin a line with a real command would
   * have run it, in the operator's own shell, with no confirmation.
   *
   * `atPrompt` is exactly the discriminator: it is false for a session running
   * Claude — the foreground process is node whether it is working or idle — and
   * true when the shell itself is waiting for input. So true means the thing we
   * are managing is gone, and the right move is to say so and stop, not to keep
   * typing into whatever is there now.
   */
  const live = readSessionContent(m.sessionId, 5);
  if (!live) {
    note(m, "the session could not be read — not typing anything");
    return false;
  }
  if (live.atPrompt) {
    m.paused = true;
    note(m, "PAUSED — that pane is at a shell prompt, so the session has exited. Not typing a goal into a shell. `resume` once it is back.");
    return false;
  }

  if (!typeIntoSession(m.sessionId, text)) {
    note(m, `could not type into the session (${reason}) — will retry`);
    return false;
  }

  // Typed is not sent, and sent is not received.
  for (let i = 0; i < 5; i++) {
    await sleep(2_000);
    if (seenInContent(readPane(m.sessionId), fragment)) {
      m.lastRearmAt = Date.now();
      const carried = m.pending.length;
      m.pending = [];
      note(m, `armed: ${reason}${carried ? ` (carrying ${carried} operator instruction${carried > 1 ? "s" : ""})` : ""}`);
      return true;
    }
  }

  note(m, `typed but the objective's own words never appeared — treating as NOT armed (${reason})`);
  return false;
}

function reasonToArm(m: ManagedSession, content: string, now: number): string | null {
  if (m.paused) return null;

  if (OUT_OF_GOAL.some((re) => re.test(content))) return "the session reported its goal could not be achieved";

  // `now` zeroes the timestamp to force an arming. Without this the age is
  // computed from the epoch and the log says "armed 29779818 min ago", which is
  // true of a number and nonsense about the world — the kind of line that costs
  // somebody ten minutes at three in the morning.
  if (m.lastRearmAt === 0) return "asked to arm now";

  const quietFor = Math.max(0, now - m.lastChangeAt);
  const armedFor = Math.max(0, now - m.lastRearmAt);
  const marker = GOAL_ACTIVE.test(content);

  if (!marker && quietFor > NO_GOAL_GRACE_MS) return `no goal armed (idle ${Math.round(quietFor / 1000)}s)`;

  // The ceiling. Without it a stale marker strands the loop indefinitely while
  // every log line reads healthy — which is what a stalled loop looks like from
  // outside, and is why this exists rather than trusting the marker.
  if (armedFor > GOAL_MAX_AGE_MS) {
    return `armed ${minutesSince(m.lastRearmAt, now)} with no sign of a new goal — assuming it lapsed`;
  }
  return null;
}

async function tick(): Promise<void> {
  const now = Date.now();
  let dirty = false;

  for (const m of Object.values(state)) {
    const content = readPane(m.sessionId);
    if (!content) {
      // A session that cannot be read is not necessarily gone; say so once per
      // tick rather than dropping it, because dropping it silently is how a
      // manager stops managing without anybody noticing.
      continue;
    }

    const h = hash(content);
    if (h !== m.lastHash) {
      m.lastHash = h;
      m.lastChangeAt = now;
      dirty = true;
    }

    /**
     * A timed screen decision reverts itself.
     *
     * Checked before anything else in the tick, because the whole value is that
     * it happens without a person: "hands on for eight hours" has to hand the
     * screen back at the eighth hour whether or not anybody is awake to ask.
     */
    if (m.handsUntil && now >= m.handsUntil) {
      const wasOff = m.handsWas === true;
      delete m.handsUntil;
      delete m.handsWas;
      m.noScreen = !wasOff;
      typeIntoSession(
        m.sessionId,
        m.noScreen
          ? "The time you had the screen for is up — my controls. The operator may be back at the machine, so stop screen and pointer work now, write down how far you got and what still needs checking on screen, and carry on with everything that does not need it."
          : "your controls. The screen is yours again — the operator's hold has expired. You may resume visual work where your notes left it.",
      );
      note(m, m.noScreen ? "timed grant expired — screen work stopped" : "timed hold expired — screen work permitted again");
      dirty = true;
    }

    if (now - m.lastRearmAt < REARM_COOLDOWN_MS) continue;

    const reason = reasonToArm(m, content, now);
    if (!reason) continue;

    await arm(m, reason);
    dirty = true;
  }

  if (dirty) saveState(state);
}

export function startManagerLoop(): void {
  if (timer) return;
  state = loadState();
  const n = Object.keys(state).length;
  if (n) log(`[manage] resuming ${n} managed session${n > 1 ? "s" : ""}`);
  timer = setInterval(() => {
    void tick().catch((e) => log(`[manage] tick failed — ${(e as Error).message}`));
  }, TICK_MS);
  timer.unref?.();
}

export interface ManageResult {
  ok: boolean;
  message: string;
  managed?: boolean;
}

/**
 * The whole operator surface, in one call.
 *
 * `/manage <objective>`  start managing this session with that objective
 * `/manage <message>`    once running, an instruction carried into the next arming
 * `/manage`              what is it doing
 * `/manage off`          stop
 * `/manage pause|resume` stop arming without forgetting the objective
 * `/manage now`          arm immediately, whatever the signals say
 */
export async function handleManage(sessionIdOrName: string, rawArg: string): Promise<ManageResult> {
  const arg = (rawArg ?? "").trim();

  /**
   * `machine/session` is managed by that machine's own hub.
   *
   * Not proxied, delegated. The remote hub owns its panes, reads its own
   * transcripts and types into its own terminals; a manager here would be
   * guessing about all three across a network. So the objective is handed over
   * and lives there, which is also what makes it survive this machine being
   * closed — the developer keeps working when the manager goes home, which is
   * the entire point of giving them their own computer.
   */
  {
    const { forwardToPeer } = await import("./peer-handlers.js");
    const forwarded = await forwardToPeer(sessionIdOrName, "manage", { arg });
    if (forwarded) {
      return forwarded.ok
        ? { ok: true, message: forwarded.result?.message ?? "done", managed: forwarded.result?.managed }
        : { ok: false, message: forwarded.error ?? "the peer refused it" };
    }
  }

  const resolved = resolveSession(sessionIdOrName);
  if (!resolved) return { ok: false, message: `no live session matches "${sessionIdOrName}"` };

  const { sessionId, name } = resolved;
  const existing = state[sessionId];
  const word = arg.toLowerCase();

  // help — the grammar, from the thing that implements it.
  //
  // Written here rather than in the CLI and the hook and the tool description,
  // because three copies of one list is how they end up disagreeing. Everything
  // that answers `manage` reads this same text.
  if (word === "help" || word === "?" || word === "--help" || word === "-h") {
    return {
      ok: true,
      managed: !!existing,
      message:
        `manage — keep a session working on a standing objective.\n\n` +
        `  <objective>   start managing, or once running, an instruction carried\n` +
        `                into the next arming ("do the tests before the docs")\n` +
        `  status        what the session looks like right now, and what the\n` +
        `                manager has done. Also: state, what, info, show\n` +
        `  hands off     the operator needs the screen: stops visual work at once,\n` +
        `                keeps everything else going, and says why\n` +
        `  hands on      give the screen back\n` +
        `  hands on|off for 8 hours | 30m\n` +
        `                same, but it reverts by itself — a permission that ends\n` +
        `                only when somebody remembers outlives its reason\n` +
        `  set <text>    REPLACE the standing objective. Plain text on a running\n` +
        `                manager is a one-shot note; this changes what it re-arms\n` +
        `  now           arm immediately, whatever the signals say\n` +
        `  pause         stop arming, keep the objective\n` +
        `  resume        start arming again\n` +
        `  off           stop managing entirely\n` +
        `  help          this\n\n` +
        `Three ways in:\n` +
        `  aibroker manage <session> …   any shell. Works while the session is busy.\n` +
        `  /btw manage …                 inside the session; answers by notification,\n` +
        `                                because a busy session cannot print a reply.\n` +
        `  /btw manage <in words>        anything not in the list above goes to the\n` +
        `                                model, which reads it and calls the tool.\n\n` +
        `${existing ? `Currently managing ${name}: ${existing.objective}` : `${name} is not being managed.`}`,
    };
  }

  if (word === "off" || word === "stop") {
    if (!existing) return { ok: true, message: `${name} was not being managed`, managed: false };
    delete state[sessionId];
    saveState(state);
    log(`[manage:${name}] stopped by the operator`);
    return { ok: true, message: `stopped managing ${name}`, managed: false };
  }

  // "status" is what a person actually types when they want the status, and the
  // first version took it as an objective and started managing the session with
  // the objective "status". Anything that reads as a question about state is a
  // question about state; only text that is not one of these becomes an
  // objective. Getting this wrong is silent and sets the session working on a
  // word.
  const ASKING = new Set(["status", "state", "what", "what?", "?", "info", "show"]);
  if (!arg || ASKING.has(word)) {
    if (!existing) return { ok: true, message: `${name} is not being managed. /manage <objective> to start.`, managed: false };
    const last = existing.history.slice(-4).map((h) => `  ${h.at.slice(11)} ${h.what}`).join("\n");
    const age = Math.round((Date.now() - existing.lastRearmAt) / 60000);
    const idle = Math.round((Date.now() - existing.lastChangeAt) / 1000);
    // Two separate things, kept separate: what the manager has DONE, and what
    // the session appears to be doing. Running them together is how a record of
    // one gets read as evidence about the other.
    return {
      ok: true,
      managed: true,
      message:
        `managing ${name}${existing.paused ? " (paused)" : ""}\n` +
        `objective: ${existing.objective}\n` +
        `\nright now:\n` +
        liveReading(sessionId, idle) +
        `\n\nthe manager: last armed ${age} min ago` +
        (existing.pending.length ? `, ${existing.pending.length} instruction(s) waiting to go out` : "") +
        (last ? `\n${last}` : ""),
    };
  }

  /**
   * set — REPLACE the standing objective, rather than adding a note to it.
   *
   * Without this there was no way to correct one. Free text on a running
   * manager becomes a one-shot instruction, so a mistake in the objective could
   * only be answered by a note that itself expires — and the objective is
   * re-read on EVERY arming, so anything wrong in it is re-asserted forever
   * rather than misleading once. That is the difference between an objective
   * and a message, and it is why this needs its own verb.
   */
  const setMatch = arg.match(/^(?:set|objective|replace)\s+([\s\S]+)$/i);
  if (setMatch && existing) {
    const before = existing.objective;
    existing.objective = setMatch[1].trim();
    // Notes written against the old objective may not make sense against the
    // new one; say so rather than silently carrying them over.
    const dropped = existing.pending.length;
    existing.pending = [];
    note(existing, `objective replaced${dropped ? `, ${dropped} pending instruction(s) dropped with it` : ""}`);
    saveState(state);
    return {
      ok: true,
      managed: true,
      message:
        `objective replaced for ${name}.\n  was: ${before.slice(0, 80)}${before.length > 80 ? "…" : ""}\n  now: ${existing.objective.slice(0, 80)}${existing.objective.length > 80 ? "…" : ""}` +
        (dropped ? `\n  ${dropped} pending instruction(s) dropped — they were written against the old objective.` : ""),
    };
  }

  /**
   * hands off / hands on — take the screen back without stopping the work.
   *
   * `pause` is the wrong tool for this: it stops the manager, and what is
   * wanted is the opposite — the session keeps working, it just stops touching
   * the screen. A session driving the pointer is the one thing that cannot
   * share a machine with its operator.
   *
   * DELIVERY IS THE HARD PART, and an instruction carried into the next arming
   * is useless here: the next arming may be twenty minutes away and the pointer
   * is moving now. Two things happen instead, and neither waits for a goal.
   *
   * First, the message is typed into the session directly, so it lands at the
   * next tool-call boundary — seconds, for a session that is clicking.
   *
   * Second, it opens with the exact phrase the screen-control tool's own hook
   * watches for. That revokes control at the TOOL, so the next click fails with
   * an error explaining why, rather than depending on the session having read
   * and obeyed a sentence. Enforced beats cooperative when the cost of it being
   * ignored is the operator losing their pointer mid-sentence.
   */
  const handsMatch = arg.match(/^hands?\s+(off|on)\b\s*(.*)$/i);
  if (handsMatch || word === "nogui" || word === "gui") {
    const off = handsMatch ? /off/i.test(handsMatch[1]) : word === "nogui";
    if (!existing) return { ok: false, message: `${name} is not being managed` };

    /**
     * A DURATION, because the useful case is bounded in both directions.
     *
     * "hands on for eight hours" is the overnight grant: it may drive the screen
     * while nobody is at the machine, and it gives the screen BACK before
     * somebody sits down — without that person having to remember to revoke it.
     * "hands off for thirty minutes" is the mirror: take the machine, and have
     * visual work resume by itself rather than staying stopped because nobody
     * said the word.
     *
     * Both matter for the same reason: a permission that only ends when a person
     * remembers to end it is a permission that outlives its reason.
     */
    const dur = (handsMatch?.[2] ?? "").match(/(?:for\s+)?(\d+(?:\.\d+)?)\s*(h|hr|hrs|hour|hours|m|min|mins|minute|minutes)\b/i);
    if (dur) {
      const n = Number(dur[1]);
      const unit = dur[2].toLowerCase();
      const ms = /^h/.test(unit) ? n * 3_600_000 : n * 60_000;
      existing.handsUntil = Date.now() + ms;
      existing.handsWas = off;
    } else {
      delete existing.handsUntil;
      delete existing.handsWas;
    }

    existing.noScreen = off;
    if (off) {
      // The reason comes FIRST, and the phrase is inside a sentence rather than
      // barked on its own. "my controls" alone revokes the tool and explains
      // nothing — a session that has just lost the pointer mid-task, with no
      // reason given, will either guess or stop, and both are worse than being
      // told. What it needs is: why, what to stop, what to leave behind, what to
      // do instead, and when this ends.
      const msg =
        "THE OPERATOR NEEDS THE SCREEN — my controls. This is not a fault and not a criticism of what you were doing; " +
        "they have come back to the machine and cannot share a pointer with you. " +
        "So: stop all screen and pointer work now, mid-task if necessary. " +
        "Write into your notes exactly how far you got and what still needs verifying on screen, in enough detail that somebody can resume it cold — that record is the only thing being asked of the work you are abandoning. " +
        "Then KEEP WORKING on everything that does not need the screen: reading code, diagnosing, writing, tests, notes. There is plenty of that. " +
        "Do not stop and do not wait. The screen comes back to you when you are told the controls are yours again.";
      typeIntoSession(sessionId, msg);
      note(existing, "hands off — screen work stopped, non-visual work continues");
    } else {
      typeIntoSession(sessionId, "your controls. The screen is yours again — you may resume visual work where your notes left it.");
      note(existing, "hands on — screen work permitted again");
    }
    saveState(state);
    return {
      ok: true,
      managed: true,
      message:
        (off
          ? `${name}: screen work stopped and the message is on its way. It keeps working on everything that needs no screen, and every arming carries the same rule.`
          : `${name}: screen work permitted again.`) +
        (existing.handsUntil
          ? `\n  reverts by itself at ${new Date(existing.handsUntil).toLocaleTimeString("de-DE")} — no need to remember.`
          : `\n  stays this way until you say otherwise.`),
    };
  }

  if (word === "pause" || word === "resume") {
    if (!existing) return { ok: false, message: `${name} is not being managed` };
    existing.paused = word === "pause";
    saveState(state);
    return { ok: true, managed: true, message: `${word === "pause" ? "paused" : "resumed"} managing ${name}` };
  }

  if (!existing) {
    /**
     * REFUSE TO MANAGE ANYTHING THAT IS NOT A SESSION.
     *
     * `aibroker manage status CaseLeaf` — keyword first, session second —
     * resolved to the plain shell the command was typed in, and the remainder
     * became an objective: a manager was created for a `-zsh` pane, silently,
     * with the objective "status CaseLeaf". Nothing would ever have come of it
     * except goals typed at a shell prompt.
     *
     * The arm path already refuses a bare shell. That is too late: by then a
     * manager exists, appears in every listing, and has to be found and removed
     * by somebody who did not create it on purpose. Check at the point of
     * creation, where the mistake is still one command old.
     */
    const probe = readSessionContent(sessionId, 5);
    if (probe?.atPrompt) {
      return {
        ok: false,
        message:
          `${name} is a shell prompt, not a running session — refusing to manage it.\n` +
          `If you meant a different session, name it first: aibroker manage <session> <objective>`,
      };
    }

    const m: ManagedSession = {
      sessionId,
      name,
      objective: arg,
      pending: [],
      history: [],
      // Give the session the benefit of the grace period rather than arming
      // on top of whatever it is doing at the moment the operator types this.
      lastRearmAt: Date.now(),
      lastChangeAt: Date.now(),
      lastHash: hash(readPane(sessionId)),
      tty: snapshotTty(sessionId),
      paused: false,
      startedAt: Date.now(),
    };
    state[sessionId] = m;
    note(m, "started");
    saveState(state);
    startManagerLoop();
    return {
      ok: true,
      managed: true,
      message: `managing ${name}. It will be re-armed with this objective whenever it stops:\n  ${arg}`,
    };
  }

  if (word === "now") {
    existing.lastRearmAt = 0;
    saveState(state);
    return { ok: true, managed: true, message: `${name} will be armed on the next tick` };
  }

  existing.pending.push(arg);
  note(existing, `operator: ${arg.slice(0, 80)}`);
  saveState(state);
  return {
    ok: true,
    managed: true,
    message: `noted for ${name} — it goes out with the next arming (${existing.pending.length} pending)`,
  };
}
