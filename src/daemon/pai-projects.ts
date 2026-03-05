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
import { log } from "../core/log.js";
import { createClaudeSession } from "../adapters/iterm/sessions.js";

const execFileAsync = promisify(execFile);

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
let _cache: Cache | null = null;

function isCacheValid(): boolean {
  if (!_cache) return false;
  return Date.now() - _cache.fetchedAt < CACHE_TTL_MS;
}

/** Invalidate the project list cache (e.g. after launching a project). */
export function invalidatePaiProjectCache(): void {
  _cache = null;
}

// ── Raw CLI call ──

/** Call `pai project names --json` and parse the JSON output. */
async function fetchFromCli(): Promise<PaiProject[]> {
  try {
    const { stdout } = await execFileAsync("pai", ["project", "names", "--json"], {
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
export async function listPaiProjects(): Promise<PaiProject[]> {
  if (isCacheValid()) {
    return _cache!.projects;
  }

  const projects = await fetchFromCli();
  _cache = { projects, fetchedAt: Date.now() };
  log(`pai-projects: loaded ${projects.length} project(s)`);
  return projects;
}

/**
 * Find a project by any of its names or aliases.
 * Matching is case-insensitive.
 */
export async function findPaiProject(name: string): Promise<PaiProject | undefined> {
  const projects = await listPaiProjects();
  const needle = name.toLowerCase();
  return projects.find(
    (p) =>
      p.name.toLowerCase() === needle ||
      p.names.some((n) => n.toLowerCase() === needle) ||
      p.slug.toLowerCase() === needle,
  );
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

  // Get effective config (project overrides global defaults)
  const effective = await getEffectiveConfig(name) ?? project.sessionConfig ?? {};

  const flags = effective.flags ?? "";
  const env = effective.env ?? {};

  // Build the shell command: export envs, cd, run claude
  const parts: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    parts.push(`export ${key}=${shellEscape(value)}`);
  }
  parts.push(`cd ${shellEscape(project.rootPath)}`);
  parts.push(`claude ${flags}`.trim());

  const command = parts.join(" && ");
  const sessionId = `pai-${project.slug}-${Date.now()}`;

  log(
    `pai-projects: launching visual session for "${project.name}" ` +
    `in "${project.rootPath}" (command: ${command})`,
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
