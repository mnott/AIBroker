import "./home-guard.js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { createPlaybackQueue, type PlaybackDeps, type SentenceAudio } from "../src/adapters/kokoro/playback.js";
import { splitIntoSentences } from "../src/adapters/kokoro/tts.js";

/** Fake player: spawn is recorded; the caller decides when it exits. */
interface FakePlayer {
  wavPath: string;
  exited: Promise<void>;
  resolve(): void;
  killed: boolean;
  suspended: boolean | null;
  kill(): void;
  suspend(on: boolean): void;
}

function makeHarness(opts: { synthDelayMs?: number } = {}) {
  const players: FakePlayer[] = [];

  function fakeSynth(text: string, _voice: string, _speed: number, signal: AbortSignal): AsyncGenerator<SentenceAudio> {
    // One generator per job run; the queue pulls one sentence at a time.
    const sentences = splitIntoSentences(text);
    let i = 0;
    return (async function* () {
      while (i < sentences.length) {
        if (signal.aborted) throw new Error("aborted");
        if (opts.synthDelayMs) await sleep(opts.synthDelayMs);
        if (signal.aborted) throw new Error("aborted");
        i++;
        yield { audio: new Float32Array(2400), sampleRate: 24000 };
      }
    })();
  }

  function fakePlay(): ((wavPath: string) => import("../src/adapters/kokoro/playback.js").PlayerHandle) | null {
    return (wavPath) => {
      let resolveExit: () => void = () => {};
      const player: FakePlayer = {
        wavPath,
        exited: new Promise<void>((r) => { resolveExit = r; }),
        resolve() {},
        killed: false,
        suspended: null,
        kill() { this.killed = true; this.resolve(); },
        suspend(on: boolean) { this.suspended = on; },
      };
      player.resolve = () => resolveExit();
      players.push(player);
      return player;
    };
  }

  const deps: Partial<PlaybackDeps> = { synth: fakeSynth, play: () => fakePlay() };
  return { players, deps };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Let the k-th player exit. */
function release(players: FakePlayer[], index: number): void {
  players[index].resolve();
}

describe("playback queue — streaming", () => {
  it("first audio starts after only the first sentence is synthesized", async () => {
    const h = makeHarness({ synthDelayMs: 40 });
    const q = createPlaybackQueue(h.deps);
    q.enqueue({ session: "s1", text: "One. Two. Three." });
    await sleep(60); // sentence 1 done (~40ms), sentence 2 not yet (~80ms)
    assert.equal(h.players.length, 1, "player spawned after first sentence only");
    release(h.players, 0);
    await sleep(60);
    assert.equal(h.players.length, 2, "second player after second sentence synthesized during first playback");
    release(h.players, 1);
    await sleep(60);
    assert.equal(h.players.length, 3);
    release(h.players, 2);
    await sleep(50);
  });

  it("segments play in synthesis order and never overlap", async () => {
    const h = makeHarness();
    const q = createPlaybackQueue(h.deps);
    q.enqueue({ session: "s2", text: "A. B. C." });
    await sleep(30);
    // exactly one player at a time until we release it
    assert.equal(h.players.length, 1);
    assert.ok(!h.players[0].killed);
    release(h.players, 0);
    await sleep(30);
    assert.equal(h.players.length, 2);
    release(h.players, 1);
    await sleep(30);
    assert.equal(h.players.length, 3);
    release(h.players, 2);
    await sleep(30);
  });

  it("jobs run strictly one after another", async () => {
    const h = makeHarness();
    const q = createPlaybackQueue(h.deps);
    q.enqueue({ session: "a", text: "X. Y." });
    q.enqueue({ session: "b", text: "Z." });
    await sleep(30);
    assert.equal(h.players.length, 1, "second job waits for the first");
    release(h.players, 0);
    await sleep(30);
    assert.equal(h.players.length, 2);
    release(h.players, 1); // finish job a
    await sleep(30);
    assert.equal(h.players.length, 3, "job b starts only after job a finishes");
    release(h.players, 2);
    await sleep(30);
  });

  it("stop kills the current player, aborts synthesis and clears the queue", async () => {
    const h = makeHarness({ synthDelayMs: 40 });
    const q = createPlaybackQueue(h.deps);
    q.enqueue({ session: "a", text: "X. Y." });
    q.enqueue({ session: "b", text: "Z." });
    await sleep(50); // job a playing sentence 1; job b queued
    const res = q.stop();
    assert.equal(res.stopped, true);
    assert.equal(res.cleared >= 1, true);
    assert.ok(h.players[0].killed, "current player killed");
    await sleep(120);
    assert.equal(h.players.length, 1, "no further players after stop");
  });

  it("recording hold suspends the current player and blocks the next segment", async () => {
    const h = makeHarness({ synthDelayMs: 30 });
    const q = createPlaybackQueue(h.deps);
    q.enqueue({ session: "a", text: "X. Y." });
    await sleep(50); // sentence 1 playing, sentence 2 synthesized ahead
    assert.equal(h.players.length, 1);
    q.setRecordingActive(true);
    assert.equal(h.players[0].suspended, true, "SIGSTOP the current player");
    release(h.players, 0); // playback would otherwise continue
    await sleep(80);
    assert.equal(h.players.length, 1, "next segment held while recording");
    q.setRecordingActive(false);
    // the player that already finished cannot be resumed; only a live one is SIGCONT'd
    assert.notEqual(h.players[0].suspended, false, "finished player untouched on resume");
    await sleep(80);
    assert.equal(h.players.length, 2, "playback resumes after recording ends");
    release(h.players, 1);
    await sleep(30);
  });

  it("recording hold blocks queued jobs until recording ends", async () => {
    const h = makeHarness();
    const q = createPlaybackQueue(h.deps);
    q.enqueue({ session: "a", text: "X." });
    await sleep(30);
    assert.equal(h.players.length, 1);
    release(h.players, 0);
    await sleep(30);
    // queue empty; start recording then enqueue a job
    q.setRecordingActive(true);
    q.enqueue({ session: "b", text: "Y." });
    await sleep(50);
    assert.equal(h.players.length, 1, "queued job held during recording");
    q.setRecordingActive(false);
    await sleep(50);
    assert.equal(h.players.length, 2, "queued job runs after recording ends");
    release(h.players, 1);
    await sleep(30);
  });

  it("last WAV is saved per session and replay works", async () => {
    const h = makeHarness();
    const q = createPlaybackQueue(h.deps);
    q.enqueue({ session: "alpha", text: "Hello there. Bye." });
    await sleep(30);
    release(h.players, 0);
    await sleep(30);
    assert.equal(h.players.length, 2);
    release(h.players, 1);
    await sleep(50);

    const dir = join(homedir(), ".aibroker", "last-speech");
    assert.ok(existsSync(dir), "last-speech directory created");
    let files = readdirSync(dir).filter((f) => f.startsWith("alpha-") && f.endsWith(".wav"));
    assert.equal(files.length, 1);

    // a second speech replaces the saved WAV (keep only last per session)
    q.enqueue({ session: "alpha", text: "Again." });
    await sleep(30);
    release(h.players, 2);
    await sleep(50);
    files = readdirSync(dir).filter((f) => f.startsWith("alpha-") && f.endsWith(".wav"));
    assert.equal(files.length, 1, "only the last WAV kept per session");

    // replay enqueues the saved file; it plays directly, no synthesis
    assert.equal(q.replay("alpha"), true);
    await sleep(30);
    assert.equal(h.players.length, 4, "replay spawned a player");
    release(h.players, 3);
    await sleep(30);

    assert.equal(q.replay("no-such-session"), false);

    // saved WAV is valid audio (RIFF header)
    const buf = readFileSync(join(dir, files[0]));
    assert.equal(buf.toString("ascii", 0, 4), "RIFF");
  });

  it("background errors are logged, never thrown unhandled", async () => {
    const q = createPlaybackQueue({
      synth: () => (async function* (): AsyncGenerator<SentenceAudio> { throw new Error("boom"); })(),
      play: () => () => ({ exited: Promise.resolve(), kill() {}, suspend() {} }),
    });
    assert.doesNotThrow(() => q.enqueue({ session: "x", text: "Hi." }));
    await sleep(50); // the error is swallowed inside the queue
  });
});
