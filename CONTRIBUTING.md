# Contributing

Contributions welcome. Please read this before opening a PR.

---

## Development Setup

```bash
# Clone
git clone https://github.com/mnott/AIBroker.git
cd AIBroker

# Install dependencies
npm install

# Build
npm run build          # tsc -> dist/
npm run dev            # tsc --watch (rebuild on changes)

# Link locally so Whazaa and Telex can import it
npm link

# In Whazaa / Telex / your own adapter:
npm link aibroker
```

---

## Project Structure

```
src/
├── index.ts           Public API — re-exports everything consumers need
├── types/             TypeScript interfaces (Backend, Adapter, IPC, etc.)
├── core/              Logging, state, persistence, TTS, media
├── ipc/               Unix Domain Socket client + server
├── backend/           AI backend implementations (APIBackend)
├── daemon/            Hub daemon, adapter registry, CLI, create-adapter scaffold
└── adapters/          Built-in adapter integrations (PAILot WebSocket gateway, iTerm2, Kokoro TTS)

docs/
├── CREATE_ADAPTER.md  How to build a new messaging adapter
└── BACKEND_GUIDE.md   How to add a new AI backend

templates/
└── adapter/           Scaffolding template for `aibroker create-adapter`
```

---

## Running the Daemon Locally

```bash
npm run build
node dist/daemon/cli.js start
```

The daemon listens on a Unix Domain Socket (`/tmp/aibroker.sock` by default). Check it is running:

```bash
node dist/daemon/cli.js status
```

---

## Testing Adapters

Start the adapter watcher in one terminal, then talk to it from another.

```bash
# Terminal 1 — start the watcher (example: Whazaa)
cd ~/dev/ai/Whazaa
npm run build && node dist/watcher/cli.js watch

# Terminal 2 — health check via IPC
node --input-type=module <<'EOF'
import { WatcherClient } from 'aibroker';
const c = new WatcherClient('/tmp/whazaa-watcher.sock');
console.log(JSON.stringify(await c.call_raw('health', {}), null, 2));
EOF
```

For the backend, send a test message:

```bash
node --input-type=module <<'EOF'
import { APIBackend } from 'aibroker';
const backend = new APIBackend({ type: 'api', provider: 'ollama', model: 'llama3.2' });
const reply = await backend.deliver('Say hello in one sentence.');
console.log(reply);
EOF
```

---

## PR Guidelines

- **Conventional commits** — `feat:`, `fix:`, `refactor:`, `docs:`, `chore:`
- **TypeScript strict** — `strict: true` is on. No `any` without a comment explaining why.
- **No new runtime dependencies without discussion** — open an issue first. The dependency footprint matters because adapters inherit it via `npm link`.
- **Hard boundary** — aibroker must never import `@whiskeysockets/baileys`, `telegram`/`gramjs`, `better-sqlite3`, `qrcode`, or any transport-specific SDK. Those belong in adapter packages.
- **One concern per PR** — keep PRs focused. Mixed refactors + features slow review.
- **Add a test or a manual repro** — if you fix a bug, include steps to verify it.

---

## Code Style

- **ESM only** — `"type": "module"` in `package.json`. All imports use `.js` extensions.
- **NodeNext resolution** — `"moduleResolution": "NodeNext"` in `tsconfig.json`. Match it.
- **No barrel-file abuse** — `src/index.ts` re-exports the public API. Internal modules import each other directly.
- **log() not console.log()** — use `log()` from `aibroker` so output respects the configured prefix.
- **Async/await over callbacks** — no raw `EventEmitter` chains where a `Promise` is cleaner.

---

## Where to Start

- **New messaging service** — read `docs/CREATE_ADAPTER.md` and run `aibroker create-adapter my-name`.
- **New AI provider** — read `docs/BACKEND_GUIDE.md` and implement the `Backend` interface.
- **Bug in the IPC layer** — look at `src/ipc/server.ts` and `src/ipc/client.ts`.
- **Bug in the daemon** — look at `src/daemon/index.ts` and `src/daemon/core-handlers.ts`.
- **Build or publish scripts** — `package.json` `scripts` + `npm publish` (prepublishOnly runs `tsc`).
