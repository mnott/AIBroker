# Adding an AI Backend

This guide explains how to connect a new AI model or provider to AIBroker. You can either configure a built-in provider (Anthropic, OpenAI, Ollama) or implement a fully custom backend.

---

## The Backend Interface

Every backend implements this interface:

```typescript
export interface Backend {
  readonly name: string;
  readonly type: "session" | "api";
  deliver(message: string, sessionId?: string): Promise<string | undefined>;

  // Optional lifecycle and session management
  health?(): Promise<BackendHealth>;
  listSessions?(): BackendSession[];
  createSession?(name: string, cwd?: string): BackendSession;
  removeSession?(sessionId: string): Promise<void>;
  sessionStatus?(sessionId: string): BackendSessionStatus | undefined;
}
```

The only required method is `deliver()`. It receives a plain-text message and returns the model's response, or `undefined` if there was nothing to say.

`health()` is called periodically by the hub. Return `{ status: "ok" | "degraded" | "down", activeSessions: number }`.

---

## Using a Built-In Provider (APIBackend)

`APIBackend` handles Anthropic Claude, OpenAI, and Ollama. Configure it in `~/.aibroker/config.json` under the `backend` key.

### Anthropic Claude (Claude Agent SDK)

Uses the `@anthropic-ai/claude-agent-sdk` to spawn a Claude Code subprocess. Full tool use, conversation history, and context compaction are supported.

```json
{
  "backend": {
    "type": "api",
    "provider": "anthropic",
    "model": "claude-opus-4-5",
    "cwd": "/Users/you/projects/my-project",
    "systemPrompt": "You are a helpful assistant.",
    "maxTurns": 30,
    "maxBudgetUsd": 1.0,
    "permissionMode": "acceptEdits"
  }
}
```

**Environment variables:**

| Variable | Purpose |
|----------|---------|
| `AIBROKER_MODEL` | Override the model name without editing config |
| `AIBROKER_CWD` | Override the working directory |
| `ANTHROPIC_API_KEY` | Required by the Claude Agent SDK |

**Config fields:**

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `model` | string | required | Claude model ID (e.g. `claude-opus-4-5`) |
| `cwd` | string | `$HOME` | Working directory for the subprocess |
| `systemPrompt` | string | none | System prompt prepended to every conversation |
| `maxTurns` | number | 30 | Maximum agentic turns per message |
| `maxBudgetUsd` | number | 1.0 | Cost ceiling per `deliver()` call |
| `permissionMode` | string | `"acceptEdits"` | One of `"default"`, `"acceptEdits"`, `"bypassPermissions"`, `"plan"`, `"dontAsk"` |
| `allowedTools` | string[] | all tools | Whitelist of tool names the subprocess can use |

### OpenAI

Uses the OpenAI Chat Completions API over HTTP. No SDK dependency — just `fetch`.

```json
{
  "backend": {
    "type": "api",
    "provider": "openai",
    "model": "gpt-4o",
    "apiKey": "sk-..."
  }
}
```

Set `OPENAI_API_KEY` in the environment instead of hardcoding the key in the config file:

```json
{
  "backend": {
    "type": "api",
    "provider": "openai",
    "model": "gpt-4o"
  }
}
```

```bash
export OPENAI_API_KEY="sk-..."
aibroker start
```

To use an OpenAI-compatible endpoint (Azure OpenAI, Together AI, etc.), add `baseUrl`:

```json
{
  "backend": {
    "type": "api",
    "provider": "openai",
    "model": "mistral-large",
    "baseUrl": "https://api.together.xyz",
    "apiKey": "your-together-key"
  }
}
```

### Ollama (Local Models)

Uses the Ollama HTTP API. No API key required.

```json
{
  "backend": {
    "type": "api",
    "provider": "ollama",
    "model": "llama3.2"
  }
}
```

By default, AIBroker connects to `http://localhost:11434`. Override with `baseUrl`:

```json
{
  "backend": {
    "type": "api",
    "provider": "ollama",
    "model": "llama3.2",
    "baseUrl": "http://192.168.1.100:11434"
  }
}
```

