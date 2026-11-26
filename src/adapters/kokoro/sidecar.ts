/**
 * adapters/kokoro/sidecar.ts — client for the Metal TTS sidecar (tts-sidecar/server.py).
 *
 * The daemon spawns a Python process that loads Kokoro-82M on Apple Metal once
 * and answers synthesis requests over 127.0.0.1 TCP (~100 ms to first audio vs
 * ~4.5 s cold on the kokoro-js CPU path). This module owns:
 *   - backend selection (AIBROKER_TTS_BACKEND=cpu|mlx; mlx when the venv exists)
 *   - spawning / restarting the sidecar and writing its port file
 *   - a streaming client that yields Float32 PCM chunks per sentence
 * Every failure — missing venv, dead process, protocol error — is swallowed by
 * the caller in tts.ts, which falls back to kokoro-js on CPU.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, homedir } from "node:os";
import { join } from "node:path";
import net from "node:net";

import { log } from "../../core/log.js";

export const SIDECAR_SCRIPT_REL = "tts-sidecar/server.py";
export const VENV_PYTHON = join(homedir(), ".cache", "aibroker-tts", "mlx-venv", "bin", "python");
/** Where the running sidecar's port is recorded (daemon writes, clients read). */
export const PORT_FILE = join(homedir(), ".aibroker", "tts-sidecar.port");

const CONNECT_TIMEOUT_MS = 2_000;

/** Which backend serves speech: cpu|mlx; mlx only when the venv interpreter exists. */
export function resolveBackend(env: NodeJS.ProcessEnv = process.env): "cpu" | "mlx" {
  const forced = (env.AIBROKER_TTS_BACKEND ?? "").toLowerCase().trim();
  if (forced === "cpu") return "cpu";
  if (forced === "mlx") return "mlx";
  return existsSync(VENV_PYTHON) ? "mlx" : "cpu";
}

/** Absolute path of the sidecar script, resolved against the repo root. */
export function sidecarScriptPath(): string {
  const fromEnv = process.env.AIBROKER_TTS_SIDECAR_SCRIPT;
  if (fromEnv) return fromEnv;
  // src/adapters/kokoro/sidecar.ts → repo root two levels up in src/, three in dist/
  return join(import.meta.dirname, "..", "..", "..", SIDECAR_SCRIPT_REL);
}

