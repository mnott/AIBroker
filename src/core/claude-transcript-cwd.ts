/**
 * The working directory of a Claude session, read from its transcript
 * (`<projects>/<project-dir>/<uuid>.jsonl`, each line a JSON event, most
 * carrying "cwd"). A `claude attach` viewer's own cwd is where the viewer was
 * started, not where the session it shows works.
 */
import { closeSync, openSync, readSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { sameClaudeSession } from "./claude-attach.js";

const cache = new Map<string, string | null>();
const HEAD_BYTES = 256 * 1024;

function firstCwd(file: string): string | null {
  let fd: number | undefined;
  try {
    fd = openSync(file, "r");
    const buf = Buffer.alloc(HEAD_BYTES);
    const n = readSync(fd, buf, 0, HEAD_BYTES, 0);
    for (const line of buf.toString("utf8", 0, n).split("\n")) {
      if (!line.includes('"cwd"')) continue;
      try {
        const cwd = (JSON.parse(line) as { cwd?: unknown }).cwd;
        if (typeof cwd === "string" && cwd.startsWith("/")) return cwd;
      } catch { /* truncated or foreign line: next */ }
    }
  } catch { /* unreadable: no answer */ } finally {
    if (fd !== undefined) closeSync(fd);
  }
  return null;
}

/** cwd recorded in the transcript of session `uuid` (full or prefix); null when none. Cached per uuid. */
export function transcriptCwd(uuid: string, projectsDir = join(homedir(), ".claude", "projects")): string | null {
  const key = `${projectsDir}\0${uuid}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  let found: string | null = null;
  try {
    for (const dir of readdirSync(projectsDir)) {
      let files: string[];
      try { files = readdirSync(join(projectsDir, dir)); } catch { continue; }
      const f = files.find((x) => x.endsWith(".jsonl") && sameClaudeSession(x.slice(0, -6), uuid));
      if (f && (found = firstCwd(join(projectsDir, dir, f)))) break;
    }
  } catch { /* no projects dir */ }
  // A miss is not cached: the transcript may not exist yet.
  if (found) cache.set(key, found);
  return found;
}
