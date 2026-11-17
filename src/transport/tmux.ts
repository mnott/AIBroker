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

import { execFile, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { log } from "../core/log.js";
import { resolveBin } from "../core/bins.js";
import { claudeArgs } from "./session-transport.js";
import type { LaunchOptions, LaunchResult, ManagedSession, SendOptions, SessionTransport, TransportKind } from "./session-transport.js";

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

/** Where `aibroker launch` opens windows when the caller is not inside tmux. */
export const DETACHED_SESSION = "aibroker";

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

/**
 * The socket tmux would connect to for this process: $TMUX's first
 * comma-separated field (path,pid,session) when attached inside tmux, else
 * the default `$TMUX_TMPDIR/tmux-<uid>/default`.
 */
function tmuxSocketPath(): string {
  const tmuxEnv = process.env.TMUX;
  if (tmuxEnv) return tmuxEnv.split(",")[0]!;
  return `${process.env.TMUX_TMPDIR || "/tmp"}/tmux-${process.getuid!()}/default`;
}

function runTmux(args: string[], timeoutMs = 4_000): string | null {
  // No socket file, no server — spawning tmux just to have it fail is the
  // per-call cost this function exists to avoid (every enumeration and every
  // id routing goes through here).
  if (!existsSync(tmuxSocketPath())) return null;
  return spawnTmux(args, timeoutMs);
}

/** Like runTmux without the socket gate: launching is the one call that may START the server. */
function spawnTmux(args: string[], timeoutMs = 4_000): string | null {
  const result = spawnSync(TMUX_BIN, args, {
    stdio: ["pipe", "pipe", "pipe"],
    timeout: timeoutMs,
    encoding: "utf8",
    env: TMUX_ENV,
  });
  if (result.status !== 0) {
    const stderr = (result.stderr ?? "").toString().trim();
    // "no server running" / "error connecting to" (missing socket file) are the
    // normal states when no tmux is up — don't spam logs.
    if (stderr && !stderr.includes("no server running") && !stderr.includes("error connecting to") && !stderr.includes("can't find session")) {
      log(`tmux ${args[0]} failed: ${stderr}`);
    }
    return null;
  }
  return result.stdout ?? "";
}

/** runTmux without blocking the event loop; same socket gate, same null-on-failure and log. */
function runTmuxAsync(args: string[], timeoutMs = 4_000): Promise<string | null> {
  if (!existsSync(tmuxSocketPath())) return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      execFile(TMUX_BIN, args, { encoding: "utf8", timeout: timeoutMs, env: TMUX_ENV }, (err, stdout, stderr) => {
        if (err) {
          const msg = (stderr ?? "").toString().trim();
          if (msg && !msg.includes("no server running") && !msg.includes("error connecting to") && !msg.includes("can't find session")) {
            log(`tmux ${args[0]} failed: ${msg}`);
          }
          resolve(null);
          return;
        }
        resolve(stdout ?? "");
      });
    } catch {
      resolve(null);
    }
  });
}

// The send-verify poll used to sleep with Atomics.wait — a blocking wait inside
// the daemon's event loop. It is an awaited setTimeout now (see sendText).

const LIST_FORMAT = ["#{pane_id}", "#{pane_current_command}", "#{pane_title}", "#{pane_tty}", "#{@aibroker_id}", "#{pane_current_path}"].join(FIELD_SEP);

/** Coarse busy verdict from a `pane_current_command` reading. */
function busyFromCommand(out: string | null): boolean {
  if (out == null) return false;
  const cmd = out.trim();
  // Coarse layer: shell command => idle. A program (node/claude/ssh/…) => busy.
  // NOTE: while Claude runs, this always reads "node" — it cannot distinguish
  // "thinking" from "awaiting input". Fine-grained readiness needs output-diff
  // silence detection (a future waitIdle helper), tracked separately.
  return cmd.length > 0 && !SHELL_COMMANDS.has(cmd);
}

