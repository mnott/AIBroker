import "./home-guard.js";
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { writeFileSync } from "node:fs";
import { PORT_FILE as PORT_FILE_PATH } from "../src/adapters/kokoro/sidecar.js";

/** Track every fake server so teardown can close them; an open listener keeps the process alive. */
const servers: net.Server[] = [];

/** A fake sidecar on a random port: answers with header + int16 chunks + done. */
function startFakeSidecar(script: "ok" | "error" | "hang" | "burst"): Promise<number> {
  return new Promise((resolve) => {
    const server = net.createServer((sock) => {
      let reqLine = "";
      sock.on("data", (d) => {
        reqLine += d.toString();
        if (!reqLine.includes("\n")) return;
        JSON.parse(reqLine.trim()); // request must be valid JSON
        if (script === "burst") {
          // Everything in one write: exercises the gap where the consumer is
          // suspended playing a previous sentence.
          const frames = [
            JSON.stringify({ ok: true, sample_rate: 24000 }),
            ...[1, 2, 3].map((n) => {
              const pcm = new Int16Array(96).fill(n);
              return JSON.stringify({ chunk_b64: Buffer.from(pcm.buffer).toString("base64") });
            }),
            JSON.stringify({ done: true }),
          ];
          sock.write(frames.join("\n") + "\n");
          sock.end();
          return;
        }
        if (script === "error") {
          sock.write(JSON.stringify({ error: "voice not found" }) + "\n");
          sock.end();
          return;
        }
        if (script === "hang") return; // never answer — exercises timeout
        const pcm = new Int16Array(480).fill(1000);
        sock.write(JSON.stringify({ ok: true, sample_rate: 24000 }) + "\n");
        sock.write(JSON.stringify({ chunk_b64: Buffer.from(pcm.buffer).toString("base64") }) + "\n");
        const pcm2 = new Int16Array(240).fill(-500);
        sock.write(JSON.stringify({ chunk_b64: Buffer.from(pcm2.buffer).toString("base64") }) + "\n");
        sock.write(JSON.stringify({ done: true }) + "\n");
        sock.end();
      });
    });
    servers.push(server);
    server.listen(0, "127.0.0.1", () => {
      resolve((server.address() as net.AddressInfo).port);
    });
  });
}

after(() => {
  for (const s of servers) s.close();
});

describe("resolveBackend", () => {
  it("cpu is forced by env", async () => {
    const { resolveBackend } = await import("../src/adapters/kokoro/sidecar.js");
    assert.equal(resolveBackend({ AIBROKER_TTS_BACKEND: "cpu" }), "cpu");
  });
  it("mlx is forced by env even without a venv", async () => {
    const { resolveBackend } = await import("../src/adapters/kokoro/sidecar.js");
    assert.equal(resolveBackend({ AIBROKER_TTS_BACKEND: "mlx" }), "mlx");
  });
  it("default follows the venv, not an unset value", async () => {
    const { resolveBackend } = await import("../src/adapters/kokoro/sidecar.js");
    const def = resolveBackend({});
    assert.ok(def === "cpu" || def === "mlx");
  });
});

describe("port file", () => {
  it("round-trips a valid port and rejects junk", async () => {
    const { readPortFile, writePortFile } = await import("../src/adapters/kokoro/sidecar.js");
    writePortFile(39123);
    assert.equal(readPortFile(), 39123);
    // home-guard redirects HOME to a per-run sandbox, so this is safe to write
    writeFileSync(PORT_FILE_PATH, "junk\n");
    assert.equal(readPortFile(), null);
    writePortFile(39124);
    assert.equal(readPortFile(), 39124);
  });
});

describe("probeSidecar", () => {
  it("false when nothing listens", async () => {
    const { probeSidecar } = await import("../src/adapters/kokoro/sidecar.js");
    assert.equal(await probeSidecar(1, 300), false);
  });
  it("true when a listener answers", async () => {
    const { probeSidecar } = await import("../src/adapters/kokoro/sidecar.js");
    const port = await startFakeSidecar("ok");
    assert.equal(await probeSidecar(port, 500), true);
  });
});

