/**
 * daemon/pai-projects.ts — PAI named session integration.
 *
 * Shells out to the `pai` CLI to list and launch named Claude project sessions.
 * Results are cached for 30 seconds to avoid hammering the CLI on every request.
 *
 * Usage:
 *   const projects = await listPaiProjects();
 *   const project = await findPaiProject("whazaa");
 *   const { pid, sessionId } = await launchPaiProject("whazaa");
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { log } from "../core/log.js";
import { createClaudeSession } from "../adapters/iterm/sessions.js";

const execFileAsync = promisify(execFile);

/**
 * The restore manifest, read directly rather than through daemon/sessions.ts.
 *
 * sessions.ts owns this file and is the only writer; it is imported here by
 * path instead of by module because sessions.ts pulls in daemon/index.js, and
 * daemon/index → core-handlers → pai-projects closes an import cycle. A
 * six-line read is the cheaper of the two couplings.
 */
const RESTORE_MANIFEST = join(homedir(), ".aibroker", "session-restore.json");

// ── Types ──

export interface PaiProject {
  name: string;
  names: string[];
  slug: string;
  displayName: string;
  rootPath: string;
  sessionCount: number;
  lastActive: string;
  sessionConfig?: {
    permission?: string;
    flags?: string;
    env?: Record<string, string>;
    autoStart?: boolean;
  };
}

// ── Cache ──

interface Cache {
  projects: PaiProject[];
  fetchedAt: number;
}

const CACHE_TTL_MS = 30_000;
let _cache: Cache | null = null;       // curated shortlist
let _cacheAll: Cache | null = null;    // all active projects (--all)

/** Invalidate the project list cache (e.g. after launching a project). */
export function invalidatePaiProjectCache(): void {
  _cache = null;
  _cacheAll = null;
}

// ── Raw CLI call ──

/** Call `pai project names --json` and parse the JSON output. */
async function fetchFromCli(all: boolean): Promise<PaiProject[]> {
  try {
    const args = all ? ["project", "names", "--json", "--all"] : ["project", "names", "--json"];
    const { stdout } = await execFileAsync("pai", args, {
      timeout: 5_000,
      env: { ...process.env },
    });

    const raw = JSON.parse(stdout.trim());
    if (!Array.isArray(raw)) {
      log("pai-projects: unexpected output shape (not array)");
      return [];
    }

    return raw.map((item: Record<string, unknown>) => ({
      name: String(item.name ?? ""),
      names: Array.isArray(item.names) ? item.names.map(String) : [String(item.name ?? "")],
      slug: String(item.slug ?? ""),
      displayName: String(item.display_name ?? item.name ?? ""),
      rootPath: String(item.root_path ?? ""),
      sessionCount: typeof item.session_count === "number" ? item.session_count : 0,
      lastActive: String(item.last_active ?? ""),
      sessionConfig: item.session_config
        ? {
            permission: typeof (item.session_config as Record<string, unknown>).permission === "string"
              ? (item.session_config as Record<string, unknown>).permission as string
              : undefined,
            flags: typeof (item.session_config as Record<string, unknown>).flags === "string"
              ? (item.session_config as Record<string, unknown>).flags as string
              : undefined,
            env:
              (item.session_config as Record<string, unknown>).env != null &&
              typeof (item.session_config as Record<string, unknown>).env === "object"
                ? ((item.session_config as Record<string, unknown>).env as Record<string, string>)
                : undefined,
            autoStart:
              typeof (item.session_config as Record<string, unknown>).autoStart === "boolean"
                ? ((item.session_config as Record<string, unknown>).autoStart as boolean)
                : undefined,
          }
        : undefined,
    }));
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    // pai not installed, no projects, or timeout — all non-fatal
    if (msg.includes("ENOENT")) {
      log("pai-projects: `pai` binary not found — returning empty project list");
    } else if (msg.includes("ETIMEDOUT") || msg.includes("timed out")) {
      log("pai-projects: `pai project names --json` timed out");
    } else {
      log(`pai-projects: CLI error — ${msg}`);
    }
    return [];
  }
}

// ── Public API ──

/**
 * Return all named PAI projects.
 * Results are cached for 30 seconds.
 */
export async function listPaiProjects(all = false): Promise<PaiProject[]> {
  const cache = all ? _cacheAll : _cache;
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.projects;
  }

  const projects = await fetchFromCli(all);
  const entry = { projects, fetchedAt: Date.now() };
  if (all) _cacheAll = entry; else _cache = entry;
  log(`pai-projects: loaded ${projects.length} project(s)${all ? " (all)" : ""}`);
  return projects;
}

/** Case-insensitive match of a needle against a project's name, aliases or slug. */
function matchProject(projects: PaiProject[], name: string): PaiProject | undefined {
  const needle = name.trim().toLowerCase();
  if (!needle) return undefined;
  return projects.find(
    (p) =>
      p.name.toLowerCase() === needle ||
      p.names.some((n) => n.toLowerCase() === needle) ||
      p.slug.toLowerCase() === needle,
  );
}

