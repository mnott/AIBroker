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
  dispatchIncomingMessage,
  enqueueContactMessage,
} from "./core/state.js";
export type { CommandHandler } from "./core/state.js";
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

// ── IPC ──
export { WatcherClient } from "./ipc/client.js";
export { IpcServer } from "./ipc/server.js";
export type { IpcHandler } from "./ipc/server.js";

// ── Adapters > iTerm2 ──
export {
  runAppleScript,
  stripItermPrefix,
  withSessionAppleScript,
  sendKeystrokeToSession,
  sendEscapeSequenceToSession,
  typeIntoSession,
  pasteTextIntoSession,
  findClaudeSession,
  isClaudeRunningInSession,
  isItermRunning,
  isItermSessionAlive,
  isScreenLocked,
  writeToTty,
  snapshotAllSessions,
} from "./adapters/iterm/core.js";
export type { SessionSnapshot } from "./adapters/iterm/core.js";
export {
  setItermSessionVar,
  setItermTabName,
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

// ── Adapters > Session Backend ──
export { SessionBackend } from "./adapters/session/backend.js";

// ── Backend ──
export { APIBackend } from "./backend/api.js";
export type { APISession, SessionStatus, SessionState } from "./backend/api.js";
