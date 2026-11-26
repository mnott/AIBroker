/**
 * adapters/kokoro/playback.ts — streaming local speech with one queue per machine.
 *
 * speakLocally used to synthesize every sentence before playing anything, so a
 * long reply made the operator wait for the whole synthesis. Here each sentence
 * is synthesized while the previous one plays: one WAV per sentence (with a
 * trailing pause except after the last), the next player spawns the moment the
 * previous exits. Jobs run strictly one after another; stopPlayback() kills the
 * current player, aborts the running job's synthesis and drops queued jobs;
 * setRecordingActive() SIGSTOPs the current player (SIGCONT on false) and holds
 * playback until recording finishes, so dictation never hears our own voice.
 * After a job finishes its full concatenated audio is saved to
 * ~/.aibroker/last-speech/<safe session>.wav for replayLast().
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { log } from "../../core/log.js";
import { localPlayerCommand } from "../../core/bins.js";
import { PAUSE_SECONDS, concatWithPauses, float32ToWav } from "./tts.js";

/** Per-sentence audio as it is synthesized. */
export interface SentenceAudio {
  audio: Float32Array;
  sampleRate: number;
}

export interface PlayerHandle {
  exited: Promise<void>;
  kill(): void;
  suspend(on: boolean): void;
}

/** Aborted mid-synthesis or mid-playback; swallowed by the queue, never thrown to callers. */
class PlaybackAborted extends Error {}

interface Segment {
  audio: Float32Array;
  sampleRate: number;
}

/** Spawn a player for one WAV; resolves when it exits. */
function spawnPlayer(cmd: string[], wavPath: string): PlayerHandle {
  const child = spawn(cmd[0], [...cmd.slice(1), wavPath], { stdio: "ignore" });
  let exited = false;
  let stopped = false;
  const exitedPromise = new Promise<void>((resolve) => {
    child.on("close", () => { exited = true; resolve(); });
    child.on("error", (err) => { log(`Playback: ${cmd[0]} failed — ${err.message}`); resolve(); });
  });
  return {
    exited: exitedPromise,
    kill() { if (!exited && child.pid) try { process.kill(child.pid, "SIGKILL"); } catch { /* gone */ } },
    suspend(on: boolean) {
      if (exited || !child.pid) return;
      // SIGSTOP holds audio at the OS level; SIGCONT releases it. Idempotent so a
      // resume that arrives after playback already finished cannot act on a dead player.
      if (on && stopped) return;
      if (!on && !stopped) return;
      stopped = on;
      try { process.kill(child.pid, on ? "SIGSTOP" : "SIGCONT"); } catch { /* gone */ }
    },
  };
}

export interface PlaybackDeps {
  /** Synthesize one sentence at a time; throws when aborted. */
  synth: (text: string, voice: string, speed: number, signal: AbortSignal) => AsyncGenerator<SentenceAudio>;
  /** Spawn a player for a WAV file; null when this host has no local player. */
  play: () => ((wavPath: string) => PlayerHandle) | null;
  /** Silence between segments of one job (ms); default PAUSE_SECONDS. */
  pauseMs?: number;
  onPlayerSpawned?: (seq: number) => void;
}

/** Default synth: lazily imports tts.js so tests need no model and no cycle at import time. */
async function* defaultSynth(text: string, voice: string, speed: number, signal: AbortSignal): AsyncGenerator<SentenceAudio> {
  const { synthesizeSentences } = await import("./tts.js");
  yield* synthesizeSentences(text, voice, speed, signal);
}

/** Default play: resolve the local player at spawn time; null if none. */
function defaultPlay(): ((wavPath: string) => PlayerHandle) | null {
  const cmd = localPlayerCommand();
  if (!cmd) return null;
  return (wavPath) => spawnPlayer(cmd, wavPath);
}

/** Filesystem-safe session name for the saved last-speech WAV. */
function safeSession(session: string): string {
  return (session || "local").replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 64) || "local";
}

export interface PlaybackQueue {
  enqueue(job: { session: string; text: string; voice?: string; speed?: number }): { queued: number };
  stop(): { stopped: boolean; cleared: number };
  replay(session: string): boolean;
  setRecordingActive(active: boolean): void;
}