/** Parse `list-panes -F "#{@aibroker_id}<sep>#{pane_id}"` for one stable id. */
function parsePaneFor(out: string | null, stableId: string): string | null {
  if (out == null) return null;
  for (const line of out.split("\n").filter(Boolean)) {
    const [aid, pane] = line.split(FIELD_SEP);
    if (aid && aid === stableId) return pane ?? null;
  }
  return null;
}

export class TmuxTransport implements SessionTransport {
  readonly kind: TransportKind = "tmux";

  async isAvailable(): Promise<boolean> {
    // `list-panes -a` exits non-zero ("no server running") when no server exists,
    // zero otherwise — a cheap, reliable probe. Awaited: a sync tmux child on a
    // loaded machine is still a blocked event loop.
    return (await runTmuxAsync(["list-panes", "-a"], 2_000)) != null;
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
    return parsePaneFor(out, stableId);
  }

  /** paneFor without blocking the event loop. */
  async paneForAsync(stableId: string): Promise<string | null> {
    if (stableId.startsWith("%")) return stableId;
    const out = await runTmuxAsync(["list-panes", "-a", "-F", `#{@aibroker_id}${FIELD_SEP}#{pane_id}`]);
    return parsePaneFor(out, stableId);
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

  async listSessions(): Promise<ManagedSession[]> {
    const out = await runTmuxAsync(["list-panes", "-a", "-F", LIST_FORMAT]);
    if (out == null) return [];
    const pending: Promise<unknown>[] = [];
    const sessions = this.parsePanes(out, (paneId, id) => {
      pending.push(runTmuxAsync(["set-option", "-p", "-t", paneId, "@aibroker_id", id]));
    });
    await Promise.all(pending);
    return sessions;
  }

  private parsePanes(out: string, assignId: (paneId: string, id: string) => void): ManagedSession[] {
    const sessions: ManagedSession[] = [];
    for (const line of out.split("\n").filter(Boolean)) {
      const [paneId, cmd, title, tty, existingId, path] = line.split(FIELD_SEP);
      if (!paneId) continue;

      // Scheme B: ensure a durable id exists for this pane.
      let aibrokerId = existingId && existingId.length > 0 ? existingId : null;
      if (!aibrokerId) {
        aibrokerId = randomUUID();
        assignId(paneId, aibrokerId);
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
        cwd: path && path.length > 0 ? path : null,
        command: cmd || null,
      });
    }
    return sessions;
  }

  /** sendText — awaited tmux children and an awaited poll: no blocking sleep anywhere. */
  async sendText(id: string, text: string, opts: SendOptions = {}): Promise<boolean> {
    const pane = await this.paneForAsync(id);
    if (pane == null) return false;
    return this.sendTextToPane(
      pane, text, opts,
      (a) => runTmuxAsync(a),
      (ms) => new Promise((r) => setTimeout(r, ms)),
      (p, l) => this.capture(p, l),
    );
  }

