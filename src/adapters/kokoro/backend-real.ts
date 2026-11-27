/**
 * adapters/kokoro/backend-real.ts — the real side effects behind backend-select:
 * run an install step and measure time to first audio by starting the sidecar
 * for a single request. Never imported by tests (they inject fakes).
 */

import { spawn, spawnSync } from "node:child_process";
import { homedir } from "node:os";
import net from "node:net";
import type { InstallStep, TtsBackend } from "./backend-select.js";
import { venvPythonFor } from "./backend-select.js";
import { sidecarScriptPath } from "./sidecar.js";

export async function realExec(step: InstallStep): Promise<{ ok: boolean; out?: string }> {
  const r = spawnSync(step.cmd, step.args, { encoding: "utf8" });
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}` || (r.error?.message ?? "") };
}

/** Start the sidecar on a private port, time one short request to its first audio chunk, stop it. */
export async function realMeasure(backend: TtsBackend, home: string = homedir()): Promise<number> {
  if (backend === "cpu") throw new Error("cpu backend has no sidecar to measure");
  const port = 40_000 + (process.pid % 1000);
  const proc = spawn(venvPythonFor(home, backend), ["-I", sidecarScriptPath()], {
    env: { ...process.env, AIBROKER_TTS_SIDECAR_PORT: String(port), AIBROKER_TTS_BACKEND: backend },
    stdio: "ignore",
  });
  try {
    const deadline = Date.now() + 120_000;
    for (;;) {
      if (await connectOnce(port, null)) break;
      if (proc.exitCode !== null || Date.now() > deadline) throw new Error("sidecar did not become ready");
      await new Promise((r) => setTimeout(r, 500));
    }
    const t0 = Date.now();
    const ms = await connectOnce(port, t0);
    if (typeof ms !== "number") throw new Error("no audio from sidecar");
    return ms;
  } finally {
    proc.kill("SIGTERM");
  }
}

/** With t0 null: true when the port accepts. Otherwise send a request and resolve ms to the first chunk. */
function connectOnce(port: number, t0: number | null): Promise<number | boolean> {
  return new Promise((resolve) => {
    const s = net.createConnection({ host: "127.0.0.1", port });
    const timer = setTimeout(() => { s.destroy(); resolve(false); }, 30_000);
    s.once("error", () => { clearTimeout(timer); resolve(false); });
    s.once("connect", () => {
      if (t0 === null) { clearTimeout(timer); s.destroy(); resolve(true); return; }
      s.write(JSON.stringify({ text: "Ready.", voice: "bm_fable", speed: 1 }) + "\n");
    });
    let buf = "";
    s.on("data", (d) => {
      buf += d.toString();
      if (t0 !== null && buf.includes("chunk_b64")) { clearTimeout(timer); s.destroy(); resolve(Date.now() - t0); }
    });
  });
}