export function createPlaybackQueue(deps: Partial<PlaybackDeps> = {}): PlaybackQueue {
  const synth = deps.synth ?? defaultSynth;
  const play = deps.play ?? defaultPlay;
  const pauseMs = deps.pauseMs ?? PAUSE_SECONDS * 1000;

  let queue: Array<{ session: string; text: string; voice?: string; speed?: number }> = [];
  let running = false;
  let current: { kill(): void; abort(): void; suspend(on: boolean): void } | null = null;
  let recordingActive = false;

  /** Wake a pump that is parked waiting for recording to end. */
  let wakeRecording: (() => void) | null = null;

  /** Park until recording has ended (dictation must not hear our voice). */
  async function waitNotRecording(): Promise<void> {
    while (recordingActive) {
      await new Promise<void>((resolve) => { wakeRecording = resolve; });
    }
  }

  async function runJob(job: { session: string; text: string; voice?: string; speed?: number }): Promise<void> {
    const controller = new AbortController();
    const playFn = play();
    if (!playFn) {
      log(`Playback: no local audio player (need paplay, aplay or ffplay) — ${job.text.slice(0, 40)}… not played`);
      return;
    }

    let lastHandle: PlayerHandle | null = null;
    const segments: Segment[] = [];
    let seq = 0;

    current = {
      kill() { lastHandle?.kill(); },
      abort() { controller.abort(); },
      suspend(on: boolean) { lastHandle?.suspend(on); },
    };

    try {
      await waitNotRecording();
      // Replay a saved WAV: play the file directly, no synthesis.
      if (job.text.startsWith("__replay__:")) {
        const handle = playFn(job.text.slice("__replay__:".length));
        lastHandle = handle;
        deps.onPlayerSpawned?.(0);
        await handle.exited;
        return;
      }

      // One-ahead pipeline: pull the next sentence while the previous one plays.
      const gen = synth(job.text, job.voice ?? "", job.speed ?? 1.0, controller.signal);
      let r = await gen.next();
      while (!r.done) {
        if (controller.signal.aborted) throw new PlaybackAborted("aborted");
        segments.push({ audio: r.value.audio, sampleRate: r.value.sampleRate });

        // synthesize the next sentence before starting playback of this one, so
        // the next player can spawn the instant this one exits (gapless); the
        // pause between sentences is a timed gap, none after the last.
        const nextP = gen.next();
        nextP.catch(() => { /* surfaced when awaited; avoids unhandled rejection on abort */ });
        const wavPath = join(
          process.env.TMPDIR || "/tmp",
          `aibroker-playback-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.wav`,
        );
        writeFileSync(wavPath, float32ToWav(r.value.audio, r.value.sampleRate));

        const handle = playFn(wavPath);
        lastHandle = handle;
        deps.onPlayerSpawned?.(seq);
        seq++;
        await handle.exited;
        lastHandle = null;
        if (controller.signal.aborted) throw new PlaybackAborted("aborted");
        r = await nextP;
        // pause between sentences (not after the last), then hold while recording
        if (!r.done && pauseMs > 0) await new Promise<void>((res) => setTimeout(res, pauseMs));
        if (controller.signal.aborted) throw new PlaybackAborted("aborted");
        await waitNotRecording();
        if (controller.signal.aborted) throw new PlaybackAborted("aborted");
      }

      if (segments.length > 0) {
        saveLastSpeech(job.session, segments);
      }
    } catch (err) {
      if (err instanceof PlaybackAborted) return;
      log(`Playback: job failed — ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      current = null;
    }
  }

  function saveLastSpeech(session: string, segments: Segment[]): void {
    try {
      const dir = join(homedir(), ".aibroker", "last-speech");
      mkdirSync(dir, { recursive: true });
      const safe = safeSession(session);
      // keep only the last WAV per session
      for (const f of readdirSync(dir)) {
        if (f.startsWith(`${safe}-`) && f.endsWith(".wav")) {
          try { unlinkSync(join(dir, f)); } catch { /* ignore */ }
        }
      }
      const full = concatWithPauses(segments.map((s) => s.audio), segments[0].sampleRate);
      writeFileSync(join(dir, `${safe}-${Date.now()}.wav`), float32ToWav(full, segments[0].sampleRate));
    } catch (err) {
      log(`Playback: could not save last speech — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function pump(): Promise<void> {
    if (running) return;
    running = true;
    try {
      while (queue.length > 0) {
        const job = queue[0];
        await runJob(job);
        if (queue[0] === job) queue.shift();
      }
    } finally {
      running = false;
    }
  }

  function resume(): void {
    if (wakeRecording) { const w = wakeRecording; wakeRecording = null; w(); }
  }

  return {
    enqueue(job) {
      queue.push(job);
      void pump();
      return { queued: queue.length };
    },
    stop() {
      const cleared = queue.length;
      queue = [];
      const stopped = current !== null;
      if (current) { current.abort(); current.kill(); }
      return { stopped, cleared };
    },
    replay(session) {
      const dir = join(homedir(), ".aibroker", "last-speech");
      if (!existsSync(dir)) return false;
      const safe = safeSession(session);
      const files = readdirSync(dir)
        .filter((f) => f.startsWith(`${safe}-`) && f.endsWith(".wav"))
        .sort();
      if (files.length === 0) return false;
      queue.push({ session, text: `__replay__:${join(dir, files[files.length - 1])}` });
      void pump();
      return true;
    },
    setRecordingActive(active) {
      recordingActive = active;
      if (current) current.suspend(active); // SIGSTOP the current player; SIGCONT on false
      if (!active) resume();
    },
  };
}

/** The machine-wide singleton queue all speech goes through. */
export const playbackQueue: PlaybackQueue = createPlaybackQueue();

export function enqueueSpeech(job: { session: string; text: string; voice?: string; speed?: number }): { queued: number } {
  return playbackQueue.enqueue(job);
}

export function stopPlayback(): { stopped: boolean; cleared: number } {
  return playbackQueue.stop();
}

export function replayLast(session: string): boolean {
  return playbackQueue.replay(session);
}

export function setRecordingActive(active: boolean): void {
  playbackQueue.setRecordingActive(active);
}
