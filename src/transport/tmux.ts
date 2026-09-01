/**
 * transport/tmux.ts — tmux implementation of SessionTransport (synchronous).
 *
 * Why tmux: cross-platform, scriptable, SSH/headless-friendly, and `send-keys -l`
 * sidesteps the AppleScript multi-line escaping bugs. Two hard-won lessons from
 * prior art (claude-code-tools' tmux-cli) are baked in:
 *
 *  1. Sending text and pressing Enter as ONE combined send is unreliable for
 *     Claude Code. We send the literal text, confirm it landed, THEN send Enter
 *     as a separate keystroke, retrying the literal send if it didn't appear.
 *  2. Pane ids (%0, %3 …) are ephemeral — they reset when the tmux server
 *     restarts. So each pane gets a durable `@aibroker_id` user-option (scheme B)
 *     that the persistent paiName store can key on across transports.
 *
 * Synchronous (spawnSync) to match core.ts and the daemon's existing call sites.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { log } from "../core/log.js";
import type { ManagedSession, SendOptions, SessionTransport, TransportKind } from "./session-transport.js";

/** Foreground process names that mean "at a shell prompt" (idle), not running a program. */
const SHELL_COMMANDS = new Set(["zsh", "-zsh", "bash", "-bash", "sh", "-sh", "fish", "-fish"]);

/** Field separator for list-panes -F output; unlikely to appear in titles. */
const FIELD_SEP = "\u0001";

/**
 * Resolve an absolute tmux path. A launchd-managed daemon has a minimal PATH
 * (e.g. /usr/local/bin:/usr/bin:/bin) that excludes Homebrew's /opt/homebrew/bin,
 * so a bare "tmux" would ENOENT. Probe common locations, fall back to PATH.
 */
function resolveTmuxBin(): string {
  const candidates = ["/opt/homebrew/bin/tmux", "/usr/local/bin/tmux", "/usr/bin/tmux"];
  for (const c of candidates) if (existsSync(c)) return c;
  return "tmux";
}
const TMUX_BIN = resolveTmuxBin();

/**
 * tmux transliterates non-ASCII output to "_" under a C/POSIX locale — which is
 * exactly what launchd hands the daemon (no LANG/LC_*). That mangles BOTH the
 * \x01 FIELD_SEP (→ "_", so list-panes rows no longer split and every field
 * collapses into the "pane id") AND unicode pane titles. Forcing a UTF-8 locale
 * keeps the separator and titles intact. ANTHROPIC_API_KEY is stripped from the
 * spawned env per policy (never leak it to child processes).
 */
const TMUX_ENV: NodeJS.ProcessEnv = (() => {
  const e: NodeJS.ProcessEnv = { ...process.env };
  e.LC_ALL = "en_US.UTF-8";
  e.LANG = "en_US.UTF-8";
  delete e.ANTHROPIC_API_KEY;
  return e;
})();

function runTmux(args: string[], timeoutMs = 4_000): string | null {
  const result = spawnSync(TMUX_BIN, args, {
    stdio: ["pipe", "pipe", "pipe"],
    timeout: timeoutMs,
    encoding: "utf8",
    env: TMUX_ENV,
  });
  if (result.status !== 0) {
    const stderr = (result.stderr ?? "").toString().trim();
    // "no server running" is the normal state when no tmux is up — don't spam logs.
    if (stderr && !stderr.includes("no server running")) log(`tmux ${args[0]} failed: ${stderr}`);
    return null;
  }
  return result.stdout ?? "";
}

/** Blocking sleep — used only for the short send-verify poll. */
function syncSleep(ms: number): void {
  const shared = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(shared, 0, 0, ms);
}

export class TmuxTransport implements SessionTransport {
  readonly kind: TransportKind = "tmux";

  isAvailable(): boolean {
    // `list-panes -a` exits non-zero ("no server running") when no server exists,
    // zero otherwise — a cheap, reliable probe.
    return runTmux(["list-panes", "-a"], 2_000) != null;
  }

  /**
   * Resolve a session's CURRENT pane id from a stable id. Accepts either a pane
   * id ("%3" — returned as-is) or an @aibroker_id (looked up live). Pane ids are
   * ephemeral and reused (every first pane is %0), so the public ops take the
   * durable @aibroker_id as identity and resolve the live pane here. Returns null
   * if no live pane carries that id.
   */
  paneFor(stableId: string): string | null {
    if (stableId.startsWith("%")) return stableId;
    const out = runTmux(["list-panes", "-a", "-F", `#{@aibroker_id}${FIELD_SEP}#{pane_id}`]);
    if (out == null) return null;
    for (const line of out.split("\n").filter(Boolean)) {
      const [aid, pane] = line.split(FIELD_SEP);
      if (aid && aid === stableId) return pane ?? null;
    }
    return null;
  }

  /**
   * Durable @aibroker_id for a pane id (assigning one if the pane lacks it).
   * Used to translate an inbound caller's $TMUX_PANE into the stable identity.
   */
  aibrokerIdForPane(paneId: string): string | null {
    const existing = runTmux(["display-message", "-p", "-t", paneId, "#{@aibroker_id}"]);
    if (existing == null) return null;
    const id = existing.trim();
    if (id) return id;
    const fresh = randomUUID();
    runTmux(["set-option", "-p", "-t", paneId, "@aibroker_id", fresh]);
    return fresh;
  }