/**
 * Find a project by any of its names or aliases, among CURATED projects only.
 *
 * Deliberately narrower than findPaiProject(). The `--all` set is ~118 entries
 * with empty `names` and genuine ambiguity — three separate registry rows share
 * the display name "Glidr" at different paths — so resolving a task against it
 * silently dispatches work to the wrong directory. Bus participation therefore
 * stays opt-in: a project joins by being given an alias
 * (`pai project name <identifier> <shortname>`), and anything without one is
 * reported as unlaunchable rather than guessed at.
 *
 * Matching is case-insensitive.
 */
export async function findCuratedPaiProject(name: string): Promise<PaiProject | undefined> {
  return matchProject(await listPaiProjects(false), name);
}

/**
 * Find a project by any of its names or aliases.
 * Matching is case-insensitive.
 */
export async function findPaiProject(name: string): Promise<PaiProject | undefined> {
  // Resolve against ALL registered projects, not just the curated shortlist —
  // the picker now offers every project (listPaiProjects(true)), so a launch of a
  // non-shortlisted project (e.g. glidr) must resolve here too, or it fails with
  // "project not found".
  return matchProject(await listPaiProjects(true), name);
}

/**
 * Get the effective (merged) config for a PAI project.
 *
 * Calls `pai project config <name> --json` which returns project config,
 * global defaults, and the merged effective config. We use `effective`
 * because it respects the resolution order: project overrides globals.
 */
