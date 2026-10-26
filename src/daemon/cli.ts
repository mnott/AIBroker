#!/usr/bin/env node
/**
 * daemon/cli.ts — CLI for the aibroker daemon.
 *
 * Usage:
 *   aibroker                    Show the command list (never starts a daemon)
 *   aibroker start              Start the daemon (refuses when one is already running)
 *   aibroker start --socket /tmp/aibroker.sock
 *   aibroker status             Query daemon status
 *   aibroker stop|restart       Stop/restart via the service, IPC shutdown or daemon.pid
 *   aibroker launch <dir|pai-project> [--name N]   Open a Claude session (tmux window / iTerm tab)
 *   aibroker send <name> <text>  Type a message into a session
 *   aibroker create-adapter <name> [--display-name <Name>] [--output <dir>]
 *                               Scaffold a new adapter from the built-in template
 *   aibroker ota <subcommand>   OTA install hub (Docker + Tailscale Serve)
 *     up                        Start container, write .env, configure Tailscale Serve
 *     down                      Stop container
 *     status                    Show container + tailscale serve status
 *     logs [-f]                 Show container logs
 *     setup-serve               Configure Tailscale Serve only
 */

import "../core/env-bootstrap.js";
import { silenceLog } from "../core/log.js";
import { startDaemon, DAEMON_SOCKET_PATH } from "./index.js";

// iTerm exports this into its shells; a child carrying it registers as iTerm2 and misroutes AppleScript.
delete process.env.__CFBundleIdentifier;

import { WatcherClient } from "../ipc/client.js";
import { validateHubStatus } from "../ipc/validate.js";
import { formatHubStatus } from "./status-format.js";
import { resolveSelfSessionId } from "./pai-session-map.js";
import { runsUnderAgent } from "./agent-env.js";
import { createAdapter } from "./create-adapter.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

function printCommandList(): void {
  console.log(`aibroker ${getVersion()} — AI message broker daemon\n`);
  console.log("Commands:");
  console.log("  start              Start the daemon (refuses when one is already running)");
  console.log("  status             Show daemon status and adapter health");
  console.log("  stop | restart     Stop or restart the daemon (service, IPC shutdown, or daemon.pid)");
  console.log("  launch <dir|proj>  Open a Claude session there [--name N]: tmux window or iTerm tab");
  console.log("  send <name> <text> Type a message into a session, by name");
  console.log("  ping               Quick heartbeat check");
  console.log("  setup              Install service, MCP entry, hooks, env (--no-service --no-mcp --no-hooks --dry-run --force)");
  console.log("  doctor             Check the install; non-zero exit on a required failure");
  console.log("  uninstall          Remove what setup added (--purge also deletes ~/.aibroker)");
  console.log("  create-adapter     Scaffold a new adapter project");
  console.log("  ota <sub>          OTA hub: up|down|status|logs|setup-serve");
  console.log("  sessions <sub>     Session backup: snapshot|restore|checkpoint|list|install");
  console.log("  dispatch <project> Deliver a work order to a project's session (--stdin --json)");
  console.log("  ask <project>      Ask a session a question and wait for its reply (--stdin --json)");
  console.log("  audit              What one session did to another (--session|--trace|--bodies)");
  console.log("  todoist <sub>      Todoist inbound channel: auth|status|pause|resume");
  console.log("  agentish <verb>    AG2 wire format: spec|check|measure");
  console.log("  help               Show this help");
  console.log("\nFlags:");
  console.log("  --version, -v      Show version");
  console.log("  --help, -h         Help for any subcommand (never starts anything)");
}