/** Write the port file with 0600 perms so only this user can read it. */
export function writePortFile(port: number): void {
  try {
    mkdirSync(dirname(PORT_FILE), { recursive: true });
    writeFileSync(PORT_FILE, `${port}\n`, { mode: 0o600 });
  } catch (err) {
    log(`tts-sidecar: could not write port file — ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function readPortFile(): number | null {
  try {
    const raw = readFileSync(PORT_FILE, "utf-8").trim();
    const port = Number(raw);
    return Number.isInteger(port) && port > 0 && port < 65_536 ? port : null;
  } catch {
    return null;
  }
}

export function removePortFile(): void {
  try { if (existsSync(PORT_FILE)) unlinkSync(PORT_FILE); } catch { /* ignore */ }
}

/** True when the recorded sidecar answers a connect on its port. */
export async function probeSidecar(port: number, timeoutMs = CONNECT_TIMEOUT_MS): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.createConnection({ host: "127.0.0.1", port });
    const timer = setTimeout(() => { sock.destroy(); resolve(false); }, timeoutMs);
    sock.once("connect", () => { clearTimeout(timer); sock.destroy(); resolve(true); });
    sock.once("error", () => { clearTimeout(timer); resolve(false); });
  });
}

/** One request: send JSON, read streamed chunk frames until done/error. */
export async function* streamSidecar(
  port: number,
  req: { text: string; voice: string; speed?: number },
  signal?: AbortSignal,
): AsyncGenerator<{ audio: Float32Array; sampleRate: number }> {
  const sock = await new Promise<net.Socket>((resolve, reject) => {
    const s = net.createConnection({ host: "127.0.0.1", port });
    const timer = setTimeout(() => { s.destroy(); reject(new Error("sidecar connect timeout")); }, CONNECT_TIMEOUT_MS);
    s.once("connect", () => { clearTimeout(timer); resolve(s); });
    s.once("error", (e) => { clearTimeout(timer); reject(e); });
  });

  try {
    sock.write(JSON.stringify(req) + "\n");

    let buf = "";
    let sampleRate = 24_000;
    const readLine = async (): Promise<string> => {
      for (;;) {
        if (signal?.aborted) throw new Error("TTS: synthesis aborted");
        const nl = buf.indexOf("\n");
        if (nl >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          return line;
        }
        const data = await new Promise<Buffer>((resolve, reject) => {
          sock.once("data", resolve);
          sock.once("error", reject);
          sock.once("end", () => reject(new Error("sidecar closed stream")));
        });
        buf += data.toString("utf-8");
      }
    };

    const header = JSON.parse(await readLine()) as { ok?: boolean; sample_rate?: number; error?: string };
    if (header.error) throw new Error(`sidecar: ${header.error}`);
    if (!header.ok) throw new Error("sidecar: missing ok header");
    sampleRate = header.sample_rate ?? 24_000;

    for (;;) {
      const line = JSON.parse(await readLine()) as { chunk_b64?: string; done?: boolean; error?: string };
      if (line.error) throw new Error(`sidecar: ${line.error}`);
      if (line.done) return;
      if (line.chunk_b64) {
        const raw = Buffer.from(line.chunk_b64, "base64");
        const pcm = new Float32Array(raw.length / 2);
        for (let i = 0; i < pcm.length; i++) pcm[i] = raw.readInt16LE(i * 2) / 32767;
        yield { audio: pcm, sampleRate };
      }
    }
  } finally {
    sock.destroy();
  }
}

/**
 * Keep a sidecar process alive. Call ensure() from the daemon loop (and before
 * each synthesis); it spawns when needed and restarts a dead one. Returns the
 * port of a live, warmed sidecar or null when this host cannot run one.
 */
export class SidecarSupervisor {
  private proc: ReturnType<typeof spawn> | null = null;
  private port: number | null = null;
  private restarting = false;

  constructor(private deps: {
    python?: string;
    script?: string;
    writePort?: (port: number) => void;
    removePort?: () => void;
    spawn?: typeof spawn;
  } = {}) {}

  async ensure(): Promise<number | null> {
    if (resolveBackend() === "cpu") return null;

    // Already up?
    if (this.proc && this.port !== null) {
      const alive = !this.proc.killed && await probeSidecar(this.port);
      if (alive) return this.port;
      this.proc = null;
      this.port = null;
    }

    // A sidecar from another daemon may already be listening.
    const filePort = readPortFile();
    if (filePort !== null && await probeSidecar(filePort)) {
      this.port = filePort;
      return filePort;
    }

    if (this.restarting) return null;
    this.restarting = true;
    try {
      const python = this.deps.python ?? VENV_PYTHON;
      const script = this.deps.script ?? sidecarScriptPath();
      if (!existsSync(python)) { log(`tts-sidecar: venv python missing at ${python} — using CPU path`); return null; }
      if (!existsSync(script)) { log(`tts-sidecar: script missing at ${script} — using CPU path`); return null; }

      const spawnFn = this.deps.spawn ?? spawn;
      // port 0 would make the server exit; pick a fixed high port per process.
      const port = 39_000 + (process.pid % 1000);
      const logFd = join(homedir(), ".aibroker", "tts-sidecar.log");
      const out = { fd: undefined as number | undefined };
      try {
        const { openSync } = await import("node:fs");
        out.fd = openSync(logFd, "a");
      } catch { /* log to stderr of the daemon instead */ }

      const proc = spawnFn(python, ["-I", script], {
        env: { ...process.env, AIBROKER_TTS_SIDECAR_PORT: String(port) },
        stdio: ["ignore", out.fd ?? "inherit", out.fd ?? "inherit"],
        detached: false,
      });
      proc.on("exit", (code) => {
        log(`tts-sidecar: process exited (code ${code}) — CPU fallback until it restarts`);
        if (this.proc === proc) { this.proc = null; this.port = null; }
      });
      this.proc = proc;

      // Wait for the port file / a live listener (load + warm-up takes ~10 s).
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        if (await probeSidecar(port)) {
          this.port = port;
          (this.deps.writePort ?? writePortFile)(port);
          log(`tts-sidecar: ready on 127.0.0.1:${port} (Metal)`);
          return port;
        }
        if (proc.killed) break;
        await new Promise<void>((r) => setTimeout(r, 500));
      }
      log("tts-sidecar: did not become ready within 30s — CPU fallback");
      this.proc = null;
      this.port = null;
      return null;
    } finally {
      this.restarting = false;
    }
  }

  /** Current live port, or null. Does not spawn. */
  async currentPort(): Promise<number | null> {
    if (resolveBackend() === "cpu") return null;
    if (this.port !== null && await probeSidecar(this.port)) return this.port;
    const filePort = readPortFile();
    if (filePort !== null && await probeSidecar(filePort)) return filePort;
    return null;
  }

  stop(): void {
    if (this.proc?.pid) { try { process.kill(this.proc.pid, "SIGTERM"); } catch { /* gone */ } }
    this.proc = null;
    this.port = null;
    (this.deps.removePort ?? removePortFile)();
  }
}

/** Daemon-wide singleton used by tts.ts and started from daemon/index.ts. */
export const sidecarSupervisor = new SidecarSupervisor();
