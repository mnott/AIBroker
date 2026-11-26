#!/usr/bin/env python3
"""TTS sidecar — Kokoro-82M on Apple Metal via mlx-audio.

The daemon spawns this with the cached venv interpreter (`-I`) and talks to it
over 127.0.0.1 TCP: one JSON request per line, streamed PCM back. The model is
loaded once and warmed up at start, so requests answer in ~100 ms instead of
the ~4.5 s cold cost of the kokoro-js CPU path.

Protocol (all frames newline-delimited JSON):
  request : {"text": str, "voice": "bm_fable", "speed": 1.0}   (one line)
  response: {"ok": true, "sample_rate": 24000}                  (header line)
            {"chunk_b64": "<int16 mono PCM>"}                   (0..n lines)
            {"done": true}                                      (final line)
  error   : {"error": "..."}                                   (instead of header)

Each sentence is generated separately (same segmentation the CPU path uses, so
voice quality and pauses match), with a silence gap between sentences. Chunks
are flushed as soon as generation yields them, so the client starts playing on
the first chunk.
"""

import base64
import json
import math
import os
import sys
import time

from mlx_audio.tts.utils import load_model

MODEL_ID = "mlx-community/Kokoro-82M-bf16"
WARM_TEXT = "The report is ready, and the numbers on the hard set changed quite a lot overnight."

ABBREVIATIONS = {
    "mr", "mrs", "ms", "dr", "prof", "sr", "jr", "st", "vs", "etc", "e.g", "i.e",
    "inc", "ltd", "no", "approx", "fig", "u.s", "a.m", "p.m",
}


def ends_with_abbreviation(s: str) -> bool:
    import re
    m = re.search(r"([A-Za-z][A-Za-z.]*)\.$", s)
    if not m:
        return False
    w = m.group(1).lower()
    return w in ABBREVIATIONS or re.fullmatch(r"[a-z]", w)


def split_into_sentences(text: str, max_chars: int = 300):
    """Mirror of tts.ts splitIntoSentences: sentence chunks ≤ max_chars."""
    flat = " ".join(text.split())
    if not flat:
        return []
    sentences = []
    cur = ""
    for tok in flat.split():
        cur = f"{cur} {tok}" if cur else tok
        import re
        if re.search(r'[.!?]["\')\]]*$', tok) and not (
            tok.endswith(".") and ends_with_abbreviation(tok)
        ):
            sentences.append(cur)
            cur = ""
    if cur:
        sentences.append(cur)
    return [s for s in sentences if s]


def lang_code(voice: str) -> str:
    """Voice prefix maps to mlx-audio's lang_code: a* → American, b* → British."""
    v = voice.lower().strip()
    if v.startswith("a"):
        return "a"
    if v.startswith("b"):
        return "b"
    return "a"


def main() -> None:
    port = int(os.environ.get("AIBROKER_TTS_SIDECAR_PORT", "0"))
    if port <= 0:
        print("tts-sidecar: AIBROKER_TTS_SIDECAR_PORT not set", file=sys.stderr)
        sys.exit(2)

    t0 = time.time()
    model = load_model(MODEL_ID)
    sample_rate = int(getattr(model, "sample_rate", 24000))
    print(f"tts-sidecar: loaded {MODEL_ID} in {1000*(time.time()-t0):.0f} ms", file=sys.stderr, flush=True)

    # Warm-up: the first Metal generate pays kernel compilation (~8 s).
    t0 = time.time()
    n = 0
    for r in model.generate(text=WARM_TEXT, voice="bm_fable", speed=1.0, lang_code="b"):
        if getattr(r, "audio", None) is not None:
            n += int(r.audio.shape[-1])
    print(f"tts-sidecar: warm-up {n} samples in {1000*(time.time()-t0):.0f} ms", file=sys.stderr, flush=True)

    import socketserver

    class Handler(socketserver.StreamRequestHandler):
        def send(self, obj: dict) -> None:
            self.wfile.write((json.dumps(obj) + "\n").encode("ascii"))
            self.wfile.flush()

        def handle(self) -> None:
            line = self.rfile.readline()
            if not line:
                return
            try:
                req = json.loads(line)
                text = str(req.get("text", ""))
                voice = str(req.get("voice", "bm_fable"))
                speed = float(req.get("speed", 1.0))
                if not math.isfinite(speed) or speed <= 0:
                    speed = 1.0
            except Exception as e:
                self.send({"error": f"bad request: {e}"})
                return

            sentences = split_into_sentences(text)
            if not sentences:
                self.send({"ok": True, "sample_rate": sample_rate})
                self.send({"done": True})
                return

            lang = lang_code(voice)
            try:
                self.send({"ok": True, "sample_rate": sample_rate})
                gap = int(sample_rate * 0.25)
                for i, s in enumerate(sentences):
                    if i > 0:
                        self.send({"chunk_b64": base64.b64encode(bytes(gap * 2)).decode("ascii")})
                    for r in model.generate(text=s, voice=voice, speed=speed, lang_code=lang):
                        a = getattr(r, "audio", None)
                        if a is None or a.shape[-1] == 0:
                            continue
                        import numpy as np
                        pcm = np.array(a, dtype=np.float32).reshape(-1)
                        pcm = pcm.clip(-1.0, 1.0)
                        int16 = (pcm * 32767.0).astype("<i2").tobytes()
                        self.send({"chunk_b64": base64.b64encode(int16).decode("ascii")})
                self.send({"done": True})
            except Exception as e:
                try:
                    self.send({"error": str(e)})
                except Exception:
                    pass

    class Server(socketserver.ThreadingTCPServer):
        allow_reuse_address = True
        daemon_threads = True

    with Server(("127.0.0.1", port), Handler) as srv:
        print("tts-sidecar: ready", file=sys.stderr, flush=True)
        srv.serve_forever()


if __name__ == "__main__":
    main()
