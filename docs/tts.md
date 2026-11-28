# TTS backends

`aibroker setup` picks a text-to-speech backend for your machine, installs it if needed, times it and remembers the result.

## Platform detection

| Platform | Backend | Runtime |
|----------|---------|---------|
| Apple Silicon | `mlx` | Metal |
| Linux with `nvidia-smi` | `torch` | CUDA |
| Linux otherwise | `onnx` | CPU |
| Anything else, or any detection failure | `cpu` | bundled kokoro-js, CPU |

## Download sizes (approximate)

| Backend | Download |
|---------|----------|
| `mlx` | ~450 MB |
| `torch` | ~2600 MB |
| `onnx` | ~350 MB |
| `cpu` | nothing to install |

## Files

- Virtualenv: `~/.cache/aibroker-tts/<backend>-venv`
- Config: `~/.aibroker/tts.json` with `backend`, `firstAudioMs` and `installedAt`.

## Setup flags

- `--no-tts`: skip the TTS step.
- `--yes`: install without asking (needed in a non-interactive shell).
- `--dry-run`: print each step as `would run (<label>): <command>`; nothing is executed and `tts.json` is not written.
- `--force`: reinstall even if the detected backend is already stored.

## Doctor

`aibroker doctor` checks the install. `aibroker doctor --remeasure` re-times the TTS backend and updates `firstAudioMs`.

## Override

`AIBROKER_TTS_BACKEND=cpu|mlx|torch|onnx` forces a backend regardless of detection or `tts.json`.

## Sidecar and fallback

Python backends run through the sidecar `tts-sidecar/server.py`. On any error (missing venv, crash, timeout) synthesis falls back to kokoro-js on CPU, so voice replies keep working.

## Measured

- kokoro-js CPU: ~4500 ms to first audio, warm.
- mlx on Metal: ~110 ms per sentence after a 7.9 s first call.
