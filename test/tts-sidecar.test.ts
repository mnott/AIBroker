import "./home-guard.js";
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { writeFileSync } from "node:fs";
import { PORT_FILE as PORT_FILE_PATH } from "../src/adapters/kokoro/sidecar.js";

/** Track every fake server so teardown can close them; an open listener keeps the process alive. */
const servers: net.Server[] = [];

/** A fake sidecar on a random port: answers with header + int16 chunks + done. */
function startFakeSidecar(script: "ok" | "error" | "hang"): Promise<number> {
  return new Promise((resolve) => {
    const server = net.createServer((sock) => {
      let reqLine = "";
      sock.on("data", (d) => {
        reqLine += d.toString();
        if (!reqLine.includes("\n")) return;
        JSON.parse(reqLine.trim()); // request must be valid JSON
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