**Quick start — Ollama on macOS:**

```bash
# Install Ollama
brew install ollama

# Pull a model
ollama pull llama3.2

# Verify it works
ollama run llama3.2 "Hello"

# Start AIBroker — it will connect to Ollama automatically
aibroker start
```

The `health()` check for Ollama pings `/api/tags` to confirm the server is reachable before reporting `"ok"`.

---

## Custom Backend

If none of the built-in providers fit, implement the `Backend` interface yourself and point AIBroker at it via `modulePath`.

### Config

```json
{
  "backend": {
    "type": "custom",
    "modulePath": "/absolute/path/to/my-backend.js",
    "options": {
      "model": "my-model",
      "apiKey": "..."
    }
  }
}
```

### Implementation

The module at `modulePath` must export a default function (or a named `createBackend` function) that receives the `options` object and returns a `Backend`:

```typescript
// my-backend.ts (compiled to my-backend.js)
import type { Backend, BackendHealth } from "aibroker";
import { log } from "aibroker";

interface MyOptions {
  model: string;
  apiKey: string;
}

export default function createBackend(options: MyOptions): Backend {
  return {
    name: `my-backend/${options.model}`,
    type: "api",

    async deliver(message: string): Promise<string | undefined> {
      log(`my-backend: delivering message (${message.length} chars)`);

      const response = await fetch("https://my-ai-service.example.com/v1/complete", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${options.apiKey}`,
        },
        body: JSON.stringify({ model: options.model, prompt: message }),
      });

      if (!response.ok) {
        throw new Error(`my-backend error: ${response.status}`);
      }

      const data = await response.json() as { text: string };
      return data.text;
    },

    async health(): Promise<BackendHealth> {
      try {
        const res = await fetch("https://my-ai-service.example.com/health", {
          signal: AbortSignal.timeout(3000),
        });
        return res.ok
          ? { status: "ok", activeSessions: 0 }
          : { status: "degraded", activeSessions: 0, detail: `HTTP ${res.status}` };
      } catch {
        return { status: "down", activeSessions: 0, detail: "unreachable" };
      }
    },
  };
}
```

Build with `tsc` (or `tsc --module NodeNext --moduleResolution NodeNext`) and point `modulePath` at the compiled `.js` file.

---

## Environment Variable Reference

| Variable | Provider | Description |
|----------|----------|-------------|
| `ANTHROPIC_API_KEY` | Anthropic | API key for the Claude Agent SDK |
| `OPENAI_API_KEY` | OpenAI | API key — used when `apiKey` is not in config |
| `AIBROKER_MODEL` | any | Override the `model` field at runtime |
| `AIBROKER_CWD` | Anthropic | Override the subprocess working directory |

---

## Complete Config Example

```json
{
  "adapters": [
    {
      "name": "whazaa",
      "socketPath": "/tmp/whazaa-watcher.sock"
    },
    {
      "name": "telex",
      "socketPath": "/tmp/telex-watcher.sock"
    }
  ],
  "backend": {
    "type": "api",
    "provider": "anthropic",
    "model": "claude-opus-4-5",
    "cwd": "/Users/you/projects",
    "maxTurns": 40,
    "maxBudgetUsd": 2.0
  }
}
```

---

## Choosing a Provider

| Provider | Capability | Tool Use | Conversation History | Requires Network |
|----------|-----------|----------|---------------------|-----------------|
| **Anthropic** | Full Claude Code agentic execution | Yes (all tools) | Yes (session resume) | Yes |
| **OpenAI** | Chat completions only | No | No (stateless) | Yes |
| **Ollama** | Chat completions only | No | No (stateless) | No (local) |
| **Custom** | Whatever you implement | Optional | Optional | Optional |

For agentic use (file edits, tool calls, multi-turn reasoning), use **Anthropic**. For quick Q&A with a local model, use **Ollama**. For OpenAI-compatible endpoints, use **OpenAI**.