  private async sendTextToPane(
    pane: string, text: string, opts: SendOptions,
    exec: (args: string[]) => string | null | Promise<string | null>,
    sleep: (ms: number) => void | Promise<void>,
    capture: (pane: string, lines?: number) => string | null | Promise<string | null>,
  ): Promise<boolean> {
    const { enter = true, verify = true, maxRetries = 3 } = opts;

    let landed = false;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      // Literal send: `--` guards against text starting with '-'; `-l` = no key-name interpretation.
      const sent = await exec(["send-keys", "-t", pane, "-l", "--", text]);
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
        await sleep(60);
        const shown = await capture(pane);
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
      if (await exec(["send-keys", "-t", pane, "Enter"]) == null) return false;
    }
    return true;
  }

  /** Send a single named tmux key (e.g. "C-u", "Enter") — no text, no retry. */
  sendKey(id: string, key: string): boolean {
    const pane = this.paneFor(id);
    if (pane == null) return false;
    return runTmux(["send-keys", "-t", pane, key]) != null;
  }

  /** sendKey without blocking the event loop. */
  async sendKeyAsync(id: string, key: string): Promise<boolean> {
    const pane = await this.paneForAsync(id);
    if (pane == null) return false;
    return (await runTmuxAsync(["send-keys", "-t", pane, key])) != null;
  }

  /** capture — async: the tmux child is awaited, never spawnSync'd. */
  async capture(id: string, lines?: number): Promise<string | null> {
    const pane = await this.paneForAsync(id);
    if (pane == null) return null;
    // -J joins wrapped lines so a long line reads as one, not as fragments.
    const args = ["capture-pane", "-t", pane, "-p", "-J"];
    if (lines && lines > 0) args.push("-S", `-${lines}`);
    return runTmuxAsync(args);
  }

  /**
   * ttys of terminals currently attached as tmux clients (e.g. an iTerm tab
   * running `tmux attach`). Used to de-dup: such a tab is a VIEWER of panes we
   * already enumerate directly, not a session of its own.
   */
  async attachedClientTtysAsync(): Promise<Set<string>> {
    const out = await runTmuxAsync(["list-clients", "-F", "#{client_tty}"]);
    if (out == null) return new Set();
    return new Set(out.split("\n").map((s) => s.trim()).filter(Boolean));
  }

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

  /** isBusy — async: the tmux child is awaited. */
  async isBusy(id: string): Promise<boolean> {
    const pane = await this.paneForAsync(id);
    if (pane == null) return false;
    return busyFromCommand(await runTmuxAsync(["display-message", "-p", "-t", pane, "#{pane_current_command}"]));
  }

  async setTitle(id: string, title: string): Promise<boolean> {
    const pane = await this.paneForAsync(id);
    if (pane == null) return false;
    return (await runTmuxAsync(["select-pane", "-t", pane, "-T", title])) != null;
  }

  /**
   * Open `claude` in `opts.dir` as a new tmux window. Inside tmux ($TMUX set) it
   * lands in the caller's current session; otherwise in a detached session named
   * `aibroker`, created on first use. Window name and pane title are `opts.name`,
   * and the pane gets its durable @aibroker_id straight away, so the hub can
   * address it by name on its very next enumeration. `io` lets tests replace tmux.
   */
  async launch(
    opts: LaunchOptions,
    io: { exec?: (args: string[]) => string | null | Promise<string | null>; env?: NodeJS.ProcessEnv; claudeBin?: string } = {},
  ): Promise<LaunchResult | null> {
    const exec = io.exec ?? runTmuxAsync;
    const env = io.env ?? process.env;
    const argv = ["--", io.claudeBin ?? resolveBin("claude"), ...claudeArgs(opts)];
    const pane = ["-c", opts.dir, "-n", opts.name, "-P", "-F", "#{pane_id}"];

    let out: string | null = null;
    let where = "";
    let attach: string | undefined;
    if (env.TMUX) {
      out = await exec(["new-window", ...pane, ...argv]);
      where = `window "${opts.name}" in the current tmux session`;
    }
    if (out == null) {
      where = `window "${opts.name}" in tmux session "${DETACHED_SESSION}"`;
      attach = `tmux attach -t ${DETACHED_SESSION}`;
      // Launch is the one call that may START the server, so it skips the socket gate.
      const spawn = io.exec ?? ((a: string[]) => new Promise<string | null>((res) => {
        execFile(TMUX_BIN, a, { encoding: "utf8", timeout: 10_000, env: TMUX_ENV }, (err, stdout) => res(err ? null : stdout ?? ""));
      }));
      out = (await spawn(["has-session", "-t", `=${DETACHED_SESSION}`])) != null
        ? await spawn(["new-window", "-t", `${DETACHED_SESSION}:`, ...pane, ...argv])
        : await spawn(["new-session", "-d", "-s", DETACHED_SESSION, ...pane, ...argv]);
    }
    const paneId = out?.trim();
    if (!paneId) return null;

    const id = randomUUID();
    await exec(["set-option", "-p", "-t", paneId, "@aibroker_id", id]);
    await exec(["select-pane", "-t", paneId, "-T", opts.name]);
    // Claude retitles its terminal; keep the name the session is addressed by
    // (pane option exists from tmux 3.5 — older servers reject it, harmlessly).
    await exec(["set-option", "-p", "-t", paneId, "allow-set-title", "off"]);
    return { id, transport: this.kind, where, attach };
  }
}
