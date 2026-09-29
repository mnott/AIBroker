# Media Pipelines

All media processing is centralized in the hub — adapters never touch TTS, transcription, or image generation directly.

| Pipeline | Technology | What happens |
|----------|-----------|-------------|
| **Text-to-Speech** | Kokoro (local) | Text → WAV → OGG Opus → delivered as voice note |
| **Speech-to-Text** | Whisper (local) | Voice note → transcription → delivered as text to Claude |
| **Image Generation** | Pluggable (see below) | Prompt → image → delivered to chat |
| **Image Analysis** | Claude Vision | Image → description → text response (no extra API cost on Max plan) |
| **Video Analysis** | Gemini 2.0 Flash | Video → analysis → text response (free tier: 15 RPM) |
| **Screenshots** | iTerm2 AppleScript | Capture terminal → PNG → delivered to chat |

### Image Generation — Works Out of the Box

Image generation uses [Pollinations.ai](https://pollinations.ai) by default — free, unlimited, no API key, no signup. Just ask Claude to generate an image and it works.

Want faster results? Upgrade to a paid provider by setting a single environment variable in `~/.aibroker/env`:

| Provider | Setup | Speed | Cost |
|----------|-------|-------|------|
| **Pollinations** _(default)_ | Nothing — works immediately | ~20s | Free |
| **Replicate** | `REPLICATE_API_TOKEN=r8_...` | 2-4s | ~$0.003/image |
| **Cloudflare Workers AI** | `CLOUDFLARE_AI_TOKEN=...` + `CLOUDFLARE_ACCOUNT_ID=...` | 3-5s | Free (~100/day) |
| **Hugging Face** | `HF_API_TOKEN=hf_...` | 5-15s | Free (rate-limited) |

AIBroker auto-detects which token is set and uses that provider. No config file needed.

**Pin a specific provider** with `~/.aibroker/image-gen.json`:

```json
{
  "provider": "replicate"
}
```

**Bring your own provider** — point to any Node.js module that implements the `ImageProvider` interface:

```json
{
  "provider": "custom",
  "modulePath": "/path/to/my-provider.js",
  "options": { "apiKey": "...", "endpoint": "https://my-api.com" }
}
```

Your module exports one function:

```typescript
import type { ImageProvider, ImageProviderConfig } from "aibroker";

export function createProvider(config: ImageProviderConfig): ImageProvider {
  return {
    name: "my-provider",
    async generate(opts) {
      const res = await fetch(config.options.endpoint, { /* ... */ });
      return {
        images: [Buffer.from(await res.arrayBuffer())],
        model: "my-model",
        durationMs: 0,
      };
    },
  };
}
```

All built-in providers use FLUX.1 Schnell by default. Override with `"model": "your-model-id"` in the config.

### Iterative Refinement

Image generation is conversational. Generate an image, then refine it with follow-up messages:

```
You:    "Send me an image of a fish sitting on a chair"
Claude: [image]
You:    "Put a tie on it"
Claude: [refined image — fish on chair, now wearing a tie]
You:    "Make it watercolor style"
Claude: [refined image — watercolor fish with tie on chair]
```

AIBroker detects refinement intent from modification verbs ("put", "add", "make"), image references ("it", "the image"), style keywords ("watercolor", "cartoon"), and prepositional modifiers ("with a hat", "without the chair"). Messages that don't reference the image pass through to Claude normally — no manual "stop" needed.

Image context is scoped per source, recipient, and session, so multiple users or devices never interfere. Context expires after 30 minutes of inactivity. Say "new image" or "start over" to reset explicitly.