describe("streamSidecar", () => {
  it("yields decoded float32 chunks per frame", async () => {
    const { streamSidecar } = await import("../src/adapters/kokoro/sidecar.js");
    const port = await startFakeSidecar("ok");
    const chunks: { audio: Float32Array; sampleRate: number }[] = [];
    for await (const c of streamSidecar(port, { text: "hello world.", voice: "bm_fable", speed: 1 })) {
      chunks.push(c);
    }
    assert.equal(chunks.length, 2);
    assert.equal(chunks[0].audio.length, 480);
    assert.ok(Math.abs(chunks[0].audio[0] - 1000 / 32767) < 1e-4);
    assert.ok(chunks[1].audio[0] < 0);
    assert.equal(chunks[0].sampleRate, 24000);
  });
  it("receives every chunk when the sidecar bursts everything at once", async () => {
    // Live bug 2026-11-26: aibroker_speak played one sentence then stalled.
    // The old reader attached 'data' listeners only while awaiting, so lines
    // and 'end' arriving during playback (no listener attached) were dropped
    // by the flowing socket and readLine hung until an abort fired.
    const { streamSidecar } = await import("../src/adapters/kokoro/sidecar.js");
    const port = await startFakeSidecar("burst");
    const chunks: Float32Array[] = [];
    for await (const c of streamSidecar(port, { text: "one. two. three.", voice: "bm_fable" })) {
      chunks.push(c.audio);
      await new Promise((r) => setTimeout(r, 200)); // simulate playback of this sentence
    }
    assert.equal(chunks.length, 3);
    assert.ok(Math.abs(chunks[0][0] - 1 / 32767) < 1e-4);
    assert.ok(Math.abs(chunks[2][0] - 3 / 32767) < 1e-4);
  });

  it("throws on an error frame", async () => {
    const { streamSidecar } = await import("../src/adapters/kokoro/sidecar.js");
    const port = await startFakeSidecar("error");
    await assert.rejects(
      (async () => { for await (const _ of streamSidecar(port, { text: "x", voice: "af_heart" })) void _; })(),
      /voice not found/,
    );
  });
  it("throws on connect timeout when the sidecar hangs", async () => {
    const { streamSidecar } = await import("../src/adapters/kokoro/sidecar.js");
    const port = await startFakeSidecar("hang");
    // The hang server never closes; abort the stream instead of waiting for a
    // socket close that only arrives when the test process exits.
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 300);
    await assert.rejects(
      (async () => { for await (const _ of streamSidecar(port, { text: "x", voice: "af_heart" }, ac.signal)) void _; })(),
      /aborted/,
    );
  });
});

describe("synthesizeSentences routes to CPU when the sidecar is absent", () => {
  it("uses a fake CPU tts instance (no model load)", async () => {
    const { synthesizeSentences } = await import("../src/adapters/kokoro/tts.js");
    const fake = {
      generate: async (s: string, opts: { voice: string; speed: number }) => ({
        audio: new Float32Array(100).fill(opts.voice === "bm_fable" ? 0.5 : -0.5),
        sampling_rate: 24000,
      }),
    };
    const chunks: Float32Array[] = [];
    for await (const c of synthesizeSentences("One sentence. Two sentence.", "bm_fable", 1, undefined, fake)) {
      chunks.push(c.audio);
    }
    assert.equal(chunks.length, 2);
    assert.ok(chunks[0].every((v) => v === 0.5));
  });

  it("falls back to CPU when the port file points at a dead sidecar", async () => {
    const { writePortFile } = await import("../src/adapters/kokoro/sidecar.js");
    const { synthesizeSentences } = await import("../src/adapters/kokoro/tts.js");
    writePortFile(1); // port 1: nothing listens → probe false → CPU path
    process.env.AIBROKER_TTS_BACKEND = "cpu"; // never spawn a real sidecar in tests
    const fake = {
      generate: async () => ({ audio: new Float32Array(50).fill(0.1), sampling_rate: 24000 }),
    };
    const chunks: Float32Array[] = [];
    for await (const c of synthesizeSentences("Hello there. Fine.", "bm_fable", 1, undefined, fake)) {
      chunks.push(c.audio);
    }
    assert.equal(chunks.length, 2);
    delete process.env.AIBROKER_TTS_BACKEND;
  });

  it("falls back to CPU when the sidecar returns an error frame", async () => {
    const { writePortFile } = await import("../src/adapters/kokoro/sidecar.js");
    const { synthesizeSentences } = await import("../src/adapters/kokoro/tts.js");
    const port = await startFakeSidecar("error");
    writePortFile(port); // live listener, but it answers with an error → must fall back
    process.env.AIBROKER_TTS_BACKEND = "mlx";
    const fake = {
      generate: async () => ({ audio: new Float32Array(40).fill(0.2), sampling_rate: 24000 }),
    };
    const chunks: Float32Array[] = [];
    for await (const c of synthesizeSentences("Say something. Please.", "bm_fable", 1, undefined, fake)) {
      chunks.push(c.audio);
    }
    assert.equal(chunks.length, 2); // CPU served after the sidecar error
    delete process.env.AIBROKER_TTS_BACKEND;
  });

  it("streams from the sidecar when it answers", async () => {
    const { writePortFile } = await import("../src/adapters/kokoro/sidecar.js");
    const { synthesizeSentences } = await import("../src/adapters/kokoro/tts.js");
    const port = await startFakeSidecar("ok");
    writePortFile(port);
    process.env.AIBROKER_TTS_BACKEND = "mlx";
    const chunks: Float32Array[] = [];
    for await (const c of synthesizeSentences("One sentence. Two sentence.", "bm_fable", 1, undefined, undefined)) {
      chunks.push(c.audio);
    }
    assert.equal(chunks.length, 2); // sidecar served two frames
    delete process.env.AIBROKER_TTS_BACKEND;
  });
});

