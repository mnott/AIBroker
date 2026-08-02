/**
 * AIBroker — Platform-agnostic AI message broker.
 *
 * Core modules (types/, core/, ipc/) are platform-independent and have
 * zero dependencies on any messaging SDK or OS-specific tooling.
 *
 * Adapters in adapters/ are optional and platform-specific:
 * - adapters/iterm/  — macOS iTerm2 integration (AppleScript, session management)
 * - adapters/kokoro/ — Kokoro TTS synthesis + Whisper audio transcription
 * - adapters/session/ — SessionBackend: deliver messages via iTerm2 typeIntoSession
 * - adapters/pailot/  — WebSocket gateway for PAILot iOS app connections
 *
 * Hard rule: this package NEVER imports @whiskeysockets/baileys,
 * telegram/gramjs, better-sqlite3, qrcode, or any transport SDK.
 */

// ── Types ──
export * from "./types/index.js";

// ── Core ──
export { log, setLogPrefix } from "./core/log.js";
export { MIME_MAP, lookupMime } from "./core/mime.js";
export { applySharedMarkdownTransforms, markdownToWhatsApp, stripMarkdown } from "./core/markdown.js";
export {
  sessionRegistry,
  managedSessions,
  sessionTtyCache,
  activeClientId,
  activeItermSessionId,
  setActiveClientId,
  setActiveItermSessionId,
  updateSessionTtyCache,
  cachedSessionList,
  cachedSessionListTime,
  setCachedSessionList,
  clientQueues,
  clientWaiters,
  contactMessageQueues,
  contactDirectory,
  voiceConfig,
  setVoiceConfig,
  commandHandler,
  setCommandHandler,
  sentMessageIds,
  messageSource,
  setMessageSource,
  dispatchIncomingMessage,
  enqueueContactMessage,
} from "./core/state.js";
export type { CommandHandler, MessageSource } from "./core/state.js";
export {
  setAppDir,
  getAppDir,
  DEFAULT_VOICE_CONFIG,
  loadVoiceConfig,
  saveVoiceConfig,
  loadSessionRegistry,
  saveSessionRegistry,
} from "./core/persistence.js";
export { MessageRouter, router } from "./core/router.js";
export { deliverViaApi } from "./core/transport.js";
export type { TransportCallbacks } from "./core/transport.js";
export { HybridSessionManager, hybridManager, setHybridManager } from "./core/hybrid.js";
export type { HybridSession, SessionKind } from "./core/hybrid.js";

// ── IPC ──
export { WatcherClient } from "./ipc/client.js";
export { IpcServer } from "./ipc/server.js";
export type { IpcHandler } from "./ipc/server.js";
export {
  validateAdapterHealth,
  validateSessionList,
  validateHubStatus,
  validateTtsResult,
  validateTranscription,
} from "./ipc/validate.js";
export type {
  ValidatedSession,
  ValidatedHubStatus,
  ValidatedTtsResult,
  ValidatedTranscription,
} from "./ipc/validate.js";

// ── Adapters > iTerm2 ──
export {
  runAppleScript,
  stripItermPrefix,
  withSessionAppleScript,
  sendKeystrokeToSession,
  sendEscapeSequenceToSession,
  findClaudeSession,
  isClaudeRunningInSession,
  isItermRunning,
  isItermSessionAlive,
  isScreenLocked,
  writeToTty,
  snapshotAllSessions,
} from "./adapters/iterm/core.js";
export type { SessionSnapshot } from "./adapters/iterm/core.js";

/**
 * Session writes come from the GUARDED facade, not the raw iTerm primitives.
 *
 * These used to be re-exported straight from adapters/iterm/core.js, which
 * writes to a tty with no idea what is reading it. When a session's Claude has
 * exited, its tab is still there at a shell prompt — and a shell executes what
 * it is sent. That is not hypothetical: an ordinary status message containing a
 * fenced code block had its example command run, creating a real task.
 *
 * The guarded versions refuse to write unless the target is showing a live
 * Claude prompt. Same signature, plus an optional `{ allowShell: true }` for
 * callers that genuinely mean to address a shell (launching a session).
 * Anything relying on the old unguarded behaviour to write into a shell must
 * now say so explicitly.
 */
export {
  typeIntoSession,
  pasteTextIntoSession,
  isClaudeSession,
  invalidateReadyCache,
} from "./transport/sync-facade.js";
export {
  setItermSessionVar,
  setItermTabName,
  setItermBadge,
  getItermSessionVar,
  findItermSessionForTermId,
  listClaudeSessions,
  getSessionList,
  createClaudeSession,
  createTerminalTab,
  restartSession,
  killSession,
} from "./adapters/iterm/sessions.js";
export {
  recordFromMic,
  transcribeLocalAudio,
  WHISPER_BIN as DICTATION_WHISPER_BIN,
  WHISPER_MODEL as DICTATION_WHISPER_MODEL,
} from "./adapters/iterm/dictation.js";

// ── Adapters > Kokoro TTS ──
export { textToVoiceNote, speakLocally, listVoices } from "./adapters/kokoro/tts.js";
export type { KokoroVoice } from "./adapters/kokoro/tts.js";
export {
  transcribeAudio,
  splitIntoChunks,
  mimetypeToExt,
  mimetypeToDocExt,
  WHISPER_BIN,
  WHISPER_MODEL,
} from "./adapters/kokoro/media.js";

// ── Adapters > PAILot Gateway ──
export {
  startWsGateway,
  stopWsGateway,
  broadcastText,
  broadcastImage,
  broadcastVoice,
  broadcastStatus,
  hasPailotClients,
  setScreenshotHandler,
} from "./adapters/pailot/gateway.js";

// ── Adapters > Session Backend ──
export { SessionBackend } from "./adapters/session/backend.js";

// ── Backend ──
export { APIBackend } from "./backend/api.js";
export type { APISession, SessionStatus, SessionState } from "./backend/api.js";

// ── Daemon ──
export { startDaemon, DAEMON_SOCKET_PATH } from "./daemon/index.js";
export type { CommandContext } from "./daemon/command-context.js";
export { createHubCommandHandler } from "./daemon/commands.js";
export { handleScreenshot } from "./daemon/screenshot.js";
export { AdapterRegistry } from "./daemon/adapter-registry.js";
export type { AdapterDescriptor } from "./daemon/adapter-registry.js";
export {
  listPaiProjects,
  findPaiProject,
  launchPaiProject,
  getEffectiveConfig,
  invalidatePaiProjectCache,
} from "./daemon/pai-projects.js";
export type { PaiProject } from "./daemon/pai-projects.js";
export { createBrokerMessage } from "./types/broker.js";
export type { BrokerMessage, BrokerMessageType, BrokerMessagePayload, RouteResult } from "./types/broker.js";

// Guarded JSON persistence, exported so consumers stop carrying their own copy.
//
// Telex and Whazaa each grew a private safeReadJson/safeWriteJson pair that
// returned null for a corrupt file exactly as for an absent one and wrote
// non-atomically. That is how a corrupt cache becomes an empty one and a
// corrupt registry becomes permanent. A copy of a fix is a fix that stops
// travelling, so the primitive belongs here rather than in each consumer.
export { loadJson, saveJson, GuardedStore } from "./core/json-store.js";
export type { LoadResult } from "./core/json-store.js";
