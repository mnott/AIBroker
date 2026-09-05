/**
 * daemon/agentish-cli.ts — `aibroker agentish`, so a message can be checked
 * from a shell rather than trusted by eye.
 *
 * `aibroker agentish spec` prints the format itself, so a session that has
 * never seen AG2 can learn it with one command instead of being handed a
 * paragraph in the arming text and hoping it read it.
 *
 * `check --json` and `spec --json` exist so a team with no AIBroker daemon
 * can still run this validator as a CI step: parse the JSON, branch on exit
 * code and on each error's `code`, done. See docs/agentish.md, "Use in CI".
 * Exit codes are part of that contract and do not move: 0 the message is
 * valid, 1 it parsed but failed validation, 2 the invocation itself was
 * wrong (bad usage, a file that could not be read).
 */

import { readFileSync } from "node:fs";
import { AG2_SPEC, AG2_EXTENSIONS, AGENTISH_URI, check, measure } from "../agentish/index.js";
import { agentishStats, formatStatsReport } from "./agentish-stats.js";

const JSON_VERSION = "2";

function usage(): void {
  console.log("Usage: aibroker agentish <verb> [options]");
  console.log("");
  console.log("  spec [--json]                 Print the AG2 format and the extensions this validator adds");
  console.log("  check <file|-> [earlier...] [--json]");
  console.log("                                Validate a message; earlier messages supply @n symbols");
  console.log("  measure <file> <prose-file>   Token count, agentish vs. a prose twin");
  console.log("  stats [--since YYYY-MM-DD] [--json]");
  console.log("                                AG2 vs. prose on real inter-session traffic, from the audit log");
  console.log("");
  console.log("`-` reads the message to check from stdin.");
  console.log("Exit codes (check): 0 valid, 1 invalid, 2 bad usage or a file could not be read.");
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks).toString("utf8");
}

async function readArg(path: string): Promise<string> {
  return path === "-" ? readStdin() : readFileSync(path, "utf8");
}

/** Strip a boolean flag out of an argv-like array, wherever it appears. */
function takeFlag(args: string[], flag: string): { rest: string[]; present: boolean } {
  const present = args.includes(flag);
  return { rest: args.filter((a) => a !== flag), present };
}

export async function runAgentish(args: string[]): Promise<void> {
  const [verb, ...rawRest] = args;

  if (!verb || verb === "help" || verb === "--help" || verb === "-h") {
    usage();
    return;
  }

  if (verb === "spec") {
    const { present: json } = takeFlag(rawRest, "--json");
    if (json) {
      console.log(JSON.stringify({ version: JSON_VERSION, spec: AG2_SPEC, extensions: AG2_EXTENSIONS, uri: AGENTISH_URI }));
    } else {
      console.log(AG2_SPEC);
      console.log(AG2_EXTENSIONS);
    }
    return;
  }

  if (verb === "check") {
    const { rest, present: json } = takeFlag(rawRest, "--json");
    const [file, ...earlierFiles] = rest;
    if (!file) {
      usage();
      process.exitCode = 2;
      return;
    }
    let msg: string;
    let earlier: string[];
    try {
      msg = await readArg(file);
      earlier = earlierFiles.map((f) => readFileSync(f, "utf8"));
    } catch (e) {
      console.log(`ERR could not read a message file: ${e instanceof Error ? e.message : String(e)}`);
      process.exitCode = 2;
      return;
    }
    const { kind, fields, symbols, errors, details } = check(msg, earlier);
    const ok = errors.length === 0;
    if (json) {
      console.log(JSON.stringify({ version: JSON_VERSION, kind, fields, errors: details, ok }));
    } else {
      for (const e of errors) console.log(`ERR ${e}`);
      console.log(
        `${kind ?? "?"} ${Object.keys(fields).length} fields ${Object.keys(symbols).length} symbols ${ok ? "ok" : "INVALID"}`,
      );
    }
    process.exitCode = ok ? 0 : 1;
    return;
  }

  if (verb === "stats") {
    const sinceIdx = rawRest.indexOf("--since");
    const sinceStr = sinceIdx >= 0 ? rawRest[sinceIdx + 1] : undefined;
    const since = sinceStr ? new Date(`${sinceStr}T00:00:00.000Z`) : undefined;
    if (sinceStr && (since === undefined || Number.isNaN(since.getTime()))) {
      console.log(`ERR --since must be YYYY-MM-DD, got ${JSON.stringify(sinceStr)}`);
      process.exitCode = 2;
      return;
    }
    const report = agentishStats({ since });
    if (rawRest.includes("--json")) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(formatStatsReport(report));
    }
    return;
  }

  if (verb === "measure") {
    const [file, proseFile] = rawRest;
    if (!file || !proseFile) {
      usage();
      process.exitCode = 2;
      return;
    }
    let a: string, p: string;
    try {
      [a, p] = [readFileSync(file, "utf8"), readFileSync(proseFile, "utf8")];
    } catch (e) {
      console.log(`ERR could not read a message file: ${e instanceof Error ? e.message : String(e)}`);
      process.exitCode = 2;
      return;
    }
    const { agentish, prose, ratio, valid } = measure(a, p);
    console.log(`agentish=${agentish} prose=${prose} ratio=${ratio.toFixed(2)} valid=${valid ? "yes" : "no"}`);
    return;
  }

  usage();
  process.exitCode = 2;
}