// ── backend selection (PAI#34) ────────────────────────────────────────────
import { mkdtempSync, mkdirSync as mkdirP } from "node:fs";
import { tmpdir } from "node:os";
import { join as pjoin } from "node:path";
import {
  detectBackend, installPlan, runInstall, loadTtsConfig, saveTtsConfig, venvPythonFor, type DetectProbe,
} from "../src/adapters/kokoro/backend-select.js";

const probe = (o: Partial<DetectProbe> & { gpu?: boolean }): DetectProbe => ({
  platform: "linux", arch: "x64", env: {}, hasCmd: (c) => c === "nvidia-smi" && !!o.gpu, ...o,
});

describe("detectBackend", () => {
  it("matrix", () => {
    assert.equal(detectBackend(probe({ platform: "darwin", arch: "arm64" })), "mlx");
    assert.equal(detectBackend(probe({ platform: "darwin", arch: "x64" })), "cpu");
    assert.equal(detectBackend(probe({ gpu: true })), "torch");
    assert.equal(detectBackend(probe({})), "onnx");
    assert.equal(detectBackend(probe({ platform: "win32" })), "cpu");
  });
  it("env override wins, junk ignored", () => {
    assert.equal(detectBackend(probe({ platform: "win32", env: { AIBROKER_TTS_BACKEND: "Torch" } })), "torch");
    assert.equal(detectBackend(probe({ env: { AIBROKER_TTS_BACKEND: "bogus" } })), "onnx");
  });
});

describe("installPlan", () => {
  it("is data: venv under the cache, misaki[en], steps in order, cpu empty", () => {
    for (const b of ["mlx", "torch", "onnx"] as const) {
      const p = installPlan(b, "/h");
      assert.equal(p.venvDir, `/h/.cache/aibroker-tts/${b}-venv`);
      assert.ok(p.packages.includes("misaki[en]"));
      assert.ok(p.approxDownloadMB > 0);
      assert.deepEqual(p.steps.map((s) => s.label), ["create venv", "install packages", "download weights"]);
      assert.equal(p.steps[0].cmd, "uv");
    }
    assert.deepEqual(installPlan("cpu", "/h").steps, []);
  });
});

describe("runInstall", () => {
  const plan = installPlan("onnx", "/h");
  it("runs all steps, measures", async () => {
    const ran: string[] = [];
    const r = await runInstall(plan, { exec: async (s) => { ran.push(s.label); return { ok: true }; }, measure: async () => 120, now: () => new Date(0) });
    assert.deepEqual(ran.length, 3);
    assert.deepEqual(r, { backend: "onnx", firstAudioMs: 120, installedAt: "1970-01-01T00:00:00.000Z" });
  });
  it("failed step falls back to cpu with the error, stops, never throws", async () => {
    let n = 0;
    const r = await runInstall(plan, { exec: async () => (++n === 2 ? { ok: false, out: "boom" } : { ok: true }), measure: async () => 1 });
    assert.equal(r.backend, "cpu");
    assert.match(r.error ?? "", /install packages failed.*boom/);
    assert.equal(n, 2);
  });
  it("measure throwing or exec rejecting falls back to cpu", async () => {
    assert.equal((await runInstall(plan, { exec: async () => ({ ok: true }), measure: async () => { throw new Error("x"); } })).backend, "cpu");
    assert.equal((await runInstall(plan, { exec: async () => { throw new Error("y"); }, measure: async () => 1 })).error, "y");
  });
});