  listSessions(): ManagedSession[] {
    const fmt = ["#{pane_id}", "#{pane_current_command}", "#{pane_title}", "#{pane_tty}", "#{@aibroker_id}"].join(FIELD_SEP);
    const out = runTmux(["list-panes", "-a", "-F", fmt]);
    if (out == null) return [];

    const sessions: ManagedSession[] = [];
    for (const line of out.split("\n").filter(Boolean)) {
      const [paneId, cmd, title, tty, existingId] = line.split(FIELD_SEP);
      if (!paneId) continue;

      // Scheme B: ensure a durable id exists for this pane.
      let aibrokerId = existingId && existingId.length > 0 ? existingId : null;
      if (!aibrokerId) {
        aibrokerId = randomUUID();
        runTmux(["set-option", "-p", "-t", paneId, "@aibroker_id", aibrokerId]);
      }

      const cleanTitle = title && title.trim().length > 0 ? title.trim() : null;
      sessions.push({
        // Identity is the durable @aibroker_id, NOT the volatile pane id — so a
        // new session reusing pane %0 is a distinct session everywhere upstream.
        id: aibrokerId,
        name: cleanTitle ?? cmd ?? paneId,
        tabTitle: cleanTitle,
        tty: tty || null,
        busy: !SHELL_COMMANDS.has(cmd ?? ""),
        transport: this.kind,
        aibrokerId,
      });
    }
    return sessions;
  }

  sendText(id: string, text: string, opts: SendOptions = {}): boolean {
    const { enter = true, verify = true, maxRetries = 3 } = opts;
    const pane = this.paneFor(id);
    if (pane == null) return false;

    let landed = false;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      // Literal send: `--` guards against text starting with '-'; `-l` = no key-name interpretation.
      const sent = runTmux(["send-keys", "-t", pane, "-l", "--", text]);
      if (sent == null) return false;

      if (!verify) {
        landed = true;
        break;
      }

      // Poll the pane until the tail of what we typed shows on screen — then it landed.
      const probe = text.trim().slice(-40);
      if (probe.length === 0) {
        landed = true;
        break;
      }
      for (let poll = 0; poll < 10; poll++) {
        syncSleep(60);
        const shown = this.capture(pane);
        if (shown && shown.includes(probe)) {
          landed = true;
          break;
        }
      }
      if (landed) break;
      log(`tmux sendText: text did not appear on attempt ${attempt + 1} for ${pane}, retrying`);
    }

    if (!landed) {
      log(`tmux sendText: gave up after ${maxRetries} attempts for ${pane}`);
      return false;
    }

    if (enter) {
      // Separate keystroke — combining text+Enter in one send is the unreliable path.
      if (runTmux(["send-keys", "-t", pane, "Enter"]) == null) return false;
    }
    return true;
  }

  capture(id: string, lines?: number): string | null {
    const pane = this.paneFor(id);
    if (pane == null) return null;
    const args = ["capture-pane", "-t", pane, "-p"];
    if (lines && lines > 0) args.push("-S", `-${lines}`);
    return runTmux(args);
  }

  /**
   * ttys of terminals currently attached as tmux clients (e.g. an iTerm tab
   * running `tmux attach`). Used to de-dup: such a tab is a VIEWER of panes we
   * already enumerate directly, not a session of its own.
   */
  attachedClientTtys(): Set<string> {
    const out = runTmux(["list-clients", "-F", "#{client_tty}"]);
    if (out == null) return new Set();
    return new Set(out.split("\n").map((s) => s.trim()).filter(Boolean));
  }

  /**
   * tty of the terminal (e.g. iTerm tab) currently viewing the given pane's
   * session, or null if the session is detached. Lets callers map a tmux pane
   * back to its host iTerm tab so iTerm visuals (badge/tab title) can be set on
   * the tab the user is actually looking at.
   */
  clientTtyForPane(id: string): string | null {
    const pane = this.paneFor(id);
    if (pane == null) return null;
    const session = runTmux(["display-message", "-p", "-t", pane, "#{session_name}"]);
    if (session == null) return null;
    const name = session.trim();
    if (!name) return null;
    const out = runTmux(["list-clients", "-t", name, "-F", "#{client_tty}"]);
    if (out == null) return null;
    const tty = out.split("\n").map((s) => s.trim()).filter(Boolean)[0];
    return tty ?? null;
  }

  isBusy(id: string): boolean {
    const pane = this.paneFor(id);
    if (pane == null) return false;
    const out = runTmux(["display-message", "-p", "-t", pane, "#{pane_current_command}"]);
    if (out == null) return false;
    const cmd = out.trim();
    // Coarse layer: shell command => idle. A program (node/claude/ssh/…) => busy.
    // NOTE: while Claude runs, this always reads "node" — it cannot distinguish
    // "thinking" from "awaiting input". Fine-grained readiness needs output-diff
    // silence detection (a future waitIdle helper), tracked separately.
    return cmd.length > 0 && !SHELL_COMMANDS.has(cmd);
  }

  setTitle(id: string, title: string): boolean {
    const pane = this.paneFor(id);
    if (pane == null) return false;
    return runTmux(["select-pane", "-t", pane, "-T", title]) != null;
  }
}
