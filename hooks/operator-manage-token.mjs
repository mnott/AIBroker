#!/usr/bin/env node
/**
 * operator-manage-token.mjs — UserPromptSubmit hook. When the prompt the human
 * typed in the terminal is itself a manage command that ends a goal
 * (`manage <name> off|pause|shift off`, also `/manage …` and `aibroker manage …`),
 * write a one-shot token ~/.aibroker/operator-tokens/<session>-<action>.json
 * (5 minutes) that the daemon consumes on the matching call.
 *
 * Only `payload.prompt` is read, never tool output. A prompt that starts with
 * "[" ("[Session:X] …", "[Task…", "[PAILot] …") came from an agent or a channel
 * and never counts. Prints nothing; the prompt goes through untouched.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => (raw += d));
process.stdin.on("end", run);
setTimeout(run, 2_000).unref();

let done = false;
function run() {
  if (done) return;
  done = true;
  let prompt = "";
  try { prompt = String(JSON.parse(raw).prompt ?? ""); } catch { /* not a hook payload */ }
  if (/^\s*\[/.test(prompt) || prompt.includes("\n")) process.exit(0);

  const ACTION = "(off|stop|pause|shift\\s+(?:off|stop|end|stand\\s+down))";
  const head = "^\\s*(?:(?:aibroker|broker)\\s+manage|/manage|manage)\\s+";
  const verbFirst = prompt.match(new RegExp(`${head}${ACTION}\\s+(.+?)\\s*$`, "i"));
  const nameFirst = prompt.match(new RegExp(`${head}(.+?)\\s+${ACTION}\\s*$`, "i"));
  const [word, session] = nameFirst ? [nameFirst[2], nameFirst[1]] : verbFirst ? [verbFirst[1], verbFirst[2]] : [];
  if (!word) process.exit(0);
  const action = /^shift/i.test(word) ? "shift-off" : /^pause/i.test(word) ? "pause" : "off";

  const slug = session.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (!slug) process.exit(0);
  const dir = join(homedir(), ".aibroker", "operator-tokens");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, `${slug}-${action}.json`), JSON.stringify({ expiresAt: Date.now() + 5 * 60_000 }), { mode: 0o600 });
  process.exit(0);
}
