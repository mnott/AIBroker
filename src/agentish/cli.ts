#!/usr/bin/env node
/**
 * agentish/cli.ts — standalone `agentish` command. Imports only ./index.js:
 * no daemon, no other repo modules, no network. Vendor dist/agentish/index.js
 * and dist/agentish/cli.js together and it runs anywhere with Node.
 *
 * Exit codes: 0 all valid, 1 some invalid, 2 usage or unreadable input.
 */

import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { AG2_SPEC, AG2_EXTENSIONS, AGENTISH_URI, check, expand } from "./index.js";

const JSON_VERSION = "2";

function usage(): void {
  console.log("Usage: agentish <verb> [options]");
  console.log("  check <file|-> [earlier...] [--json]   Validate one message; earlier files supply @n symbols");
  console.log("  expand <file|-> [earlier...] [--json]  Inline every @n reference");
  console.log("  check-log <file|-> [--json]            Validate a stream: blank-line separated messages,");
  console.log("                                         or JSONL with a `body` field (aibroker audit.jsonl)");
  console.log("  spec [--json]                          Print the AG2 format");
  console.log("Exit codes: 0 all valid, 1 some invalid, 2 usage or read error.");
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks).toString("utf8");
}

async function readArg(path: string): Promise<string> {
  return path === "-" ? readStdin() : readFileSync(path, "utf8");
}

function takeFlag(args: string[], flag: string): { rest: string[]; present: boolean } {
  return { rest: args.filter((a) => a !== flag), present: args.includes(flag) };
}

/** Split a log into messages: JSONL lines with a string `body`, else blank-line blocks. */
export function splitLog(text: string): string[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  const bodies: string[] = [];
  let jsonl = lines.length > 0;
  for (const l of lines) {
    try {
      const o = JSON.parse(l) as unknown;
      if (o && typeof o === "object" && typeof (o as { body?: unknown }).body === "string") {
        bodies.push((o as { body: string }).body);
        continue;
      }
    } catch {
      /* not JSON */
    }
    jsonl = false;
    break;
  }
  if (jsonl) return bodies;
  return text
    .split(/\r?\n[ \t]*\r?\n/)
    .map((b) => b.trim())
    .filter((b) => b !== "");
}

export async function runAgentishCli(args: string[]): Promise<void> {
  const [verb, ...rawRest] = args;
  if (!verb || verb === "help" || verb === "--help" || verb === "-h") {
    usage();
    return;
  }

  if (verb === "spec") {
    if (rawRest.includes("--json")) {
      console.log(JSON.stringify({ version: JSON_VERSION, spec: AG2_SPEC, extensions: AG2_EXTENSIONS, uri: AGENTISH_URI }));
    } else {
      console.log(AG2_SPEC);
      console.log(AG2_EXTENSIONS);
    }
    return;
  }

  if (verb === "check" || verb === "expand") {
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
    if (verb === "check") {
      const { kind, fields, symbols, errors, details } = check(msg, earlier);
      const ok = errors.length === 0;
      if (json) console.log(JSON.stringify({ version: JSON_VERSION, kind, fields, errors: details, ok }));
      else {
        for (const e of errors) console.log(`ERR ${e}`);
        console.log(`${kind ?? "?"} ${Object.keys(fields).length} fields ${Object.keys(symbols).length} symbols ${ok ? "ok" : "INVALID"}`);
      }
      process.exitCode = ok ? 0 : 1;
    } else {
      const { expanded, symbols, errors, details } = expand(msg, earlier);
      const ok = errors.length === 0;
      if (json) console.log(JSON.stringify({ version: JSON_VERSION, expanded, symbols, errors: details, ok }));
      else {
        for (const e of errors) console.log(`ERR ${e}`);
        console.log(expanded);
      }
      process.exitCode = ok ? 0 : 1;
    }
    return;
  }

  if (verb === "check-log") {
    const { rest, present: json } = takeFlag(rawRest, "--json");
    const [file] = rest;
    if (!file || rest.length > 1) {
      usage();
      process.exitCode = 2;
      return;
    }
    let text: string;
    try {
      text = await readArg(file);
    } catch (e) {
      console.log(`ERR could not read the log: ${e instanceof Error ? e.message : String(e)}`);
      process.exitCode = 2;
      return;
    }
    const messages = splitLog(text);
    const codes: Record<string, number> = {};
    const results = messages.map((m, i) => {
      const r = check(m);
      const errs = r.details.map((d) => d.code);
      for (const c of errs) codes[c] = (codes[c] ?? 0) + 1;
      return { index: i + 1, kind: r.kind, ok: errs.length === 0, codes: errs };
    });
    const valid = results.filter((r) => r.ok).length;
    const summary = { total: results.length, valid, invalid: results.length - valid, codes };
    if (json) {
      console.log(JSON.stringify({ version: JSON_VERSION, results, summary }));
    } else {
      for (const r of results) console.log(`#${r.index} ${r.kind ?? "?"} ${r.ok ? "ok" : `FAIL ${r.codes.join(",")}`}`);
      console.log(`total=${summary.total} valid=${summary.valid} invalid=${summary.invalid}`);
      for (const [c, n] of Object.entries(codes).sort()) console.log(`  ${c} ${n}`);
    }
    process.exitCode = summary.invalid === 0 ? 0 : 1;
    return;
  }

  usage();
  process.exitCode = 2;
}

let isMain = false;
try {
  isMain = !!process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
} catch {
  /* not run directly */
}
if (isMain) void runAgentishCli(process.argv.slice(2));
