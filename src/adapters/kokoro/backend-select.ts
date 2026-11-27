/**
 * adapters/kokoro/backend-select.ts — which TTS backend this host uses, what it
 * takes to install it, and where the choice is stored. Pure and injectable:
 * nothing here spawns a process or touches the network unless the caller hands
 * in an executor.
 *
 *   darwin+arm64 -> mlx (Metal), linux+nvidia -> torch (CUDA), other linux -> onnx,
 *   anything else -> cpu (bundled kokoro-js, no Python).
 */

import { join } from "node:path";
import { loadJson, saveJson } from "../../core/json-store.js";

export type TtsBackend = "mlx" | "torch" | "onnx" | "cpu";
export const TTS_BACKENDS: readonly TtsBackend[] = ["mlx", "torch", "onnx", "cpu"];

export interface DetectProbe {
  platform: NodeJS.Platform;
  arch: string;
  /** True when the command is on PATH (and, for nvidia-smi, answers). */
  hasCmd(cmd: string): boolean;
  env: NodeJS.ProcessEnv;
}

export function parseBackend(v: string | undefined): TtsBackend | null {
  const s = (v ?? "").toLowerCase().trim();
  return (TTS_BACKENDS as readonly string[]).includes(s) ? (s as TtsBackend) : null;
}

export function detectBackend(p: DetectProbe): TtsBackend {
  const forced = parseBackend(p.env.AIBROKER_TTS_BACKEND);
  if (forced) return forced;
  if (p.platform === "darwin" && p.arch === "arm64") return "mlx";
  if (p.platform === "linux") return p.hasCmd("nvidia-smi") ? "torch" : "onnx";
  return "cpu";
}

// ── install plan ──────────────────────────────────────────────────────────

export interface InstallStep { label: string; cmd: string; args: string[] }
export interface InstallPlan {
  backend: TtsBackend;
  venvDir: string;
  packages: string[];
  approxDownloadMB: number;
  steps: InstallStep[];
}

export const TTS_CACHE_ROOT = (home: string) => join(home, ".cache", "aibroker-tts");
export const venvDirFor = (home: string, b: TtsBackend) => join(TTS_CACHE_ROOT(home), `${b}-venv`);
export const venvPythonFor = (home: string, b: TtsBackend) => join(venvDirFor(home, b), "bin", "python");

const PACKAGES: Record<Exclude<TtsBackend, "cpu">, { pkgs: string[]; mb: number }> = {
  mlx: { pkgs: ["mlx-audio", "misaki[en]"], mb: 450 },
  torch: { pkgs: ["torch", "kokoro", "misaki[en]", "soundfile"], mb: 2600 },
  onnx: { pkgs: ["kokoro-onnx", "onnxruntime", "misaki[en]", "soundfile"], mb: 350 },
};

/** The steps to install a backend, as data. cpu needs nothing (bundled kokoro-js). */
export function installPlan(backend: TtsBackend, home: string): InstallPlan {
  const venvDir = venvDirFor(home, backend);
  if (backend === "cpu") return { backend, venvDir, packages: [], approxDownloadMB: 0, steps: [] };
  const { pkgs, mb } = PACKAGES[backend];
  const py = venvPythonFor(home, backend);
  const steps: InstallStep[] = [
    { label: "create venv", cmd: "uv", args: ["venv", venvDir] },
    { label: "install packages", cmd: "uv", args: ["pip", "install", "--python", py, ...pkgs] },
    { label: "download weights", cmd: py, args: ["-I", "-c", WEIGHTS_SNIPPET[backend]] },
  ];
  return { backend, venvDir, packages: pkgs, approxDownloadMB: mb, steps };
}

const WEIGHTS_SNIPPET: Record<Exclude<TtsBackend, "cpu">, string> = {
  mlx: "from huggingface_hub import snapshot_download as d; d('mlx-community/Kokoro-82M-bf16')",
  torch: "from huggingface_hub import snapshot_download as d; d('hexgrad/Kokoro-82M')",
  onnx: "from huggingface_hub import snapshot_download as d; d('onnx-community/Kokoro-82M-v1.0-ONNX')",
};

export interface InstallResult {
  backend: TtsBackend;
  firstAudioMs: number | null;
  installedAt: string;
  error?: string;
}

export interface InstallDeps {
  /** Run one step; resolves ok:false (or rejects) on failure. */
  exec(step: InstallStep): Promise<{ ok: boolean; out?: string }>;
  /** Warm the backend up and return the measured ms to first audio. */
  measure(backend: TtsBackend): Promise<number>;
  now?: () => Date;
}

/** Run the plan, then measure. Any failure yields backend "cpu" with the error; never throws. */
export async function runInstall(plan: InstallPlan, deps: InstallDeps): Promise<InstallResult> {
  const now = () => (deps.now ?? (() => new Date()))().toISOString();
  try {
    for (const step of plan.steps) {
      const r = await deps.exec(step);
      if (!r.ok) throw new Error(`${step.label} failed${r.out ? `: ${r.out.trim().slice(-300)}` : ""}`);
    }
    const firstAudioMs = await deps.measure(plan.backend);
    return { backend: plan.backend, firstAudioMs, installedAt: now() };
  } catch (err) {
    return { backend: "cpu", firstAudioMs: null, installedAt: now(), error: err instanceof Error ? err.message : String(err) };
  }
}

// ── stored choice ─────────────────────────────────────────────────────────

export interface TtsConfig { backend: TtsBackend; firstAudioMs: number | null; installedAt: string }
export const ttsConfigPath = (home: string) => join(home, ".aibroker", "tts.json");

export function loadTtsConfig(home: string): TtsConfig | null {
  const r = loadJson<Partial<TtsConfig>>(ttsConfigPath(home));
  if (r.status !== "ok") return null;
  const backend = parseBackend(r.data.backend);
  if (!backend) return null;
  return { backend, firstAudioMs: typeof r.data.firstAudioMs === "number" ? r.data.firstAudioMs : null, installedAt: String(r.data.installedAt ?? "") };
}

/** Atomic write (temp + rename via json-store). */
export function saveTtsConfig(home: string, cfg: TtsConfig): void {
  saveJson(ttsConfigPath(home), cfg);
}
