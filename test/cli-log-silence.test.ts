import "./home-guard.js";
/**
 * A CLI verb runs selectTransport() in-process; its diagnostic must not reach
 * the person's terminal. silenceLog() is what cli.ts calls for every verb but
 * the daemon.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { silenceLog } from "../src/core/log.js";
import { selectTransport } from "../src/transport/index.js";

test("selectTransport writes nothing to stderr/stdout once the log is silenced", () => {
  const prev = process.env.AIBROKER_TRANSPORT;
  process.env.AIBROKER_TRANSPORT = "tmux";
  const chunks: string[] = [];
  const oe = process.stderr.write, oo = process.stdout.write;
  const grab = ((c: string | Uint8Array) => (chunks.push(String(c)), true)) as typeof process.stderr.write;
  silenceLog();
  process.stderr.write = grab;
  process.stdout.write = grab;
  try {
    selectTransport();
  } finally {
    process.stderr.write = oe;
    process.stdout.write = oo;
    if (prev === undefined) delete process.env.AIBROKER_TRANSPORT; else process.env.AIBROKER_TRANSPORT = prev;
  }
  assert.deepEqual(chunks, []);
});