export async function getEffectiveConfig(name: string): Promise<{
  permission?: string;
  flags?: string;
  env?: Record<string, string>;
  autoStart?: boolean;
} | undefined> {
  try {
    const { stdout } = await execFileAsync("pai", ["project", "config", name, "--json"], {
      timeout: 5_000,
      env: { ...process.env },
    });
    const data = JSON.parse(stdout.trim());
    return data.effective ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Launch Claude in the named project's directory as a visual iTerm2 tab.
 *
 * Uses `pai project config <name> --json` to get the effective (merged)
 * config, then builds a shell command that:
 * 1. cd's to the project directory
 * 2. Exports any env vars from the config
 * 3. Runs `claude` with the configured flags
 *
 * Opens a new iTerm2 tab via AppleScript and types the command into it.
 * Returns the iTerm2 session ID for registration with HybridSessionManager.
 */
export async function launchPaiProject(
  name: string,
): Promise<{ itermSessionId: string; sessionId: string }> {
  const project = await findPaiProject(name);
  if (!project) {
    throw new Error(`PAI project "${name}" not found`);
  }
  return launchResolvedPaiProject(project);
}

/**
 * Launch an ALREADY-RESOLVED project.
 *
 * Callers that resolved against a narrower set than findPaiProject() must use
 * this. Passing a name back into launchPaiProject() launders it through the
 * `--all` set a second time, so a careful curated resolve can still end up
 * opening a different project that happens to share the display name — there
 * are three "Glidr" rows at three different paths. Once resolution has picked
 * a row, that row is what gets launched.
 */
/**
 * Where a session of this name was last actually seen running, if it still exists.
 *
 * PAI's project registry records where a project was DECLARED to live; the
 * restore manifest records where its sessions were OBSERVED to live. Renaming a
 * directory goes unnoticed by the first and is picked up within five minutes by
 * the second, so when the declared path is gone the manifest is the natural
 * place to look for what it became.
 */
function lastSeenCwdForName(name: string): string | null {
  try {
    if (!existsSync(RESTORE_MANIFEST)) return null;
    const raw = JSON.parse(readFileSync(RESTORE_MANIFEST, "utf-8")) as unknown;
    const entries = (Array.isArray(raw) ? raw : (raw as { entries?: unknown }).entries) as
      | Array<{ name?: string; cwd?: string }>
      | undefined;
    if (!Array.isArray(entries)) return null;
    const hit = entries.find(
      (e) => e?.name === name && typeof e.cwd === "string" && existsSync(e.cwd),
    );
    return hit?.cwd ?? null;
  } catch {
    // The manifest is a hint, not a dependency. A bad one must not turn a
    // clear "directory is gone" error into an unrelated parse failure.
    return null;
  }
}

/**
 * A launch that cannot succeed no matter how often it is retried.
 *
 * Carries `permanent` so the caller — and PAI's task poller across the IPC
 * boundary — can tell "this will never work" from "this did not work yet" and
 * park the task instead of re-dispatching it every fifteen minutes forever.
 */
export class ProjectRootMissingError extends Error {
  readonly code = "project_root_missing";
  readonly permanent = true;
  constructor(
    readonly projectName: string,
    readonly rootPath: string,
  ) {
    super(
      `PAI project "${projectName}" points at "${rootPath}", which does not exist, ` +
        `and no session of that name has been seen in a directory that does. ` +
        `Run \`pai project health\` to find where it went, then ` +
        `\`pai project move <slug> <new-path>\` to make the registry agree.`,
    );
    this.name = "ProjectRootMissingError";
  }
}

export async function launchResolvedPaiProject(
  project: PaiProject,
  opts: {
    /**
     * What the session should do instead of resuming.
     *
     * Queued as the second initial-prompt line, so it runs immediately after
     * `/Name` and before anything else can reach the session. MUST be a single
     * line: Claude Code splits the initial-prompt argument on newlines and
     * treats each as a separate queued prompt, so an embedded newline silently
     * fragments the instruction into several.
     */
    initialPrompt?: string;
  } = {},
): Promise<{ itermSessionId: string; sessionId: string }> {
  const name = project.name;

  // Never type a `cd` into a terminal without knowing it can succeed.
  //
  // The command below is handed to a fresh iTerm2 tab as one `cd … && claude …`
  // string. If the `cd` fails the tab stays open on a bare shell, `claude` never
  // runs, and the readiness probe waits out its full 90s before reporting the
  // session "unreachable" — indistinguishable, from the outside, from a slow
  // start. On 2026-08-04 a renamed directory turned that into a terminal window
  // every fifteen minutes for nine hours.
  //
  // When the declared path is gone, the restore manifest is asked where the
  // session actually ran. That is not a guess: the 5-minute snapshot writes it
  // from observation, so it is the one record that follows a directory when it
  // is renamed. Launching from it recovers automatically, which is the whole
  // point — but the registry stays stale until somebody fixes it, so the log
  // says exactly what to run. Silent divergence is what produced this bug.
  let rootPath = project.rootPath;
  if (!rootPath || !existsSync(rootPath)) {
    const observed = lastSeenCwdForName(project.displayName || name);
    if (!observed) {
      const err = new ProjectRootMissingError(name, rootPath);
      log(`pai-projects: refusing to launch "${name}" — ${err.message}`);
      throw err;
    }
    log(
      `pai-projects: "${name}" is registered at "${rootPath}", which is gone; ` +
        `launching from the last observed directory "${observed}" instead. ` +
        `Make it permanent with: pai project move ${project.slug} ${JSON.stringify(observed)}`,
    );
    rootPath = observed;
  }

  // Get effective config (project overrides global defaults)
  const effective = await getEffectiveConfig(name) ?? project.sessionConfig ?? {};

  const flags = effective.flags ?? "";
  const env = effective.env ?? {};

  // Build the shell command: export envs, cd, run claude
  const parts: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    parts.push(`export ${key}=${shellEscape(value)}`);
  }
  parts.push(`cd ${shellEscape(rootPath)}`);
  // Replicate PAI's launch: `--name` sets the session label, and the single
  // initial-prompt arg `$'/Name <name>\n<next>'` advance-enters the /Name skill
  // (tab + /resume label) and then does one more thing.
  //
  // That second line is normally `go` — resume from TODO.md. A caller with work
  // to hand over replaces it, and that replacement is the whole point:
  //
  // Claude Code holds initial-prompt lines as QUEUED PROMPTS, and a queued
  // prompt is not on the screen anywhere. Measured 2026-08-04: from t≈6s the
  // input box renders empty and every readiness check passes, while `/Name` and
  // `go` sit invisibly pending until t≈14s. A dispatcher that waited for
  // "ready" and then TYPED its work order landed it inside that window, so the
  // task, the rename and the resume all raced in one input. No amount of screen
  // reading can close that gap — the state is not rendered.
  //
  // Putting the work order in the launch removes the race by construction
  // rather than by timing: the queue is ordered, nothing else types, and there
  // is no window to lose.
  const label = project.displayName || project.name;
  const ansiC = label.replace(/'/g, "");
  // Single line only — see `initialPrompt` above. Newlines are what separate
  // queued prompts, so one embedded here would split the instruction in two.
  const next = (opts.initialPrompt ?? "go").replace(/[\r\n]+/g, " ").replace(/'/g, "");
  // Double backslash — collapsed to `\n` by AppleScript, then to a real newline
  // by zsh's $'...', so the two lines arrive as two queued inputs.
  const prompt = `$'/Name ${ansiC}\\\\n${next}'`;
  const claudeFlags = flags.includes("--dangerously-skip-permissions")
    ? flags
    : `--dangerously-skip-permissions ${flags}`.trim();
  parts.push(`claude ${claudeFlags} --name ${shellEscape(label)} ${prompt}`);

  const command = parts.join(" && ");
  const sessionId = `pai-${project.slug}-${Date.now()}`;

  log(
    `pai-projects: launching visual session for "${project.name}" ` +
    `in "${rootPath}" (command: ${command})`,
  );

  // Open new iTerm2 tab and run the command
  const itermSessionId = createClaudeSession(command);
  if (!itermSessionId) {
    throw new Error(`Failed to create iTerm2 tab for project "${name}"`);
  }

  log(`pai-projects: opened iTerm2 session ${itermSessionId} for project "${project.name}"`);

  return { itermSessionId, sessionId };
}

/** Escape a string for safe use in a shell command. */
function shellEscape(s: string): string {
  if (/^[a-zA-Z0-9_./:=-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, "'\\''")}'`;
}