function getVersion(): string {
  try {
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

const args = process.argv.slice(2);
const [command, ...rest] = args;

/**
 * Help is an answer, never an action. On 2026-10-21 `aibroker start --help`
 * started a SECOND daemon in the foreground and a bare `aibroker` started one
 * too — a help flag cannot be a start, and no verb may treat it as one.
 * Checked before anything else runs, so help starts nothing and imports no
 * daemon code.
 */
const HELP_FLAGS = ["--help", "-h"];
const helpRequested = args.some((a) => HELP_FLAGS.includes(a));
if (helpRequested && command !== undefined && command !== "help" && command !== "--version" && command !== "-v") {
  const subHelp: Record<string, string[]> = {
    start: [
      "Usage: aibroker start [--socket <path>]",
      "",
      "Start the daemon. Refuses to start a second one while another daemon is",
      "alive (live pid file or a socket that answers); a stale lock from a dead",
      "pid is taken over.",
    ],
    status: ["Usage: aibroker status", "", "Show daemon status and adapter health."],
    stop: ["Usage: aibroker stop", "", "Stop the daemon: active service, then IPC shutdown, then daemon.pid."],
    restart: ["Usage: aibroker restart", "", "Restart the daemon: the service restarts its own unit; otherwise stop, then start detached."],
    ping: ["Usage: aibroker ping", "", "Quick heartbeat check."],
    launch: [
      "Usage: aibroker launch <dir|pai-project> [--name N]",
      "",
      "Open a Claude session (tmux window / iTerm tab). Attaches when it is already running.",
    ],
    send: ["Usage: aibroker send <name> <text>", "", "Type a message into a session, by name."],
    setup: ["Usage: aibroker setup [--no-service --no-mcp --no-hooks --dry-run --force]", "", "Install service, MCP entry, hooks, env."],
    doctor: ["Usage: aibroker doctor", "", "Check the install; non-zero exit on a required failure."],
    uninstall: ["Usage: aibroker uninstall [--purge]", "", "Remove what setup added; --purge also deletes ~/.aibroker."],
    "create-adapter": [
      "Usage: aibroker create-adapter <adapter-name> [--display-name <Name>] [--output <dir>]",
      "",
      "Scaffold a new adapter project from the built-in template.",
    ],
    ota: ["Usage: aibroker ota <up|down|status|logs|setup-serve>", "", "OTA install hub (Docker + Tailscale Serve)."],
    sessions: ["Usage: aibroker sessions <snapshot|restore|checkpoint|list|install>", "", "Session backup."],
    dispatch: ["Usage: aibroker dispatch <project> [--stdin --json]", "", "Deliver a work order to a project's session."],
    ask: ["Usage: aibroker ask <project> [--stdin --json]", "", "Ask a session a question and wait for its reply."],
    audit: ["Usage: aibroker audit [--session|--trace|--bodies]", "", "What one session did to another."],
    todoist: ["Usage: aibroker todoist <auth|status|pause|resume|ingress>", "", "Todoist inbound channel."],
    agentish: ["Usage: aibroker agentish <spec|check|measure>", "", "AG2 wire format."],
  };
  const lines = subHelp[command];
  if (lines) {
    console.log(lines.join("\n"));
  } else {
    console.log(`aibroker ${command}: no dedicated help; see \`aibroker help\` for the command list.`);
  }
  process.exit(0);
}

// A bare `aibroker` is a person looking for the command list, not a request to
// start a daemon — that is what `start` is for.
if (command === undefined && !helpRequested) {
  printCommandList();
  process.exit(0);
}

/**
 * The hub's live session ids — the list the self-resolution's newest-entry
 * fallback must name. Empty when the daemon is unreachable: an id nobody can
 * confirm live is not resolved from, it is refused. The watcher ticks in the
 * daemon anyway, so a session whose daemon is down has nothing to arm into.
 */
async function hubSessionIds(): Promise<string[]> {
  try {
    const r = (await new WatcherClient(DAEMON_SOCKET_PATH).call_raw("sessions", {})) as {
      sessions?: Array<{ id?: string }>;
    };
    return (r.sessions ?? []).map((s) => s.id ?? "").filter(Boolean);
  } catch {
    return [];
  }
}

if (args.includes("--version") || args.includes("-v")) {
  console.log(`aibroker ${getVersion()}`);
  process.exit(0);
}

// Only the daemon (start / no verb) owns the log sink; every other verb is an
// interactive CLI whose output must not carry [aibroker ...] diagnostics.
if (command !== "start" && command !== undefined) silenceLog();

switch (command) {
  case "start":
    await startDaemon();
    break;

  case "status": {
    const client = new WatcherClient(DAEMON_SOCKET_PATH);
    try {
      const raw = await client.call_raw("status", {});
      const status = validateHubStatus(raw);

      for (const line of formatHubStatus(status)) console.log(line);
    } catch (err) {
      console.error("Daemon not running:", err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
    break;
  }

  // Service first, then IPC `shutdown`, then daemon.pid — no lsof (daemon-control.ts).
  case "stop":
  case "restart": {
    const { runStopRestart } = await import("./daemon-control.js");
    await runStopRestart(command);
    break;
  }

  case "ping": {
    const client = new WatcherClient(DAEMON_SOCKET_PATH);
    try {
      const result = await client.call_raw("ping", {});
      const uptime = typeof result.uptime === "number" ? result.uptime : 0;
      const hours = Math.floor(uptime / 3600);
      const mins = Math.floor((uptime % 3600) / 60);
      console.log(`pong — uptime: ${hours}h ${mins}m`);
    } catch (err) {
      console.error("Daemon not running:", err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
    break;
  }

  case "setup": {
    const { runSetup } = await import("./setup.js");
    await runSetup(rest);
    break;
  }

  case "uninstall": {
    const { runUninstall } = await import("./setup.js");
    await runUninstall(rest);
    break;
  }

  case "doctor": {
    const { runDoctor } = await import("./doctor.js");
    await runDoctor(rest);
    break;
  }

  case "ota": {
    const { runOta } = await import("./ota.js");
    await runOta(rest);
    break;
  }

  case "sessions": {
    const { runSessions } = await import("./sessions.js");
    await runSessions(rest);
    break;
  }

  case "dispatch": {
    const { runDispatch } = await import("./dispatch-cli.js");
    await runDispatch(rest);
    break;
  }

  case "ask": {
    const { runAsk } = await import("./ask-cli.js");
    await runAsk(rest);
    break;
  }

  case "audit": {
    const { runAudit } = await import("./audit-cli.js");
    await runAudit(rest);
    break;
  }

  case "todoist": {
    const { runTodoist } = await import("./todoist-cli.js");
    await runTodoist(rest);
    break;
  }

  case "inbound": {
    const { runInbound } = await import("./inbound-cli.js");
    await runInbound(rest);
    break;
  }

  case "issue": {
    const { runIssue } = await import("./issue-cli.js");
    await runIssue(rest);
    break;
  }

  case "a2a": {
    const { runA2A } = await import("./a2a-cli.js");
    await runA2A(rest);
    break;
  }

  case "agentish": {
    const { runAgentish } = await import("./agentish-cli.js");
    await runAgentish(rest);
    break;
  }

  case "budget": {
    const { runBudget } = await import("./budget-cli.js");
    await runBudget(rest);
    break;
  }

  case "launch": {
    const { runLaunch } = await import("./launch-cli.js");
    await runLaunch(rest);
    break;
  }

  case "send": {
    const { runSend } = await import("./send-cli.js");
    await runSend(rest);
    break;
  }

  case "outbound": {
    const { runOutbound } = await import("./outbound-cli.js");
    await runOutbound(rest);
    break;
  }

  case "create-adapter": {
    // Parse arguments: name, --display-name <Name>, --output <dir>
    const adapterName = rest.find((a) => !a.startsWith("--"));
    if (!adapterName) {
      console.error("Usage: aibroker create-adapter <adapter-name> [--display-name <Name>] [--output <dir>]");
      console.error("");
      console.error("Examples:");
      console.error("  aibroker create-adapter my-signal");
      console.error("  aibroker create-adapter my-signal --display-name Signal");
      console.error("  aibroker create-adapter my-signal --display-name Signal --output ~/adapters/my-signal");
      process.exit(1);
    }

    const displayNameIdx = rest.indexOf("--display-name");
    const displayName = displayNameIdx !== -1 ? rest[displayNameIdx + 1] : undefined;

    const outputIdx = rest.indexOf("--output");
    const outputDir = outputIdx !== -1 ? rest[outputIdx + 1] : undefined;

    await createAdapter({ adapterName, displayName, outputDir });
    break;
  }

  /**
   * manage — talk to the manager for a session, from ANY shell.
   *
   * NOT from inside the managed session's input box. That box cannot carry a
   * control channel: while the session is busy the terminal queues what you
   * type, so nothing reaches a hook until the current turn ends — which is
   * exactly when you most want to ask. Both observations came from watching it
   * rather than reasoning about it. So the channel is a separate shell: another
   * pane, another window, a key binding, anything that is not the input line of
   * the session you are trying to interrupt.
   *
   *   aibroker manage <session>                 what is going on
   *   aibroker manage <session> <objective>     start, or send an instruction
   *   aibroker manage <session> off             stop
   *   aibroker manage <session> clear-line      Ctrl-U the input line, verified
   */
  case "peer":
  case "fleet": {
    const { runPeer } = await import("./peer-cli.js");
    // `aibroker fleet` is the same thing people will actually type, so it is
    // the same command rather than a second one to keep in step.
    await runPeer(command === "fleet" ? ["fleet", ...rest] : rest);
    break;
  }

  case "manage": {
    // The session is optional when there is an obvious one: run from a pane,
    // the terminal's own id is in the environment and naming it again is
    // ceremony. Naming one is how you reach a DIFFERENT session — which is the
    // case that matters, since a busy session cannot answer for itself.
    const here = (process.env.ITERM_SESSION_ID ?? "").split(":").pop() ?? "";
    const first = args[1];
    const KEYWORDS = new Set(["", "status", "state", "what", "info", "show", "off", "stop", "pause", "resume", "now", "rules", "shift", "clear-line", "help", "?"]);
    // A leading dash is never a session name. Without this, `manage --help`
    // was read as "the session called --help" and answered "no live session
    // matches" — a true statement about a question nobody asked.
    const isKeyword = (s: string | undefined) =>
      s === undefined || s.startsWith("-") || KEYWORDS.has(s.toLowerCase());

    /**
     * BOTH ORDERS WORK, because both get typed.
     *
     * `manage <session> status` is the documented one and `manage status
     * <session>` is what a person writes when the verb is on their mind. The
     * second used to resolve to whatever pane the command ran in and turn the
     * rest into an objective — so `aibroker manage status <session>` created a
     * manager on a shell with the objective "status <session>". Accepting both
     * removes the trap rather than documenting around it.
     */
    let session: string;
    let rest: string[];
    /**
     * `rules` never takes a session, and the both-orders rule below would give
     * it one: in `manage rules from <path>` the word after the verb is not a
     * keyword, so it was read as the session name and the command failed with
     * "no live session matches from". The standing rules belong to every
     * managed session at once, so the only sensible session here is whichever
     * pane the command was typed in.
     */
    if ((first ?? "").toLowerCase() === "rules") {
      session = here || "-";
      rest = args.slice(1);
    } else if (!isKeyword(first)) {
      session = first!;
      rest = args.slice(2);
    } else if (isKeyword(first) && args[2] !== undefined && !isKeyword(args[2])) {
      session = args[2];
      rest = [first!, ...args.slice(3)];
    } else {
      session = here;
      rest = args.slice(1);
    }

    if (!session) {
      console.log("usage: aibroker manage [session] [objective | question | off | pause | resume | now | help]");
      console.log("       the session may be omitted when run inside one.");
      process.exit(1);
    }
    const client = new WatcherClient(DAEMON_SOCKET_PATH);
    try {
      const raw = (await client.call_raw("manage", {
        session,
        arg: rest.join(" "),
        operator: !runsUnderAgent(process.env),
      })) as { message?: string };
      console.log(raw?.message ?? "(no answer)");
    } catch (e) {
      console.error(`manage failed: ${(e as Error).message}`);
      process.exitCode = 1;
    }
    break;
  }

  /**
   * arm-self — a session arms its own goal, in one command with no arguments.
   *
   * Watched sessions coming out of a compact kept having to re-derive how to
   * demand their own arming: objective written to /tmp, TODO.md updated, the
   * operator asked to type the /goal line by hand — while the watcher holding
   * that objective sat in managers.json the whole time. A tool description
   * still leaves the model composing a call. This is the deterministic
   * shortcut: one verb, zero arguments, zero judgment — the session that types
   * it is the session it arms.
   *
   * It forces nothing but the arm. Pause, until, objective and nudges are the
   * operator's, and stay untouched; only the every-ask-is-now sentinel
   * (lastRearmAt = 0, the same thing `manage <session> now` sets) is written,
   * through the daemon's own loadState/saveState pair so this file keeps
   * exactly one format and one writer's habits.
   */
  case "arm-self": {
    if (rest.length) {
      console.error("arm-self takes no arguments — it arms the session that types it.");
      process.exit(1);
    }
    // The pane suffix is the form managers.json is keyed by; the manage command
    // resolves its own-session case the same way. When the environment is
    // silent — a session run under the Claude background daemon carries no
    // ITERM_SESSION_ID, and those are exactly the overnight supervised ones —
    // PAI's own session map answers for it (pai-session-map.ts), refusing as
    // before when it cannot name the caller beyond doubt.
    const selfId = (
      await resolveSelfSessionId({
        itermSessionId: process.env.ITERM_SESSION_ID,
        env: process.env,
        knownUids: hubSessionIds,
      })
    )?.id ?? "";
    if (!selfId) {
      console.error("run this from inside your own session — it arms the session that types it.");
      process.exit(1);
    }
    const { loadState, saveState } = await import("./manage.js");
    const managers = loadState();
    const m = managers[selfId];
    if (!m) {
      console.error(
        "no watcher for this session yet. Install one: aibroker manage supervise <objective> until <time> (or aibroker_manage action=supervise session=self).",
      );
      process.exit(1);
    }
    if (m.paused) {
      console.error("watcher is PAUSED — only the operator resumes it.");
      process.exit(1);
    }
    if (m.shift && Date.now() >= m.shift.until) {
      console.error("watcher's until has passed — re-supervise with a new until.");
      process.exit(1);
    }
    m.lastRearmAt = 0;
    saveState(managers);
    console.log(
      "arming on the next tick — the /goal line is typed even mid-turn (it queues at the turn boundary). " +
        "If the input line holds unsent text, clear or send it; the manager never types over live input.",
    );
    break;
  }

  case "help":
  case "--help":
  case "-h":
    printCommandList();
    break;

  default:
    console.error(`Unknown command: ${command}`);
    console.error("Usage: aibroker [start|status|stop|restart|launch|send|ping|setup|doctor|uninstall|create-adapter|ota|sessions|dispatch|ask|audit|inbound|issue|agentish|help]");
    process.exit(1);
}