describe("resolveBackend with stored config", () => {
  const home = () => mkdtempSync(pjoin(tmpdir(), "tts-"));
  it("config round trip", () => {
    const h = home();
    assert.equal(loadTtsConfig(h), null);
    saveTtsConfig(h, { backend: "torch", firstAudioMs: 90, installedAt: "t" });
    assert.deepEqual(loadTtsConfig(h), { backend: "torch", firstAudioMs: 90, installedAt: "t" });
  });
  it("stored backend used when its venv exists, cpu when missing", async () => {
    const { resolveBackend } = await import("../src/adapters/kokoro/sidecar.js");
    const h = home();
    saveTtsConfig(h, { backend: "onnx", firstAudioMs: null, installedAt: "t" });
    assert.equal(resolveBackend({}, h), "cpu");
    mkdirP(pjoin(venvPythonFor(h, "onnx"), ".."), { recursive: true });
    writeFileSync(venvPythonFor(h, "onnx"), "");
    assert.equal(resolveBackend({}, h), "onnx");
    assert.equal(resolveBackend({ AIBROKER_TTS_BACKEND: "cpu" }, h), "cpu");
  });
  it("no config: legacy mlx venv or cpu", async () => {
    const { resolveBackend } = await import("../src/adapters/kokoro/sidecar.js");
    const h = home();
    assert.equal(resolveBackend({}, h), "cpu");
    mkdirP(pjoin(venvPythonFor(h, "mlx"), ".."), { recursive: true });
    writeFileSync(venvPythonFor(h, "mlx"), "");
    assert.equal(resolveBackend({}, h), "mlx");
  });
});

describe("setup tts step and doctor remeasure", () => {
  it("--yes installs via injected deps and stores; --no-tts skips; failure stores cpu", async () => {
    const { ttsStep } = await import("../src/daemon/setup.js");
    const { remeasureTts } = await import("../src/daemon/doctor.js");
    const h = mkdtempSync(pjoin(tmpdir(), "tts-"));
    const s = { home: h, platform: "linux", env: {}, which: () => null } as any;
    const out: string[] = [];
    const deps = (ok: boolean) => ({ exec: async () => ({ ok }), measure: async () => 77, confirm: async () => false, interactive: false });
    await ttsStep(s, ["--no-tts"], deps(true), (l) => out.push(l));
    assert.equal(loadTtsConfig(h), null);
    await ttsStep(s, [], deps(true), (l) => out.push(l));
    assert.equal(loadTtsConfig(h), null, "non-interactive without --yes skips");
    await ttsStep(s, ["--yes", "--force"], deps(false), (l) => out.push(l));
    assert.equal(loadTtsConfig(h)?.backend, "cpu");
    await ttsStep(s, ["--yes", "--force"], deps(true), (l) => out.push(l));
    assert.deepEqual([loadTtsConfig(h)?.backend, loadTtsConfig(h)?.firstAudioMs], ["onnx", 77]);
    await remeasureTts(s, async () => 55, (l) => out.push(l));
    assert.equal(loadTtsConfig(h)?.firstAudioMs, 55);
    assert.ok(out.some((l) => /55 ms/.test(l)));
  });
  it("--dry-run prints one line per plan step, runs nothing, writes nothing", async () => {
    const { ttsStep } = await import("../src/daemon/setup.js");
    for (const [which, backend, pkg] of [
      [() => null, "onnx", "kokoro-onnx"],
      [(c: string) => (c === "nvidia-smi" ? "/usr/bin/nvidia-smi" : null), "torch", "torch"],
    ] as const) {
      const h = mkdtempSync(pjoin(tmpdir(), "tts-"));
      const s = { home: h, platform: "linux", env: {}, which } as any;
      let calls = 0;
      const deps = { exec: async () => { calls++; return { ok: true }; }, measure: async () => 1, confirm: async () => true, interactive: true };
      const out: string[] = [];
      await ttsStep(s, ["--dry-run", "--yes"], deps, (l) => out.push(l));
      const lines = out.filter((l) => l.startsWith("  would run ("));
      assert.equal(lines.length, 3, backend);
      assert.match(lines[0], /^  would run \(create venv\): uv venv .*-venv$/);
      assert.match(lines[1], new RegExp(`^  would run \\(install packages\\): uv pip install --python .* .*${pkg}`));
      assert.match(lines[2], /^  would run \(download weights\): .* -I -c /);
      assert.ok(out.some((l) => l.includes(`backend ${backend}`)));
      assert.equal(calls, 0);
      assert.equal(loadTtsConfig(h), null);
    }
  });
});
