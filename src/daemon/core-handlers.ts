/**
 * daemon/core-handlers.ts — Hub-level IPC handlers.
 *
 * Registers the core methods that any adapter or MCP client can call
 * on the hub socket. Transport-specific methods (send, contacts, history)
 * are NOT registered here — adapters handle those on their own sockets.
 *
 * Phase 1 methods:
 *   register_adapter  — adapter announces itself to the hub
 *   unregister_adapter
 *   adapter_list      — list connected adapters
 *   sessions          — list hybrid sessions
 *   switch            — switch active session
 *   end_session       — end a hybrid session
 *   broadcast_status  — push status to all PAILot clients
 *   voice_config      — get/set TTS config
 *   status            — hub health/connection summary
 */

import type { IpcServer } from "../ipc/server.js";
import type { AdapterRegistry } from "./adapter-registry.js";
import type { APIBackend } from "../backend/api.js";
import type { HybridSessionManager } from "../core/hybrid.js";
import { randomUUID } from "node:crypto";
import { registerToken as apnsRegisterToken, getTokens as apnsGetTokens } from "../apns/client.js";
import { createBrokerMessage } from "../types/broker.js";
import type { BrokerMessage } from "../types/broker.js";
import { broadcastStatus, broadcastVoice, broadcastImage, broadcastText, handleMqttCommand } from "../adapters/pailot/gateway.js";
import { mqttRequestDebugState } from "../adapters/pailot/mqtt-broker.js";
import { WatcherClient, UNKNOWN_SESSION_ID } from "../ipc/client.js";
import { saveVoiceConfig, setSessionProject, setPersistentSessionName, getPersistentSessionName, getAllPersistentSessionNames, removePersistentSessionName, lookupPersistentName } from "../core/persistence.js";
import { voiceConfig, setVoiceConfig, activeItermSessionId, lastRoutedSessionId, getAibpBridge, depositToSessionMailbox, drainSessionMailbox, markMailboxShown, peekSessionMailbox, setAttachAlias, hasAttachAlias, mailboxKeys, rememberIdSession, claudeSessionOfId, registerMailboxWaiter, hasActiveWaiter, activeWaiters } from "../core/state.js";
import { splitIntoChunks } from "../adapters/kokoro/media.js";
import { stripMarkdown } from "../core/markdown.js";
import { listPaiProjects, findPaiProject, launchPaiProject } from "./pai-projects.js";
import { readSessionContent, readAllSessionContent } from "./session-content.js";
import { typeWhenInputEmpty } from "./pointer-guard.js";
import { deliveryFor } from "./ingress.js";
import { isGroupJid, decideTranscribe, subscribeGroup, unsubscribeGroup, listSubscriptions, routeInbound, deliverExternalToOwner, type InboundWhatsApp } from "./whatsapp-external.js";
import { statusCache, hashContent } from "../core/status-cache.js";
import { clearAllPaiNames, findItermBundleIdImpostors } from "../adapters/iterm/core.js";
import type { SessionSnapshot } from "../adapters/iterm/core.js";
import { snapshotAllSessions, typeIntoSession, setSessionTitle, itermViewerSessionId, aibrokerIdForPane, isClaudeSession, wasLastEnumerationReliable } from "../transport/sync-facade.js";
import { sameClaudeSession } from "../core/claude-attach.js";
import { resolveSelfSessionId } from "./pai-session-map.js";
import { matchSession, matchAllSessions, resolveCallerSession, cwdMatches, displayName, labelOf, selfSendError } from "../core/session-match.js";
import { audit, noteInbound } from "./audit.js";
import type { IpcRequest } from "../types/ipc.js";
import { setItermSessionVar, setItermTabName, setItermBadge, revealItermSession } from "../adapters/iterm/sessions.js";
import { discoverLiveSessions } from "../core/session-discovery.js";
import { log } from "../core/log.js";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { addRoute, findRoute, noteOwnWrite } from "./inbound.js";
import { issueWriteCredential, botIgnoreRule, routeIgnoresAccount } from "./forge-credential.js";
import { issueOp, whoAmI, READ_VERBS, WRITE_VERBS, type IssueVerb } from "./forge-issues.js";
import { funnelHostname } from "./funnel-watchdog.js";
import { transportLabel } from "../transport/policy.js";
import {
  ISSUE_FIELDS,
  parseRepoUrl,
  routeNameFor,
  registerHook,
  duplicateHooks,
  forgeOf,
} from "./subscribe-issues.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function getPackageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname, "..", "..", "package.json"), "utf-8"));
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

const HUB_VERSION = getPackageVersion();

/**
 * Best human-readable identity for whoever made this call, for the audit trail.
 *
 * Falls back through raw ids rather than to "unknown": an unattributed action
 * is the thing the audit log exists to prevent, so a GUID beats a blank.
 */
/**
 * The caller's iTerm2 session id, from whichever field carried it.
 *
 * Two fields hold the same fact and callers do not agree on which to fill, so
 * asking only one of them silently loses the identity. That is not theoretical:
 * a message between sessions arrived labelled
 * `[Session:w11t0p0:066504E1-…]` because `itermSessionId` was empty and the
 * resolution never ran — the raw composite id went out where the sender's NAME
 * belongs. The `w11t0p0:` prefix is the proof, since the normalisation below
 * strips it and so could never have printed it.
 *
 * That label is not cosmetic. It is the receiver's only evidence of who sent a
 * message, and it is the address they are told to reply to — and a reply tool
 * that takes a name or an index cannot use a GUID. A relay of the operator's
 * own instruction arrived unattributable and unanswerable.
 *
 * Both forms are accepted and normalised the same way: iTerm2 reports
 * `w<window>t<tab>p<pane>:<uuid>`, and only the uuid identifies the session
 * across a move between windows.
 */
export function callerItermId(req: IpcRequest): string | undefined {
  const raw = req.itermSessionId ?? req.sessionId;
  if (!raw) return undefined;
  return raw.includes(":") ? raw.split(":").pop()! : raw;
}

/**
 * What send_to_session types and whether it deposits to the mailbox, for a
 * given noReply mode.
 *
 * Every message is deposited in the mailbox and at most a one-line pointer is
 * typed (idle-only, see pointer-guard.ts) — noReply included. The full text is
 * never typed: it would land in whatever the operator is writing.
 *
 * When a message IS deposited, only a one-line pointer is typed
 * (`[Session:<sender>] <preview> — drain your mailbox (aibroker_receive) for
 * the full text`) — a capped
 * preview (messagePreview), never the full body. Typing the full body and pressing Enter submits it as an
 * ordinary prompt, which fires the target's own `hooks/drain-mailbox.mjs`
 * UserPromptSubmit hook on that same submission. That hook drains the very
 * message this call just deposited and re-injects it as a system-reminder —
 * so the full content showed up twice in one turn: once as the typed prompt,
 * once again from the mailbox. Reproduced live 2026-09-23 on both an idle and
 * a busy target — not a busy-only race. A short pointer and the deposited
 * body are different strings (the preview is capped at ~100 chars, so a long
 * body is never typed whole), so the hook's drain is the only place the full
 * content appears, and a multi-line body is never typed into a live pane at
 * all — the failure mode where only the last line survived typing cannot
 * recur here because there is nothing but one line to type.
 */
export function sendToSessionDelivery(
  message: string,
  senderLabel: string,
  noReply: boolean,
): { typed: string; deposit: boolean } {
  // Never the body: noReply only drops the reply demand, not the mailbox. A
  // typed full message lands in whatever the operator is writing.
  void noReply;
  return { typed: mailboxPointer(senderLabel, messagePreview(message)), deposit: true };
}

/** The one line typed for a deposited message: it says the receiver must drain it. */
export function mailboxPointer(senderLabel: string, preview: string): string {
  return `[Session:${senderLabel}] ${preview} — drain your mailbox (aibroker_receive) for the full text`;
}

const PREVIEW_MAX = 100;

/**
 * The short, single-line summary typed in the pointer — never the full body
 * (see sendToSessionDelivery). Agentish v2 messages (a kind letter on the
 * first line, then k=v lines) are summarised as `i=` `r=` and `g=` (T) or
 * `z=`; anything else is flattened prose. Control characters (CR/LF, ESC, …)
 * are dropped so nothing in it can act as a keystroke; the cut falls on a
 * word boundary and ends with "…".
 */
export function messagePreview(message: string): string {
  const lines = message.split(/\r?\n/);
  let text = message;
  if (/^[TRSQAX]$/.test(lines[0].trim())) {
    const kv = new Map<string, string>();
    for (const l of lines.slice(1)) {
      const m = /^([A-Za-z#]+)=(.*)$/.exec(l.trim());
      if (m && !kv.has(m[1])) kv.set(m[1], m[2]);
    }
    const parts = ["i", "r", lines[0].trim() === "T" ? "g" : "z"].map((k) => { const v = kv.get(k); return v && (k === "r" ? `r=${v}` : v); }).filter(Boolean);
    if (parts.length) text = parts.join(" ");
  }
  // eslint-disable-next-line no-control-regex
  const flat = text.replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim();
  if (flat.length <= PREVIEW_MAX) return flat;
  const cut = flat.slice(0, PREVIEW_MAX + 1);
  const sp = cut.lastIndexOf(" ");
  return `${(sp > 0 ? cut.slice(0, sp) : cut.slice(0, PREVIEW_MAX)).trimEnd()}…`;
}

/**
 * The pane a caller lives in. A caller whose own id has no live pane (its
 * session was moved into a Claude background session, the original pane is a
 * shell) is the pane that attaches to its session uuid.
 */
export function snapForCaller(id: string | undefined, claudeSessionId: string | undefined, snapshots: SessionSnapshot[]): SessionSnapshot | undefined {
  const own = id ? snapshots.find((s) => s.id === id) : undefined;
  if (own && !(own.isClaude === false && claudeSessionId)) return own;
  const viewer = claudeSessionId ? snapshots.find((s) => s.attachUuid && sameClaudeSession(s.attachUuid, claudeSessionId)) : undefined;
  return viewer ?? own;
}

/**
 * The one answer to "which live pane is the caller": manage self, caller
 * labels and sender labels all go through here. A caller whose own id is not a
 * live Claude pane is found by its session uuid (`claude attach <short>`).
 */
export function resolveCallerPane(req: IpcRequest, snapshots: SessionSnapshot[] = snapshotAllSessions()): SessionSnapshot | undefined {
  return snapForCaller(callerItermId(req), req.claudeSessionId, snapshots);
}

/**
 * The caller's own session id, for everything the tools mean by "self".
 *
 * The usual answers first, exactly as resolveCallerPane and callerItermId gave
 * them: the live pane the caller sits in, else the iTerm id it announced. A
 * caller that announced NOTHING — sessionId "unknown-session", the shape of a
 * session run under the Claude background daemon, whose environment carries no
 * ITERM_SESSION_ID and no TERM_SESSION_ID — used to be unanswerable, and those
 * are the overnight supervised sessions that most need to arm themselves. For
 * them PAI's own session map is asked (pai-session-map.ts): the request's
 * claude session uuid — the client read it from the caller's environment —
 * matched against the registry the statusline keeps, else the one fresh entry
 * that names a session this hub can see. The map resolves only when it can do
 * so beyond doubt; otherwise undefined, and the caller is told to name itself.
 */
export async function callerSelfId(req: IpcRequest, snapshots: SessionSnapshot[] = snapshotAllSessions()): Promise<string | undefined> {
  const pane = resolveCallerPane(req, snapshots)?.id;
  if (pane) return pane;
  const claimed = callerItermId(req);
  if (claimed && claimed !== UNKNOWN_SESSION_ID) return claimed;
  const resolved = await resolveSelfSessionId({
    claudeSessionId: req.claudeSessionId,
    knownUids: snapshots.map((s) => s.id),
  });
  return resolved?.id;
}

function callerLabel(req: IpcRequest): string {
  const id = callerItermId(req);
  if (id) {
    const snap = resolveCallerPane(req);
    if (snap) {
      const paiName = lookupPersistentName(getAllPersistentSessionNames(), snap.id, snap.aibrokerId);
      // Namespaced per the audit multi-writer contract: bare names collide
      // across producers once more than one writes to the trail.
      // snap.id, not snap.name: the raw iTerm name reflects the terminal's
      // OWN dynamic title (spinner glyph + tab title for a Claude Code
      // session — "◑ Generic session content (claude)"), not an identity.
      return `session:${paiName ?? snap.id}`;
    }
  }
  return `session:${id ?? req.tmuxPane ?? req.sessionId ?? "unknown"}`;
}

/**
 * The sender's identity for the mailbox "from" field and the `[Session:X]`
 * prefix — bare, unlike callerLabel()'s `session:`-prefixed audit actor.
 *
 * paiName first, then the session's own stable id — never the raw iTerm
 * name/title, which is the terminal's OWN dynamic display text (a spinner
 * glyph plus tab title for a busy Claude Code session) and not an identity.
 * A sender not found in the live snapshot (worker child process, or a bare
 * CLI call with no pane at all) falls back to whatever id it claimed — for a
 * worker that id is a fabricated, non-live marker (see ipc/client.ts), so it
 * naturally fails to match any session and a reply to it is refused rather
 * than silently reaching the wrong pane.
 */
/**
 * Mailbox keys for an id and/or Claude session uuid. When no attach pane is
 * known for the uuid (daemon restarted, nothing sent since), scan live panes
 * for its `claude attach` viewer once, which records the alias.
 */
export function resolveMailboxKeys(id: string | undefined, uuid: string | undefined, scan: () => SessionSnapshot[]): string[] {
  if (uuid && !hasAttachAlias(uuid)) {
    try { for (const snap of scan()) setAttachAlias(snap.id, snap.attachUuid); } catch { /* keep the own-id key */ }
  }
  return mailboxKeys(id, uuid);
}

export function resolveSenderLabel(req: IpcRequest, snapshots: SessionSnapshot[]): string {
  const senderItermId = callerItermId(req);
  const senderSnap = resolveCallerPane(req, snapshots);
  if (senderSnap) return senderSnap.paiName ?? senderSnap.id;
  return senderItermId ?? "unknown";
}

export function registerCoreHandlers(
  server: IpcServer,
  registry: AdapterRegistry,
  _apiBackend: APIBackend,
  manager: HybridSessionManager,
): void {

  server.on("register_adapter", async (req) => {
    const { name, socketPath } = req.params as { name: string; socketPath: string };
    if (!name || !socketPath) return { ok: false, error: "name and socketPath required" };
    registry.register({ name, socketPath, registeredAt: Date.now() });
    return { ok: true, result: { registered: true } };
  });

  server.on("unregister_adapter", async (req) => {
    const { name } = req.params as { name: string };
    registry.unregister(name);
    return { ok: true, result: { unregistered: true } };
  });

  server.on("adapter_list", async (_req) => {
    return { ok: true, result: { adapters: registry.list() } };
  });

  /**
   * One row per listed session, in enumeration order.
   *
   * `sessions` (aibroker_sessions) and send_to_session's target resolution
   * share this: same filter, same numbering, same display name. They used to
   * enumerate separately, and the two lists disagreed — the error's own
   * "Available sessions" line showed different names and indexes than the tool
   * the caller had just read, and a target index taken from the list hit a
   * different tab (live 2026-10-26).
   */
  function listedSessions(): SessionSnapshot[] {
    return discoverLiveSessions().filter((s) => !s.workerPane);
  }

  /** The display name `sessions` shows for a row — the name a target must match. */
  function displayLabelOf(s: SessionSnapshot): string {
    return s.paiName ? displayName(s.paiName, s.cwd) : (s.tabTitle ?? s.name);
  }

  server.on("sessions", async (_req) => {
    // The shared discovery, which is also what the hybrid manager syncs from,
    // so this tool and the channel commands cannot report different machines.
    // The note that used to sit here — "manager.listSessions() is always empty
    // (nothing populates the internal registry)" — described the defect and
    // routed around it; the registry now populates itself.
    const snapshots = listedSessions();
    const sessions = snapshots.map((s, i) => {
      const paiName = s.paiName;
      return {
        index: i + 1,
        sessionId: s.id,
        // A chosen name IS the session's name; the tab title (auto-titler,
        // process string) is only what it falls back to. Raw title stays
        // beside it so a lying display can be told from a lying name.
        name: displayLabelOf(s),
        tabTitle: s.tabTitle,
        paiName,
        atPrompt: s.atPrompt,
        transport: s.transport ?? "iterm",
        cwd: s.cwd ?? null,
        // Measured first, guessed only when there is no measurement: a pane
        // running the launcher is titled like a node process and is not a
        // session, which is how the picker came to list itself.
        kind: (s.isClaude ?? (Boolean(paiName) || !s.atPrompt)) ? "claude" : "shell",
        active: s.id === activeItermSessionId,
      };
    });
    // A failed osascript enumeration reads identically to a truly empty
    // machine unless this says otherwise — see wasLastEnumerationReliable().
    const enumerationFailed = !wasLastEnumerationReliable();
    let enumerationDetail: string | undefined;
    if (enumerationFailed) {
      enumerationDetail = "iTerm enumeration failed; list may be incomplete";
      const impostors = findItermBundleIdImpostors();
      if (impostors.length) {
        enumerationDetail += ` — found ${impostors.map((i) => `pid ${i.pid} (${i.executablePath})`).join(", ")} registered under iTerm's bundle id`;
      }
    }
    return {
      ok: true,
      result: {
        sessions,
        enumerationFailed,
        ...(enumerationFailed ? { enumerationDetail } : {}),
      },
    };
  });

  server.on("switch", async (req) => {
    const { target } = req.params as { target: string | number };

    // An iTerm2 unique ID is not an index, and must not be parsed as one.
    //
    // `parseInt("53ECB67D-7616-…")` is 53, so a UUID target used to be handed
    // to switchToIndex() as position 53 in `manager.listSessions()` — an array
    // nothing populates (see the `sessions` handler above). The result was a
    // flat "Session 53ECB67D-… not found" for every UUID ever passed, which
    // read as a stale session and was in fact a handler that had never
    // supported the argument. `pai <name>` sends exactly this.
    if (typeof target === "string" && !/^\d+$/.test(target.trim())) {
      const revealed = revealItermSession(target.trim());
      if (!revealed) {
        return {
          ok: false,
          error: `No live iTerm2 session with id ${target}`,
          result: { switched: false, gone: true },
        };
      }
      return { ok: true, result: { switched: true, sessionId: target.trim() } };
    }

    const index = typeof target === "number" ? target : parseInt(String(target), 10);
    const session = manager.switchToIndex(index);
    if (!session) return { ok: false, error: `Session ${target} not found` };
    return { ok: true, result: { switched: true, name: session.name } };
  });

  server.on("end_session", async (req) => {
    const { target } = req.params as { target: string | number };
    const index = typeof target === "number" ? target : parseInt(String(target), 10);
    const session = manager.removeByIndex(index);
    if (!session) return { ok: false, error: `Session ${target} not found` };
    return { ok: true, result: { ended: true, name: session.name } };
  });

  server.on("broadcast_status", async (req) => {
    const { status } = req.params as { status: string };
    broadcastStatus(status);
    return { ok: true, result: { status } };
  });

  server.on("voice_config", async (req) => {
    const { action, ...updates } = req.params as { action: "get" | "set" } & Record<string, unknown>;
    if (action === "get") {
      return { ok: true, result: { config: voiceConfig } };
    }
    const merged = { ...voiceConfig, ...updates };
    setVoiceConfig(merged as typeof voiceConfig);
    saveVoiceConfig(merged as typeof voiceConfig);
    return { ok: true, result: { success: true, config: merged } };
  });

  server.on("status", async (_req) => {
    const adapterHealth: Record<string, unknown> = {};
    for (const [name, health] of registry.getAllHealth()) {
      adapterHealth[name] = health;
    }
    // Report LIVE sessions, not manager.listSessions(). That internal registry
    // only holds sessions the hub itself launched, and it empties on every
    // daemon restart — so it read 20 while enumeration was broken and every
    // send was failing, then 0 once enumeration was fixed and everything
    // worked. A status line that inverts the truth is worse than none: it
    // reads as "no sessions registered with the hub" on a perfectly healthy
    // hub. Use the same source send_to_session resolves against, so status
    // agrees with behaviour.
    const live = snapshotAllSessions();
    const persistentNames = getAllPersistentSessionNames();
    const activeSnap = live.find((s) => s.id === activeItermSessionId);
    // Same reliability flag the `sessions` handler reports — the hub is only
    // as healthy as its ability to see what is actually running.
    const enumerationOk = wasLastEnumerationReliable();

    return {
      ok: true,
      result: {
        version: HUB_VERSION,
        status: enumerationOk ? "ok" : "degraded",
        ...(enumerationOk ? {} : { detail: "iTerm AppleScript session enumeration is failing; session list may be stale or incomplete" }),
        transport: transportLabel(),
        adapters: registry.list().map(a => a.name),
        activeSessions: live.length,
        activeSession: activeSnap
          ? (lookupPersistentName(persistentNames, activeSnap.id, activeSnap.aibrokerId) ?? activeSnap.name)
          : null,
        adapterHealth,
      },
    };
  });

  /**
   * ping — Lightweight heartbeat for adapter health checks.
   * Returns immediately with the hub uptime. No side effects.
   */
  server.on("ping", async (_req) => {
    // Machine facts ride along with the cheapest, most-called verb there is.
    // A separate "capabilities" call would be one more thing to remember to ask
    // and one more thing to go stale between asking and using; this way anything
    // that can reach a hub already knows what that hub can do.
    const { machineFacts } = await import("./machine.js");
    return { ok: true, result: { pong: true, uptime: process.uptime(), machine: machineFacts() } };
  });

  /**
   * where — the state of a checkout on this machine.
   *
   * Asked by a lead who wants to know how a machine is getting on without
   * interrupting the agent doing the work. Reports; never controls. The point of
   * giving each machine its own branch is that it proceeds without permission,
   * and what comes back is only enough to decide whether to go and look.
   */
  server.on("where", async (req) => {
    const { repo } = req.params as { repo?: string };
    const { machineFacts, branchState } = await import("./machine.js");
    const facts = machineFacts();
    const root = repo ?? facts.workRoot;
    if (!root) {
      return {
        ok: true,
        result: {
          machine: facts,
          note: "no repository given and no work root configured here (set AIBROKER_WORK_ROOT)",
        },
      };
    }
    return { ok: true, result: { machine: facts, checkout: branchState(root) } };
  });

  // ── TTS / Voice Pipeline ──

  /**
   * tts — Convert text to voice note and deliver to requesting adapter.
   *
   * The hub generates the audio (Kokoro TTS) and sends the OGG buffer
   * back to the adapter that requested it (via the "source" field).
   */
  server.on("tts", async (req) => {
    const { text, voice, source, recipient } = req.params as {
      text?: string;
      voice?: string;
      source?: string;
      recipient?: string;
    };
    if (!text) return { ok: false, error: "text is required" };

    const resolvedVoice = voice ?? voiceConfig.defaultVoice;

    try {
      const { textToVoiceNote } = await import("../adapters/kokoro/tts.js");
      const audioBuffer = await textToVoiceNote(text, resolvedVoice);

      // If a source adapter is specified, deliver the voice note through it
      if (source) {
        const adapter = registry.get(source);
        if (adapter) {
          const msg = createBrokerMessage("hub", "voice", {
            buffer: audioBuffer.toString("base64"),
            text: text.slice(0, 100),
            recipient,
            metadata: { voice: resolvedVoice },
          });
          await registry.deliverToAdapter(adapter, msg);
        }
      }

      // Also broadcast to PAILot clients
      const bridge = getAibpBridge();
      if (bridge) {
        bridge.routeToMobile("", text.slice(0, 200), "VOICE", {
          audioBase64: audioBuffer.toString("base64"),
        });
      } else {
        broadcastVoice(audioBuffer, text.slice(0, 200));
      }

      return { ok: true, result: { generated: true, voice: resolvedVoice, bytes: audioBuffer.length } };
    } catch (err) {
      return { ok: false, error: `TTS failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  });

  /**
   * speak — Play text locally (no network delivery).
   */
  server.on("speak", async (req) => {
    const { text, voice } = req.params as { text?: string; voice?: string };
    if (!text) return { ok: false, error: "text is required" };

    try {
      const { speakLocally } = await import("../adapters/kokoro/tts.js");
      await speakLocally(text, voice ?? voiceConfig.defaultVoice);
      return { ok: true, result: { speaking: true } };
    } catch (err) {
      return { ok: false, error: `Speak failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  });

  /**
   * dictate — Record from mic and transcribe via Whisper.
   */
  server.on("dictate", async (req) => {
    const { maxDuration } = req.params as { maxDuration?: number };

    try {
      const { recordFromMic, transcribeLocalAudio } = await import("../adapters/iterm/dictation.js");
      const audioPath = await recordFromMic(maxDuration ?? 30);
      const text = await transcribeLocalAudio(audioPath);
      return { ok: true, result: { text, audioPath } };
    } catch (err) {
      return { ok: false, error: `Dictation failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  });

  /**
   * transcribe — Transcribe an audio buffer via Whisper.
   */
  server.on("transcribe", async (req) => {
    const { audioBase64, mimetype } = req.params as { audioBase64?: string; mimetype?: string };
    if (!audioBase64) return { ok: false, error: "audioBase64 is required" };

    try {
      const { transcribeAudio, mimetypeToExt } = await import("../adapters/kokoro/media.js");
      const { writeFileSync, unlinkSync } = await import("node:fs");
      const { tmpdir } = await import("node:os");
      const { join } = await import("node:path");
      const ext = mimetypeToExt(mimetype ?? "audio/ogg");
      const tmpPath = join(tmpdir(), `aibroker-transcribe-${Date.now()}.${ext}`);
      writeFileSync(tmpPath, Buffer.from(audioBase64, "base64"));
      try {
        const text = await transcribeAudio(tmpPath);
        return { ok: true, result: { text } };
      } finally {
        try { unlinkSync(tmpPath); } catch { /* ignore */ }
      }
    } catch (err) {
      return { ok: false, error: `Transcription failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  });

  /**
   * list_voices — List available TTS voices.
   */
  server.on("list_voices", async (_req) => {
    const { listVoices } = await import("../adapters/kokoro/tts.js");
    return { ok: true, result: { voices: listVoices() } };
  });

  // ── PAI Named Sessions ──

  server.on("pai_projects", async (_req) => {
    const projects = await listPaiProjects();
    return { ok: true, result: { projects } };
  });

  server.on("pai_find", async (req) => {
    const { name } = req.params as { name: string };
    if (!name) return { ok: false, error: "name is required" };
    const project = await findPaiProject(name);
    if (!project) return { ok: false, error: `Project "${name}" not found` };
    return { ok: true, result: { project } };
  });

  /**
   * dispatch — resolve a project to a session and deliver a work order.
   *
   * The daemon owns this, not the CLI: `aibroker dispatch` is a thin wrapper so
   * shell callers (PAI's task bus) get a stable, versioned boundary, while MCP,
   * PAILot and adapters can route work through the same path without shelling
   * out. Routing outcomes come back as results with ok:true — only genuine
   * infrastructure failure is an error.
   */
  server.on("dispatch", async (req) => {
    const { project, message, noSpawn, budgetMs, spawnTimeoutMs, deliverTimeoutMs } = req.params as {
      project?: string;
      message?: string;
      noSpawn?: boolean;
      budgetMs?: number;
      spawnTimeoutMs?: number;
      deliverTimeoutMs?: number;
    };
    if (!project) return { ok: false, error: "project is required" };
    if (!message) return { ok: false, error: "message is required" };

    const { dispatch } = await import("./dispatch.js");
    const actor = callerLabel(req);
    try {
      const result = await dispatch(project, message, { noSpawn, budgetMs, spawnTimeoutMs, deliverTimeoutMs });
      const eventId = audit({
        action: "dispatch", actor, target: result.session || project,
        outcome: result.outcome, body: message,
        reason: result.reason || undefined,
        meta: { project: result.project },
      });
      if (result.outcome === "delivered" || result.outcome === "spawned") {
        noteInbound(result.session, eventId);
      }
      return { ok: true, result: { ...result } };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      audit({ action: "dispatch", actor, target: project, outcome: "failed", body: message, reason });
      return { ok: false, error: reason };
    }
  });

  /**
   * ask — put a question to a project's session and wait for its answer.
   *
   * Never spawns: a probe that creates the session it is probing reports health
   * for a session that had died.
   */
  server.on("ask", async (req) => {
    const { project, question, timeoutMs } = req.params as {
      project?: string;
      question?: string;
      timeoutMs?: number;
    };
    if (!project) return { ok: false, error: "project is required" };
    if (!question) return { ok: false, error: "question is required" };

    const { ask } = await import("./ask.js");
    const actor = callerLabel(req);
    try {
      const result = await ask(project, question, { timeoutMs });
      audit({
        action: "ask", actor, target: result.session || project,
        outcome: result.state, body: question,
        reason: result.reason || undefined,
        // The answer is the substance of the exchange; without it the record
        // shows that a question was asked but not what came back.
        meta: result.reply ? { reply: result.reply } : undefined,
      });
      return { ok: true, result: { ...result } };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      audit({ action: "ask", actor, target: project, outcome: "failed", body: question, reason });
      return { ok: false, error: reason };
    }
  });

  server.on("pai_launch", async (req) => {
    const { name } = req.params as { name: string };
    if (!name) return { ok: false, error: "name is required" };

    let itermSessionId: string;
    let sessionId: string;
    try {
      ({ itermSessionId, sessionId } = await launchPaiProject(name));
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : String(err);
      audit({ action: "launch", actor: callerLabel(req), target: name, outcome: "failed", reason });
      return { ok: false, error: reason };
    }
    // Creating a session is a cross-session action: it puts a new agent on the
    // machine, in a directory, doing work nobody may be watching.
    audit({
      action: "launch", actor: callerLabel(req), target: name, outcome: "spawned",
      meta: { itermSessionId },
    });

    // Register the visual session with HybridSessionManager
    const project = await findPaiProject(name);
    const displayName = project?.displayName || project?.name || name;
    manager.registerVisualSession(displayName, project?.rootPath ?? "", itermSessionId);

    return { ok: true, result: { itermSessionId, sessionId, name } };
  });

  // ── Phase 6: Image Generation ──

  /**
   * generate_image — Generate an image from a text prompt.
   *
   * Optionally sends an "on it..." ack and delivers the generated image
   * back to the requesting adapter.
   */
  server.on("generate_image", async (req) => {
    const { prompt, source, recipient, ack, width, height } = req.params as {
      prompt?: string;
      source?: string;
      recipient?: string;
      ack?: boolean;
      width?: number;
      height?: number;
    };
    if (!prompt) return { ok: false, error: "prompt is required" };

    // Send "on it..." ack to the requesting adapter
    if (ack !== false && source) {
      const adapter = registry.get(source);
      if (adapter) {
        const ackMsg = createBrokerMessage("hub", "text", {
          text: "On it... generating your image.",
          recipient,
        });
        registry.deliverToAdapter(adapter, ackMsg).catch(() => {});
      }
    }

    try {
      const { generateImage } = await import("./image-gen/index.js");
      const result = await generateImage({ prompt, width, height });

      // Deliver image to requesting adapter
      if (source && result.images.length > 0) {
        const adapter = registry.get(source);
        if (adapter) {
          const imgMsg = createBrokerMessage("hub", "image", {
            buffer: result.images[0].toString("base64"),
            caption: prompt.slice(0, 200),
            recipient,
            metadata: { model: result.model, durationMs: result.durationMs },
          });
          await registry.deliverToAdapter(adapter, imgMsg);
        }
      }

      // Also broadcast to PAILot clients
      if (result.images.length > 0) {
        const bridge = getAibpBridge();
        if (bridge) {
          bridge.routeToMobile("", prompt.slice(0, 200), "IMAGE", {
            imageBase64: result.images[0].toString("base64"),
            mimeType: "image/png",
          });
        } else {
          broadcastImage(result.images[0], prompt.slice(0, 200));
        }
      }

      return {
        ok: true,
        result: {
          generated: true,
          model: result.model,
          durationMs: result.durationMs,
          imageCount: result.images.length,
          bytes: result.images.reduce((s, b) => s + b.length, 0),
        },
      };
    } catch (err) {
      return { ok: false, error: `Image generation failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  });

  // ── Phase 7: Vision & Understanding ──

  /**
   * analyze_image — Save image and deliver to active Claude Code session.
   *
   * The image is saved to ~/.aibroker/media/ and the path is routed through
   * the command handler to the active iTerm2 session. Claude Code in that
   * session reads the image with its Read tool (covered by Max plan).
   */
  server.on("analyze_image", async (req) => {
    const { imageBase64, mimetype, prompt, source, recipient } = req.params as {
      imageBase64?: string;
      mimetype?: string;
      prompt?: string;
      source?: string;
      recipient?: string;
    };
    if (!imageBase64) return { ok: false, error: "imageBase64 is required" };

    try {
      const { saveReceivedImage } = await import("./vision.js");
      const imageBuffer = Buffer.from(imageBase64, "base64");
      const { path, sizeBytes } = saveReceivedImage(imageBuffer, mimetype);

      // Route through the command handler → active iTerm2 session
      const userPrompt = prompt ?? "Analyze this image.";
      const messageText = `[Image: ${path}] ${userPrompt}`;

      const sourceAdapter = source ? registry.get(source) : undefined;
      const msg = createBrokerMessage(source ?? "hub", "command", {
        text: messageText,
        recipient,
      });
      await registry.route(msg);

      return { ok: true, result: { saved: true, path, sizeBytes } };
    } catch (err) {
      return { ok: false, error: `Image analysis failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  });

  /**
   * analyze_video — Analyze a video using Gemini 2.0 Flash (free tier).
   *
   * Video can't be read by Claude Code's Read tool, so we use Gemini's
   * native video understanding and deliver the text result back.
   */
  server.on("analyze_video", async (req) => {
    const { videoBase64, mimetype, prompt, source, recipient } = req.params as {
      videoBase64?: string;
      mimetype?: string;
      prompt?: string;
      source?: string;
      recipient?: string;
    };
    if (!videoBase64) return { ok: false, error: "videoBase64 is required" };

    // Ack — video analysis takes longer
    if (source) {
      const adapter = registry.get(source);
      if (adapter) {
        const ackMsg = createBrokerMessage("hub", "text", {
          text: "Analyzing your video...",
          recipient,
        });
        registry.deliverToAdapter(adapter, ackMsg).catch(() => {});
      }
    }

    try {
      const { analyzeVideo, saveReceivedVideo } = await import("./vision.js");

      const videoBuffer = Buffer.from(videoBase64, "base64");
      const { path } = saveReceivedVideo(videoBuffer, mimetype);
      const result = await analyzeVideo({ videoBuffer, mimetype, prompt });

      // Deliver the analysis text to the active session
      if (result.text) {
        const analysisText = `[Video analysis of ${path}]\n\n${result.text}`;
        const msg = createBrokerMessage(source ?? "hub", "command", {
          text: analysisText,
          recipient,
        });
        await registry.route(msg);
      }

      return { ok: true, result: { text: result.text, model: result.model, durationMs: result.durationMs, path } };
    } catch (err) {
      return { ok: false, error: `Video analysis failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  });

  // ── Session Orchestration (Phase 1) ──

  /**
   * session_content — Read raw terminal content from iTerm2 sessions.
   *
   * If sessionId is provided, reads that specific session.
   * If omitted, reads all sessions. Returns raw content + busy/idle flag
   * + whether content has changed since last probe (via content hash).
   */
  server.on("session_content", async (req) => {
    const { sessionId, lines } = req.params as {
      sessionId?: string;
      lines?: number;
    };

    const lineCount = lines ?? 100;

    // Display fields follow the same authority as the `sessions` handler: the
    // chosen (persistent) name first, then the tab title, with the raw title
    // kept in tabTitle. The content read reports the terminal's own process
    // name, which is not what a human calls the session.
    const snaps = new Map(snapshotAllSessions().map((s) => [s.id, s]));
    const persistentNames = getAllPersistentSessionNames();
    const display = (id: string, raw: { name: string; paiName: string | null }) => {
      const snap = snaps.get(id);
      const paiName = lookupPersistentName(persistentNames, id, snap?.aibrokerId) ?? raw.paiName;
      const tabTitle = snap?.tabTitle ?? null;
      return { name: paiName ?? tabTitle ?? raw.name, tabTitle, paiName };
    };

    if (sessionId) {
      const content = readSessionContent(sessionId, lineCount);
      if (!content) return { ok: false, error: `Session ${sessionId} not found` };

      const contentHash = hashContent(content.content);
      const changed = statusCache.hasChanged(sessionId, contentHash);
      const cached = statusCache.get(sessionId);

      if (!changed) {
        statusCache.touch(sessionId);
      }

      return {
        ok: true,
        result: {
          session: {
            ...content,
            ...display(sessionId, content),
            contentHash,
            changed,
            cachedSummary: cached?.summary ?? null,
            cachedAt: cached?.timestamp ?? null,
          },
        },
      };
    }

    // All sessions
    const contents = readAllSessionContent(lineCount);
    const sessions = contents.map((c) => {
      const contentHash = hashContent(c.content);
      const changed = statusCache.hasChanged(c.sessionId, contentHash);
      const cached = statusCache.get(c.sessionId);
      if (!changed) statusCache.touch(c.sessionId);

      return {
        ...c,
        ...display(c.sessionId, c),
        contentHash,
        changed,
        cachedSummary: cached?.summary ?? null,
        cachedAt: cached?.timestamp ?? null,
      };
    });

    return { ok: true, result: { sessions } };
  });

  /**
   * cache_status — Store a parsed summary for a session.
   *
   * Called by the requesting session's AI after parsing raw terminal content.
   * The summary is cached with the content hash so future probes can skip parsing
   * if content hasn't changed.
   */
  server.on("cache_status", async (req) => {
    const { sessionId, sessionName, summary, contentHash, state } = req.params as {
      sessionId?: string;
      sessionName?: string;
      summary?: string;
      contentHash?: string;
      state?: "idle" | "busy" | "error" | "disconnected";
    };
    if (!sessionId) return { ok: false, error: "sessionId is required" };
    if (!summary) return { ok: false, error: "summary is required" };

    statusCache.set(sessionId, {
      sessionId,
      sessionName: sessionName ?? sessionId,
      timestamp: Date.now(),
      state: state ?? "idle",
      summary,
      contentHash: contentHash ?? "",
      lastProbeAt: Date.now(),
    });

    return { ok: true, result: { cached: true, sessionId } };
  });

  /**
   * get_cached_status — Retrieve cached session summaries without re-probing.
   *
   * If sessionId is provided, returns that session's cached snapshot.
   * If omitted, returns all cached snapshots.
   */
  server.on("get_cached_status", async (req) => {
    const { sessionId } = req.params as { sessionId?: string };

    if (sessionId) {
      const cached = statusCache.get(sessionId);
      if (!cached) return { ok: true, result: { snapshot: null } };
      return { ok: true, result: { snapshot: cached } };
    }

    return { ok: true, result: { snapshots: statusCache.getAll() } };
  });

  // ── AIBP Protocol Support ──

  /**
   * aibp_register — Register an MCP process as an AIBP plugin.
   * Called once when the MCP server starts. Returns the resolved session
   * so the MCP doesn't need TTY detection for routing.
   */
  server.on("aibp_register", async (req) => {
    const { pluginId, sessionEnvId } = req.params as {
      pluginId?: string;
      sessionEnvId?: string;
    };
    if (!pluginId) return { ok: false, error: "pluginId is required" };

    const bridge = getAibpBridge();
    if (!bridge) return { ok: false, error: "AIBP bridge not initialized" };

    const result = bridge.registerMcp(pluginId, sessionEnvId);
    return {
      ok: true,
      result: {
        address: result.address,
        resolvedSession: result.resolvedSession,
      },
    };
  });

  /**
   * aibp_send — Send a message from one session to another via AIBP.
   * Enables cross-session messaging: session A can send text to session B.
   */
  server.on("aibp_send", async (req) => {
    const { fromSession, toSession, content, type } = req.params as {
      fromSession?: string;
      toSession?: string;
      content?: string;
      type?: "TEXT" | "COMMAND";
    };
    if (!toSession) return { ok: false, error: "toSession is required" };
    if (!content) return { ok: false, error: "content is required" };

    const bridge = getAibpBridge();
    if (!bridge) return { ok: false, error: "AIBP bridge not initialized" };

    bridge.routeBetweenSessions(
      fromSession ?? "unknown",
      toSession,
      content,
      type ?? "TEXT",
    );
    return { ok: true, result: {} };
  });

  /**
   * aibp_status — Query AIBP registry state (plugins, channels, commands).
   */
  server.on("aibp_status", async () => {
    const bridge = getAibpBridge();
    if (!bridge) return { ok: false, error: "AIBP bridge not initialized" };

    // Build iTerm session ID → name lookup from HybridSessionManager
    const sessionNames = new Map<string, string>();
    for (const s of manager.listSessions()) {
      sessionNames.set(s.backendSessionId, s.name);
    }

    // Enrich plugin list with session names for MCP plugins
    const plugins = bridge.registry.listPlugins().map(p => {
      const info: Record<string, unknown> = {
        address: p.address,
        type: p.spec.type,
        name: p.spec.name,
      };
      // For MCP plugins, resolve the session name from the iTerm UUID
      if (p.spec.type === "mcp") {
        const sessionChannel = Array.from(p.joinedChannels).find(ch => ch.startsWith("session:"));
        if (sessionChannel) {
          const itermId = sessionChannel.slice(8);
          const sessionName = sessionNames.get(itermId);
          if (sessionName) info.sessionName = sessionName;
        }
      }
      return info;
    });

    // Session snapshots (iTerm sessions with idle/busy status)
    const snapshots = snapshotAllSessions();
    const allPersistentNames = getAllPersistentSessionNames();
    const sessions = snapshots.map((snap, i) => {
      const paiName = allPersistentNames[snap.id] ?? null;
      const label = paiName ?? snap.tabTitle ?? snap.name;
      const isActive = snap.id === activeItermSessionId;
      const cached = statusCache.get(snap.id);
      const hasFreshSummary = cached?.summary && Date.now() - cached.timestamp < 5 * 60 * 1000;
      return {
        index: i + 1,
        id: snap.id,
        name: label,
        atPrompt: snap.atPrompt,
        active: isActive,
        summary: hasFreshSummary ? cached!.summary : undefined,
      };
    });

    return {
      ok: true,
      result: {
        sessions,
        plugins,
        channels: bridge.registry.listChannels().map(ch => ({
          name: ch.channel,
          members: Array.from(ch.members),
          outboxSize: ch.outbox.length,
        })),
        commands: bridge.listCommands().map(c => ({
          name: c.name,
          owner: c.owner,
          description: c.spec?.description,
        })),
      },
    };
  });

  // ── Inter-Session Communication ──

  /**
   * send_to_session — Type a message into a target iTerm2 session.
   *
   * Resolves the target against the SAME list `sessions` returns
   * (listedSessions(): worker panes dropped, enumeration order):
   *   1. Number → that list's 1-based index, so an index read off
   *      aibroker_sessions addresses the row it was read from
   *   2. iTerm UUID (contains hyphens and matches length) → used directly
   *   3. String → exact match against the displayed name, paiName or tab
   *      title, then a unique substring; an ambiguous name errors with the
   *      candidates' UUIDs instead of guessing (live 2026-10-26: the exact
   *      name aibroker_sessions showed reported "not found", and the
   *      fallback list renumbered to different names)
   *
   * Calls typeIntoSession which writes text + Enter into the session's stdin.
   *
   * noReply: for automated beats that expect no answer. Delivered like any
   * other message (mailbox + idle-only pointer); see sendToSessionDelivery().
   */
  server.on("send_to_session", async (req) => {
    const { target: targetParam, message, noReply = false, mailboxOnly: mailboxOnlyParam = false, source = "session" } = req.params as { target?: string; message?: string; noReply?: boolean; mailboxOnly?: boolean; source?: string };
    if (!targetParam) return { ok: false, error: "target is required" };
    if (!message) return { ok: false, error: "message is required" };
    const target = targetParam;

    /**
     * `peer/session` goes to that machine, everything else stays here.
     *
     * The check is one line at the top rather than a branch woven through the
     * resolution below, because the remote case is not a variant of the local
     * one — it is the same request asked of a different hub. Anything more
     * clever would mean every future change to session resolution had to be
     * made twice and would eventually be made once.
     */
    {
      const { forwardToPeer } = await import("./peer-handlers.js");
      const forwarded = await forwardToPeer(target, "send_to_session", { message, noReply, mailboxOnly: mailboxOnlyParam, source });
      if (forwarded) {
        return forwarded.ok
          ? { ok: true, result: forwarded.result ?? { sent: true } }
          : { ok: false, error: forwarded.error ?? "the peer refused it" };
      }
    }

    /**
     * What one target resolves to, against the SAME list `sessions` shows.
     *
     * `id` null means no match; `ambiguous` carries every equally-ranked
     * candidate when a name matches more than one session.
     */
    interface TargetMatch {
      id: string | null;
      name: string | null;
      ambiguous?: { label: string; id: string; kind: string }[];
    }

    // Enrich with persistent names so target-by-name matches a renamed session
    // (tmux names key on the durable @aibroker_id, not the volatile pane id).
    // discoverLiveSessions already fills paiName and replays the last good list
    // on a failed enumeration — the same source `sessions` lists from.
    function withPersistentNames(snaps: SessionSnapshot[]): SessionSnapshot[] {
      const persistentNames = getAllPersistentSessionNames();
      for (const snap of snaps) {
        snap.paiName = lookupPersistentName(persistentNames, snap.id, snap.aibrokerId);
        setAttachAlias(snap.id, snap.attachUuid);
      }
      return snaps;
    }

    function resolveTarget(snaps: SessionSnapshot[]): TargetMatch {
      const asNumber = parseInt(target, 10);
      if (!Number.isNaN(asNumber) && String(asNumber) === target.trim()) {
        // Numeric index (1-based) into the listed rows — the numbering
        // aibroker_sessions shows. Indexing the raw snapshot (worker panes
        // and all) shifted every index: target "10" from the list hit a
        // worker tab (live 2026-10-26).
        const snap = snaps[asNumber - 1];
        return snap ? { id: snap.id, name: displayLabelOf(snap) } : { id: null, name: null };
      }
      if (/^[0-9A-Fa-f-]{20,}$/.test(target)) {
        // Looks like an iTerm UUID — use directly if it exists. A pane that is
        // no longer Claude (or gone) whose session now runs behind an attach
        // pane is redirected to that pane. A Claude session UUID (what
        // aibroker_sessions prints beside the row) resolves the same way:
        // live 2026-10-26 the UUID alone worked only because the pane id
        // matched; a session uuid with no remembered mapping was trusted as an
        // id and typed into nothing.
        const snap = snaps.find((s) => s.id === target);
        const uuid = claudeSessionOfId(target) ?? (snap?.isClaude === true ? snap.attachUuid ?? target : undefined);
        const viewer = uuid && snap?.isClaude !== true ? snaps.find((s) => s.attachUuid && sameClaudeSession(s.attachUuid, uuid)) : undefined;
        if (viewer) return { id: viewer.id, name: displayLabelOf(viewer) };
        if (snap) return { id: snap.id, name: displayLabelOf(snap) };
        // Trust the caller — they may have a valid ID not yet in the snapshot
        return { id: target, name: target };
      }
      // Name match, case-insensitive, against every name the list may show:
      // the displayed label ("Archiware (Chenarlier)"), paiName, tab title.
      //
      // Ranked rather than first-match. A substring search over every tab will
      // happily resolve a departed session's name to a leftover SHELL whose
      // path merely contains the same string — observed live: addressing
      // "Clickr" after that session ended matched the shell tab sitting in
      // ~/dev/ai/clickr, and the message was executed there. Every ended
      // session leaves such a tab behind, so this is not a rare state.
      //
      // Preference order: a live Claude session beats a shell; an exact name
      // match beats a substring one. A target that matches nothing resolves
      // to null and the caller is refused — never silently to a shell.
      // Shared with dispatch's project matching — see core/session-match.ts.
      // `prefer` is what keeps a live Claude session ahead of a shell, and
      // substring is enabled here (unlike dispatch) because a human typing a
      // target expects "clickr" to find "Clickr (node)".
      const candidates = snaps.map((s) => ({
        id: s.id,
        name: s.name,
        paiName: s.paiName,
        isClaude: s.isClaude,
        displayLabel: displayLabelOf(s),
        cwd: s.cwd,
      }));
      const hits = matchAllSessions([target], candidates, {
        kinds: ["exact", "normalised", "substring"],
        // A session running in the project the target names outranks one that
        // merely carries the name (a "PAI" tab sitting in a CaseLeaf checkout).
        // Measured Claude outranks a measured shell — the process table, not
        // the pane capture: a session mid-task has a busy screen, and reading
        // "not ready" off it demoted it below a leftover shell that matched
        // the same name exactly (live 2026-10-26: "Archiware (Chenarlier)"
        // resolved to the shell tab and was refused as a shell).
        prefer: (s) => (s.isClaude === true ? 1 : s.isClaude === false ? 0 : (isClaudeSession(s.id) ? 1 : 0)) + (cwdMatches(target, s.cwd) ? 0.5 : 0),
      });
      if (hits.length === 0) return { id: null, name: null };
      // Equal top score = the name means more than one session. Guessing here
      // delivers work to the wrong session; the caller picks by UUID.
      const top = hits[0];
      const tied = hits.filter((h) => h.score === top.score);
      if (tied.length > 1) {
        return {
          id: null,
          name: null,
          ambiguous: tied.map((h) => ({ label: h.label, id: h.session.id, kind: h.kind })),
        };
      }
      return { id: top.session.id, name: top.label };
    }

    let snapshots = withPersistentNames(listedSessions());
    rememberIdSession(callerItermId(req) ?? "", req.claudeSessionId);
    let match = resolveTarget(snapshots);
    let itermSessionId = match.id;
    let resolvedName = match.name;

    /*
     * A failed/empty enumeration must not read as "no such session". Observed
     * live: `send_to_session` reported target "AIBroker" not found, with an
     * EMPTY session list, while that session was live — a listing seconds
     * later (past the snapshot cache TTL) showed 14 sessions. Retry fresh a
     * couple of times before giving up, since osascript failures are usually
     * transient (iTerm busy, a slow poll). An ambiguous name is not a miss:
     * it is an answer, and retrying cannot un-tie it.
     */
    for (let attempt = 0; !itermSessionId && !match.ambiguous && !wasLastEnumerationReliable() && attempt < 2; attempt++) {
      await new Promise((r) => setTimeout(r, 400));
      snapshots = withPersistentNames(listedSessions());
      match = resolveTarget(snapshots);
      itermSessionId = match.id;
      resolvedName = match.name;
    }

    if (match.ambiguous) {
      audit({
        action: "refuse", actor: `session:${resolveSenderLabel(req, snapshots)}`, target,
        outcome: "refused", body: message,
        reason: `target name "${target}" matches ${match.ambiguous.length} sessions — none picked, name the one by its id`,
      });
      return {
        ok: false,
        error:
          `Target "${target}" is ambiguous — ${match.ambiguous.length} sessions match at the same rank: ` +
          `${match.ambiguous.map((c) => `"${c.label}" (${c.id})`).join(", ")}. ` +
          `Name the one by its id (or its index from aibroker_sessions).`,
      };
    }

    if (!itermSessionId) {
      // Still nothing — but if the enumeration itself never came back
      // reliable, "not found" is a lie: iTerm never actually answered, so
      // there is no evidence the target doesn't exist. Queue by the
      // requested name instead of dropping it, using the id the session was
      // last known under (persisted names survive an enumeration outage).
      if (!wasLastEnumerationReliable()) {
        const persistedId = Object.entries(getAllPersistentSessionNames())
          .find(([, name]) => name.toLowerCase() === target.toLowerCase())?.[0];
        if (persistedId) {
          const senderLabel = resolveSenderLabel(req, snapshots);
          const evicted = depositToSessionMailbox(persistedId, senderLabel, message);
          if (evicted) {
            audit({
              action: "send", actor: `session:${evicted.from}`, target,
              outcome: "evicted", body: evicted.content,
              reason: "mailbox full — oldest undrained message discarded to make room",
            });
          }
          audit({
            action: "send", actor: `session:${senderLabel}`, target,
            outcome: "queued", body: message,
            reason: "iTerm enumeration was unreliable — could not confirm the session is live, queued by its last known id",
          });
          return {
            ok: true,
            result: {
              sent: true, delivered: false, queued: true,
              sessionId: persistedId, name: target,
              note: "iTerm did not answer reliably, so this could not be typed. Queued in the session's mailbox by its last known name; readable with aibroker_receive once it's live.",
            },
          };
        }
      }
      // Same list, same numbering, same display names as aibroker_sessions —
      // so the index in this error is one the caller can act on.
      return {
        ok: false,
        error: `Session "${target}" not found. Available sessions: ${snapshots.map((s, i) => `${i + 1}:${displayLabelOf(s)} (${s.id})`).join(", ")}`,
      };
    }

    // Resolve the sender's name for the mailbox "from" label and the prefix.
    const senderLabel = resolveSenderLabel(req, snapshots);

    // A measured shell must never win a name against a Claude session that
    // carries it. The prefer ranking usually keeps them apart, but when the
    // measurement is unavailable (isClaude undefined) an exact shell hit can
    // tie with a fuzzy Claude hit and enumeration order decides. Here the
    // target is refused rather than typed into a shell that would execute it:
    // if a Claude session shares the name, say so and name it by id.
    if (!isClaudeSession(itermSessionId) && snapshots.find((s) => s.id === itermSessionId)?.isClaude !== true) {
      const claudes = matchAllSessions([target], snapshots.map((s) => ({
        id: s.id, name: s.name, paiName: s.paiName, isClaude: s.isClaude, displayLabel: displayLabelOf(s),
      })), {
        kinds: ["exact", "normalised", "substring"],
      }).filter((h) => h.session.id !== itermSessionId && h.session.isClaude === true);
      if (claudes.length) {
        audit({
          action: "refuse", actor: `session:${senderLabel}`, target: resolvedName ?? target,
          outcome: "refused", body: message,
          reason: "name matched a shell tab while a live Claude session carries the same name",
        });
        return {
          ok: false,
          error:
            `Session "${resolvedName}" is a shell, not a live Claude prompt, so nothing was sent ` +
            `(a shell would execute the message rather than read it). A Claude session carries this name: ` +
            `${claudes.map((c) => `"${c.label}" (${c.session.id})`).join(", ")} — target it by its id.`,
        };
      }
    }

    const selfErr = selfSendError(resolveCallerPane(req, snapshots)?.id, itermSessionId, senderLabel, resolvedName ?? target);
    if (selfErr) {
      audit({ action: "refuse", actor: `session:${senderLabel}`, target: resolvedName ?? target, outcome: "refused", body: message, reason: "sender and target are the same session" });
      return { ok: false, error: selfErr };
    }

    // Refuse before depositing OR typing: if the target is a shell, the message
    // is not merely undeliverable, it is executable. Say so plainly rather than
    // reporting a generic write failure.
    if (!isClaudeSession(itermSessionId)) {
      // Recorded: a refusal is part of the history too, and "the hub declined
      // to type this into a shell" is exactly the kind of thing that otherwise
      // leaves no trace anywhere.
      audit({
        action: "refuse", actor: `session:${senderLabel}`, target: resolvedName ?? target,
        outcome: "refused", body: message,
        reason: "target terminal is a shell, not a live Claude prompt",
      });
      return {
        ok: false,
        error:
          `Session "${resolvedName}" is not running Claude — its terminal is at a shell prompt, ` +
          `so nothing was sent (a shell would execute the message rather than read it). ` +
          `An ended session leaves its tab behind; close it, or target a session that is running.`,
      };
    }

    // Only the operator's own channels type into the input line; machine
    // ingress is mailbox-only once a waiter can wake the session (ingress.ts).
    const mailboxOnly = mailboxOnlyParam || deliveryFor(source, hasActiveWaiter(mailboxKeys(itermSessionId, claudeSessionOfId(itermSessionId)))) === "mailboxOnly";

    // What gets typed and whether it goes to the mailbox — see
    // sendToSessionDelivery() for why noReply skips both.
    const { typed: prefixedMessage, deposit: shouldDeposit } = sendToSessionDelivery(message, senderLabel, noReply);

    // Deposit into the target session's mailbox (structured receive). This is
    // what makes the message recoverable even when the typed copy is not seen:
    // the target can always drain it with aibroker_receive.
    const evicted = shouldDeposit ? depositToSessionMailbox(itermSessionId, senderLabel, message) : undefined;
    if (evicted) {
      // A full mailbox used to drop its oldest message with no trace — the
      // same silent loss this mailbox exists to prevent, one level down.
      audit({
        action: "send", actor: `session:${evicted.from}`, target: resolvedName ?? target,
        outcome: "evicted", body: evicted.content,
        reason: "mailbox full — oldest undrained message discarded to make room",
      });
    }

    // mailboxOnly: the message is in the mailbox and nothing is typed. The
    // target's UserPromptSubmit hook delivers it at the operator's next prompt,
    // so the input line is never touched.
    if (mailboxOnly) {
      log(`send_to_session: mailbox-only delivery ${senderLabel} -> ${resolvedName ?? target} (${itermSessionId.slice(0, 8)}), nothing typed`);
      const eventId = audit({
        action: "send", actor: `session:${senderLabel}`, target: resolvedName ?? target,
        outcome: "queued", body: message, reason: "mailboxOnly — stored in the mailbox, nothing typed", meta: { noReply, mailboxOnly },
      });
      noteInbound(resolvedName ?? target, eventId);
      return {
        ok: true,
        result: {
          sent: true, delivered: false, queued: true, mailboxOnly: true,
          sessionId: itermSessionId, name: resolvedName,
          note: "Stored in the session's mailbox only; nothing was typed. It is delivered at that session's next prompt (or aibroker_receive).",
        },
      };
    }

    // Confirm the target actually took it, rather than reporting success for a
    // write that landed in an input box and scrolled out of attention.
    //
    // typeIntoSession() returns whether the WRITE happened. That is not the
    // same question. A message typed into a busy session sits unsubmitted and
    // this used to be audited as "delivered" — the sender saw ok:true for a
    // message that was never read. submitAndConfirm() watches for the one
    // transition that only happens on submit: the text leaves the input line
    // and appears above it.
    // retries = 1, and that is load-bearing. submitAndConfirm defaults to three
    // attempts because dispatch may be talking to a session that was not ready
    // and where an earlier attempt never landed at all. Here the session is
    // live and the text is already sitting in its input box: typing it again is
    // not a retry, it is a second copy. The first version of this fix used the
    // default and delivered one message to PAI three times — the exact mirror
    // of the bug it was fixing, one delivery reported as three instead of three
    // reported as one. An unconfirmed message is queued in the mailbox, which
    // is what makes a single attempt safe.
    //
    // The input line is checked first (pointer-guard.ts): typing + Enter into a
    // line the operator is half-way through submits their sentence mid-word. A
    // held line (or an unreadable pane) types nothing; the deposit above
    // already made the message recoverable and a retry types the pointer once
    // the line clears.
    const guarded = await typeWhenInputEmpty(itermSessionId, prefixedMessage, {
      multi: shouldDeposit ? (n) => mailboxPointer(senderLabel, `${n} messages`) : undefined,
    });
    const ack = guarded.typed ? guarded.ack : "held";

    if (ack === "ok") {
      const eventId = audit({
        action: "send", actor: `session:${senderLabel}`, target: resolvedName ?? target,
        outcome: "delivered", body: message, meta: { noReply },
      });
      // The recipient's next outgoing action can now be attributed to this one,
      // which is what turns isolated events into a traceable chain.
      noteInbound(resolvedName ?? target, eventId);
      return {
        ok: true,
        result: { sent: true, delivered: true, queued: shouldDeposit, sessionId: itermSessionId, name: resolvedName },
      };
    }

    // Not delivered — but not lost either. Say which, in both the audit and the
    // result, because "queued" and "delivered" are different promises and the
    // caller is entitled to know which one it got.
    const reason = !guarded.typed
      ? guarded.reason
      : ack === "unreadable"
      ? "could not read the target terminal, so submission could not be confirmed"
      : "typed but never observed leaving the input box — the target may be mid-task";
    const eventId = audit({
      action: "send", actor: `session:${senderLabel}`, target: resolvedName ?? target,
      outcome: "queued", body: message, reason, meta: { noReply },
    });
    noteInbound(resolvedName ?? target, eventId);
    return {
      ok: true,
      result: {
        sent: true, delivered: false, queued: shouldDeposit,
        sessionId: itermSessionId, name: resolvedName,
        note: shouldDeposit
          ? `${reason}. It is in the session's mailbox and readable with aibroker_receive.`
          : `${reason}. `,
      },
    };
  });

  /**
   * session_mailbox_receive — Drain the calling session's message mailbox.
   *
   * Returns all pending messages deposited by send_to_session from other sessions.
   * The queue is cleared on read (drain semantics). Returns empty array if no messages.
   * Destructive in one call — interactive callers (aibroker_receive) only.
   *
   * The drain-mailbox hook must NOT use this: its 1.5 s client timeout can fire
   * after the daemon has already emptied the mailbox, losing the message (live
   * 2026-09-25). The hook uses the two-phase pair below instead:
   * session_mailbox_peek (read without clearing) → emit → session_mailbox_ack
   * (clear what was peeked). A lost ack means redelivery, not loss.
   *
   * The caller's iTerm session ID is taken from req.itermSessionId (set by IPC server
   * from the session context) or from the explicit sessionId param as a fallback.
   *
   * iTerm2 session IDs in env vars have the form "w0t0p0:UUID". We normalize to just
   * the UUID so mailbox keys match snapshot IDs.
   */
  const mailboxSessionId = (req: IpcRequest): string | undefined => {
    const { sessionId: explicitSessionId } = req.params as { sessionId?: string };
    const rawId = req.itermSessionId ?? explicitSessionId ?? req.sessionId;
    if (!rawId) return undefined;
    // Normalize "w0t0p0:UUID" → "UUID"
    return rawId.includes(":") ? rawId.split(":").pop()! : rawId;
  };

  /** Own id (if any) plus any attach pane viewing the caller's Claude session; also remembers id → session. */
  const mailboxKeysFor = (req: IpcRequest, id: string | undefined): string[] => {
    const { claudeSessionId: explicit } = req.params as { claudeSessionId?: string };
    const uuid = req.claudeSessionId ?? explicit;
    if (id) rememberIdSession(id, uuid);
    return resolveMailboxKeys(id, uuid, snapshotAllSessions);
  };

  /** A request names a mailbox by iTerm id, Claude session uuid, or both. */
  const hasMailboxIdentity = (req: IpcRequest): boolean => {
    const { claudeSessionId: explicit } = req.params as { claudeSessionId?: string };
    return !!(mailboxSessionId(req) ?? req.claudeSessionId ?? explicit);
  };

  server.on("session_mailbox_receive", async (req) => {
    const itermSessionId = mailboxSessionId(req);
    if (!hasMailboxIdentity(req)) {
      return { ok: false, error: "Cannot determine session ID — pass sessionId param or run inside an iTerm session" };
    }
    const messages = drainSessionMailbox(mailboxKeysFor(req, itermSessionId));
    return { ok: true, result: { messages, sessionId: itermSessionId } };
  });

  /** Phase 1 of the hook's drain: return the pending messages WITHOUT clearing. */
  server.on("session_mailbox_peek", async (req) => {
    const itermSessionId = mailboxSessionId(req);
    if (!hasMailboxIdentity(req)) {
      return { ok: false, error: "Cannot determine session ID — pass sessionId param or run inside an iTerm session" };
    }
    const keys = mailboxKeysFor(req, itermSessionId);
    if ((req.params as { waiter?: boolean }).waiter) registerMailboxWaiter(keys);
    return { ok: true, result: { messages: peekSessionMailbox(keys), sessionId: itermSessionId } };
  });

  /** Sessions with an active `aibroker mailbox wait`. */
  server.on("mailbox_waiters", async () => ({ ok: true, result: { waiters: activeWaiters() } }));

  /**
   * Phase 2 of the hook's drain: clear what was peeked, return how many went.
   * An optional count clears only the oldest N, so a message deposited after
   * the peek survives for the next one.
   */
  server.on("session_mailbox_ack", async (req) => {
    const itermSessionId = mailboxSessionId(req);
    if (!hasMailboxIdentity(req)) {
      return { ok: false, error: "Cannot determine session ID — pass sessionId param or run inside an iTerm session" };
    }
    const { count } = req.params as { count?: number };
    const cleared = markMailboxShown(mailboxKeysFor(req, itermSessionId), count ?? Infinity);
    return { ok: true, result: { cleared, sessionId: itermSessionId } };
  });

  // ── Unified MCP Support ──

  /**
   * adapter_call — Proxy an IPC call to a named adapter through the hub.
   * The unified MCP server uses this to reach adapter-specific methods
   * (send, receive, contacts, history, etc.) without knowing socket paths.
   */
  server.on("adapter_call", async (req) => {
    const { adapter, method, params } = req.params as {
      adapter: string;
      method: string;
      params?: Record<string, unknown>;
    };
    if (!adapter) return { ok: false, error: "adapter is required" };
    if (!method) return { ok: false, error: "method is required" };

    const desc = registry.get(adapter);
    if (!desc) {
      return { ok: false, error: `Adapter '${adapter}' not registered. Is the ${adapter} daemon running?` };
    }

    try {
      const client = new WatcherClient(desc.socketPath);
      const forwardParams: Record<string, unknown> = { ...(params ?? {}), sessionId: req.sessionId };
      if (req.itermSessionId) forwardParams.itermSessionId = req.itermSessionId;
      const result = await client.call_raw(method, forwardParams);
      return { ok: true, result };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, error: `adapter_call to ${adapter}.${method} failed: ${msg}` };
    }
  });

  /**
   * pailot_send — Send text or voice to PAILot app clients via WS gateway.
   */
  server.on("pailot_send", async (req) => {
    const { text, voice, voiceName, sessionId: callerSessionId, imageBase64, caption, mimeType, image } = req.params as {
      text?: string;
      voice?: boolean;
      voiceName?: string;
      sessionId?: string;
      imageBase64?: string;
      caption?: string;
      mimeType?: string;
      image?: boolean;
    };
    if (!text && !imageBase64) return { ok: false, error: "text or imageBase64 is required" };
    // A tmux caller is authoritatively its durable @aibroker_id (resolved from the
    // pane) — don't trust callerSessionId, which an older MCP derives from the stale
    // ITERM_SESSION_ID. Otherwise: MCP may lack ITERM_SESSION_ID — fall back to the
    // session that last received PAILot input (survives switches during processing).
    const tmuxStable = req.tmuxPane ? (aibrokerIdForPane(req.tmuxPane) ?? req.tmuxPane) : undefined;
    const sessionId = tmuxStable || callerSessionId || lastRoutedSessionId || activeItermSessionId || undefined;
    log(`[pailot_send] callerSession=${callerSessionId?.slice(0, 8) ?? "none"} lastRouted=${lastRoutedSessionId?.slice(0, 8) ?? "none"} activeIterm=${activeItermSessionId?.slice(0, 8) ?? "none"} → resolved=${sessionId?.slice(0, 8) ?? "none"}`);

    try {
      const bridge = getAibpBridge();
      if (imageBase64) {
        const imgBuffer = Buffer.from(imageBase64, "base64");
        if (bridge) {
          bridge.routeToMobile(sessionId ?? "", caption ?? "", "IMAGE", {
            imageBase64,
            mimeType: mimeType ?? "image/png",
          });
        } else {
          broadcastImage(imgBuffer, caption, sessionId);
        }
        return { ok: true, result: { sent: true, type: "image" } };
      }
      if (voice) {
        const { textToVoiceNote } = await import("../adapters/kokoro/tts.js");
        const resolvedVoice = voiceName ?? voiceConfig.defaultVoice;
        const plainText = stripMarkdown(text!);
        const chunks = splitIntoChunks(plainText);
        const groupId = chunks.length > 1 ? randomUUID().slice(0, 12) : undefined;
        for (let i = 0; i < chunks.length; i++) {
          if (i > 0) await new Promise((r) => setTimeout(r, 1500));
          const audioBuffer = await textToVoiceNote(chunks[i], resolvedVoice);
          // Each chunk carries its own text segment as transcript
          const transcript = chunks[i];
          const chunkMeta = groupId ? { groupId, chunkIndex: i, totalChunks: chunks.length } : undefined;
          if (bridge) {
            bridge.routeToMobile(sessionId ?? "", transcript, "VOICE", {
              audioBase64: audioBuffer.toString("base64"),
              ...(chunkMeta && { groupId: chunkMeta.groupId, chunkIndex: chunkMeta.chunkIndex, totalChunks: chunkMeta.totalChunks }),
            });
          } else {
            await broadcastVoice(audioBuffer, transcript, sessionId, undefined, chunkMeta);
          }
        }
        return { ok: true, result: { sent: true, chunks: chunks.length } };
      } else {
        if (bridge) {
          bridge.routeToMobile(sessionId ?? "", text!);
        } else {
          broadcastText(text!, sessionId);
        }
      }
      return { ok: true, result: { sent: true } };
    } catch (e) {
      return { ok: false, error: `pailot_send failed: ${e instanceof Error ? e.message : String(e)}` };
    }
  });

  /**
   * pailot_receive — Drain the PAILot message queue.
   * Currently proxied to whazaa adapter's receive with from='pailot'.
   */
  server.on("pailot_receive", async (req) => {
    const adapterName = registry.get("whazaa") ? "whazaa" : "telex";
    const desc = registry.get(adapterName);
    if (!desc) return { ok: true, result: { messages: [] } };

    try {
      const client = new WatcherClient(desc.socketPath);
      const result = await client.call_raw("receive", {
        from: "pailot",
        sessionId: req.sessionId,
      });
      return { ok: true, result };
    } catch {
      return { ok: true, result: { messages: [] } };
    }
  });

  /**
   * pailot_debug_state — Ask the PAILot app for its current rendered session list.
   * Publishes a debug_state_request over MQTT and awaits the app's response.
   */
  server.on("pailot_debug_state", async (req) => {
    const timeoutMs = ((req as any).timeout ?? 5) * 1000;
    try {
      const response = await mqttRequestDebugState(timeoutMs);
      return { ok: true, result: response };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  });

  /**
   * todoist_reply — Answer on the task a work order came from.
   *
   * The reply lands where the question was asked, so a task filed from a watch
   * can be answered without the human walking to a terminal. The task is left
   * open on purpose: an answer nobody has read is not done, and a completed
   * task drops out of the list taking its comments with it.
   */
  /**
   * todoist_ingress — grant or list the projects allowed to reach a session.
   *
   * Exposed so "make me a project for the Whazaa session and let me talk to it"
   * is one operation rather than a file edit and a daemon restart. Still
   * explicit, still audited: this is the boundary that decides which projects
   * can execute in your sessions.
   */
  server.on("todoist_ingress", async (req) => {
    const { action, projectId, owner, projectName } = req.params as {
      action?: string; projectId?: string; owner?: string; projectName?: string;
    };
    try {
      const { listGrants, grantIngress, revokeIngress, projectForOwner } = await import("./todoist-ingress.js");
      if (!action || action === "list") return { ok: true, result: { grants: listGrants() } };
      if (action === "resolve") {
        if (!owner) return { ok: false, error: "owner is required" };
        const g = projectForOwner(owner);
        return {
          ok: true,
          result: g
            ? { found: true, projectId: g.projectId, projectName: g.projectName ?? null, owner: g.owner ?? null }
            : { found: false, owner },
        };
      }
      if (action === "add") {
        if (!projectId) return { ok: false, error: "projectId is required" };
        const g = grantIngress(projectId, { owner, projectName });
        return { ok: true, result: { granted: true, projectId: g.projectId, owner: g.owner ?? null } };
      }
      if (action === "remove") {
        if (!projectId) return { ok: false, error: "projectId is required" };
        return { ok: true, result: { revoked: revokeIngress(projectId) } };
      }
      return { ok: false, error: `unknown action: ${action}` };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  /**
   * todoist_task — create a task without handing it back to yourself.
   *
   * A session filing into an ingress project is writing to its own inbox. This
   * marks the task so the receiver drops it instead of dispatching it back.
   */
  server.on("todoist_task", async (req) => {
    const { content, projectId, description, dueString } = req.params as {
      content?: string; projectId?: string; description?: string; dueString?: string;
    };
    if (!content?.trim()) return { ok: false, error: "content is required" };
    try {
      const { createTask } = await import("./todoist-reply.js");
      const r = await createTask(content, { projectId, description, dueString });
      return { ok: true, result: { taskId: r.taskId } };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  /**
   * todoist_inbox — which tasks have new comments.
   *
   * The per-reply push answers "did something just happen". This answers the
   * question that actually costs time: across a tree of hundreds of tasks,
   * which ones are waiting for you. Todoist will not answer it — it does not
   * notify an account about its own activity, and the bridge comments as you.
   *
   * `markSeen` is opt-in so building a digest never silently consumes the
   * backlog, and `push` sends it to the phone so it can be asked for from
   * anywhere.
   */
  /**
   * todoist_mirror — run the comment mirror now.
   *
   * The daemon runs it on a timer; this exists so a session can force a pass
   * after replying, and so the result is inspectable rather than only visible
   * as a side effect in Todoist.
   */
  /**
   * outbound_call — a session acting in a system we have no connector for.
   *
   * The session decides; an automation platform's own actions do it. We never
   * hold the vendor credential and never maintain the connector, which is the
   * one thing those platforms are genuinely good at.
   */
  server.on("outbound_call", async (req) => {
    const { target, action, params } = (req.params ?? {}) as {
      target?: string; action?: string; params?: Record<string, unknown>;
    };
    if (!target) return { ok: false, error: "target is required" };
    if (!action) return { ok: false, error: "action is required" };
    try {
      const { callOutbound } = await import("./outbound.js");
      const r = await callOutbound(target, action, params ?? {}, callerLabel(req));
      return r.ok
        ? { ok: true, result: { status: r.status ?? 0, body: r.body ?? "" } }
        : { ok: false, error: r.error ?? `call failed with ${r.status}` };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  server.on("todoist_mirror", async () => {
    try {
      const { syncMirror, mirrorProjectId } = await import("./todoist-mirror.js");
      if (!mirrorProjectId()) {
        return { ok: false, error: "TODOIST_MIRROR_PROJECT is not set in ~/.aibroker/env — mirroring is off" };
      }
      const r = await syncMirror();
      return { ok: true, result: { ...r } };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  server.on("todoist_inbox", async (req) => {
    const { since, markSeen: commit, push, sessionId: inboxCaller } = (req.params ?? {}) as {
      since?: string; markSeen?: boolean; push?: boolean; sessionId?: string;
    };
    try {
      const { buildInbox, formatInbox, markSeen: setSeen } = await import("./todoist-inbox.js");
      const inbox = await buildInbox({ since });
      const text = formatInbox(inbox);

      if (commit && inbox.newest) setSeen(inbox.newest);

      if (push) {
        try {
          // Address the caller's own thread. An empty id falls through to
          // "whichever session last spoke to PAILot", which is how the first
          // digest landed in another session's conversation and read, to the
          // person waiting for it, exactly like nothing had been sent.
          const bridge = getAibpBridge();
          const target = inboxCaller || lastRoutedSessionId || activeItermSessionId || "";
          bridge?.routeToMobile(target, text, "TEXT");
        } catch { /* the digest is still returned to the caller */ }
      }

      return { ok: true, result: { text, entries: inbox.entries, truncated: inbox.truncated, since: inbox.since, newest: inbox.newest } };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  server.on("todoist_reply", async (req) => {
    const { taskId, text, release } = req.params as { taskId?: string; text?: string; release?: boolean };
    if (!taskId) return { ok: false, error: "taskId is required" };
    if (!text?.trim()) return { ok: false, error: "text is required" };
    try {
      const { replyToTask, setTaskLabel } = await import("./todoist-reply.js");
      const r = await replyToTask(taskId, text);

      // A triggered run holds pai-running until someone takes it off. Nothing
      // else here does: the webhook sets it at dispatch and only releases it on
      // a failed dispatch or at the next occurrence, so a session that finishes
      // its work and says nothing leaves the trigger suppressed until then —
      // one missed run, looking exactly like a run nobody asked for.
      let released = false;
      let releaseRefused: string | undefined;
      if (release) {
        const { RUNNING_LABEL } = await import("./todoist-webhook.js");
        const { forgetClaim, mayRelease } = await import("./todoist-claims.js");
        const { fetchTaskDue } = await import("./todoist-reply.js");
        // Check the completion actually landed before dropping the guard.
        const verdict = mayRelease(taskId, await fetchTaskDue(taskId));
        if (verdict.ok) {
          await setTaskLabel(taskId, RUNNING_LABEL, false);
          forgetClaim(taskId);
          released = true;
        } else {
          releaseRefused = verdict.reason;
          log(`todoist-reply: refused to release ${taskId} — ${verdict.reason}`);
        }
      }
      // Push a notice to the phone. A comment posted on a task in a tree of
      // hundreds is invisible until someone opens that exact task — which is
      // the same silence as never answering. The reply is the event worth
      // knowing about, so it is announced rather than left to be found.
      try {
        const bridge = getAibpBridge();
        if (bridge) {
          // Address the replying session's own thread. An empty id falls
          // through to "whichever session last spoke to PAILot", which puts the
          // notice in a conversation the reader is not looking at — delivered,
          // and indistinguishable from never sent.
          const target = (req.params as { sessionId?: string }).sessionId
            || lastRoutedSessionId || activeItermSessionId || "";
          const { fetchTaskBrief } = await import("./todoist-reply.js");
          const brief = await fetchTaskBrief(taskId);
          const first = text.trim().split("\n").find((l) => l.trim()) ?? "";
          const head = brief.title ? `💬 ${brief.title}` : "💬 Reply posted on a task";
          const link = brief.url ? `\n${brief.url}` : "";
          bridge.routeToMobile(target, `${head}\n${first.slice(0, 240)}${link}`, "TEXT");
        }
      } catch { /* a missing notification must not fail the reply itself */ }

      // Mirror this reply directly. We wrote it, so we already know everything
      // the mirror needs — asking Todoist to tell us about our own comment was
      // a round trip to learn what we already knew, and it put a five-minute
      // delay on the one case somebody is actually watching. Failures are
      // queued inside and retried on the next write, so this is not a
      // best-effort downgrade from polling.
      void import("./todoist-mirror.js")
        .then((m) => m.mirrorComment({ taskId, commentId: r.commentId, text }))
        .catch(() => { /* queued inside; nothing useful to do here */ });

      return { ok: true, result: { taskId: r.taskId, commentId: r.commentId, released, releaseRefused } };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  /**
   * rename — Rename session: update registry, tab title, badge, and session variable.
   *
   * Resolves the caller's iTerm2 session from req.itermSessionId (set by IPC client
   * from ITERM_SESSION_ID env var). This works for both MCP callers (Claude Code sessions)
   * and adapter-forwarded renames.
   */
  server.on("rename", async (req) => {
    const { name } = req.params as { name: string };
    if (!name) return { ok: false, error: "name is required" };

    // A caller inside tmux identifies by $TMUX_PANE (correct per pane). Its
    // inherited ITERM_SESSION_ID points at whatever iTerm tab first started the
    // tmux server — a DIFFERENT session — so for tmux callers we MUST ignore it
    // and key the name on the pane's durable @aibroker_id instead. (Renaming the
    // wrong session is exactly the bug this guards against.)
    if (req.tmuxPane) {
      const tmuxPane = req.tmuxPane;
      const durableId = aibrokerIdForPane(tmuxPane) ?? tmuxPane;
      // One name, one live holder: refused here while another live session owns
      // it (2026-09-26 — a second tab took a live session's name, and the parked
      // sweeps two mornings later traced back to exactly that write).
      const claim = setPersistentSessionName(durableId, name);
      if (!claim.ok) {
        return {
          ok: false,
          error: `Name "${name}" is held by live session ${claim.heldBy?.slice(0, 8) ?? "unknown"} — release it there first (close that tab, or rename it).`,
        };
      }
      setSessionTitle(tmuxPane, name);
      manager.updateName(durableId, name);

      // Visible surfaces: if this pane is being viewed in an iTerm tab, set the
      // same iTerm visuals (red-overlay badge + tab title + paiName var) on the
      // host tab. tmux keeps `set-titles off`, so Claude's own title escape stays
      // trapped in pane_title and does NOT overwrite the iTerm tab title — so
      // unlike the tmux pane title, these stick.
      const viewerId = itermViewerSessionId(tmuxPane);
      if (viewerId) {
        setItermSessionVar(viewerId, name);
        setItermTabName(viewerId, name);
        setItermBadge(viewerId, name);
      }
      log(`Persisted name "${name}" for tmux pane ${tmuxPane} (key ${durableId.slice(0, 8)}, ${viewerId ? `iterm viewer ${viewerId.slice(0, 8)}` : "detached"})`);

      // The /resume picker title is written into the transcript by the
      // PreToolUse hook hooks/aibroker-rename-title.mjs (matcher
      // mcp__aibroker__aibroker_rename) — typing /rename here raced the
      // operator's keyboard.

      // Refresh PAILot's session list (the daemon rename otherwise only reaches
      // whazaa/telex, never the in-process PAILot gateway).
      handleMqttCommand("sessions");
      for (const adapter of registry.list()) {
        try {
          const client = new WatcherClient(adapter.socketPath);
          await client.call_raw("rename", { name, sessionId: req.sessionId });
        } catch { /* best effort */ }
      }
      return { ok: true, result: { success: true, name } };
    }

    // Resolve caller's iTerm2 session UUID from "w0t0p0:UUID" format, taking it
    // from whichever field carried it — the same reason as callerItermId.
    const claimedId = callerItermId(req);

    /*
     * Believe the claim only if the session it names exists.
     *
     * `ITERM_SESSION_ID` is inherited like any environment variable, so a
     * process can go on announcing the id of a pane that is gone. Naming then
     * succeeds against nothing: the store gains an entry no enumeration will
     * ever match, the real pane stays anonymous, and the operator repeats the
     * rename and watches it not take. The tty is the corrective — it describes
     * where the process is attached NOW, and iTerm reports it per session, so
     * a stale claim can be traded for the pane the caller is really in.
     */
    const live = snapshotAllSessions();
    rememberIdSession(claimedId ?? "", req.claudeSessionId);
    // A background session's pty is not an iTerm tty, so the uuid → attach pane
    // lookup comes first; the tty is the fallback for everything else.
    const viaAttach = claimedId && !live.some((s) => s.id === claimedId) ? resolveCallerPane(req, live)?.id : undefined;
    const itermSessionId = viaAttach ?? resolveCallerSession(claimedId, req.callerTty, live);

    if (claimedId && itermSessionId && itermSessionId !== claimedId) {
      log(
        `rename: caller claimed session ${claimedId.slice(0, 8)}, which is not open; ` +
          (viaAttach
            ? `using ${itermSessionId.slice(0, 8)} found via claude attach ${req.claudeSessionId?.slice(0, 8)}`
            : `using ${itermSessionId.slice(0, 8)} found via tty ${req.callerTty}`),
      );
    }

    // One name, one live holder. The claim is checked BEFORE any surface is
    // written: on 2026-09-26 21:07 a second tab registered a name a live session
    // had held for days, the store then answered the name with both ids, and a
    // daemon restart bound dispatch to the newcomer — which was at a shell by
    // morning, so both daily sweeps parked without the real session ever being
    // asked. Refused here, the existing holder keeps the name untouched.
    let nameClaim: { ok: boolean; heldBy?: string } = { ok: true };
    if (itermSessionId) {
      nameClaim = setPersistentSessionName(itermSessionId, name);
      if (!nameClaim.ok) {
        log(`rename: refused — name "${name}" held by live session ${nameClaim.heldBy?.slice(0, 8)}`);
        return {
          ok: false,
          error: `Name "${name}" is held by live session ${nameClaim.heldBy?.slice(0, 8) ?? "unknown"} — release it there first (close that tab, or rename it).`,
        };
      }
      const renamedCwd = live.find((x) => x.id === itermSessionId)?.cwd;
      setSessionProject(itermSessionId, renamedCwd);
      log(`Persisted name "${name}" for iTerm session ${itermSessionId.slice(0, 8)}${renamedCwd ? ` (cwd project ${displayName(name, renamedCwd)})` : ""}`);
    }

    // Update in hub's session manager
    if (itermSessionId) {
      // updateName searches by backendSessionId (iTerm2 UUID)
      manager.updateName(itermSessionId, name);
    } else {
      const session = manager.activeSession;
      if (session) manager.updateName(session.id, name);
    }

    // Set iTerm2 visuals directly if we know the session
    if (itermSessionId) {
      setItermSessionVar(itermSessionId, name);
      setItermTabName(itermSessionId, name);
      setItermBadge(itermSessionId, name);
      // The /resume picker title is written into the transcript by the
      // PreToolUse hook hooks/aibroker-rename-title.mjs (matcher
      // mcp__aibroker__aibroker_rename) — typing /rename here raced the
      // operator's keyboard.
    }

    // Refresh PAILot's session list (in-process gateway is not a registry adapter).
    handleMqttCommand("sessions");
    // Forward to all adapters (best effort — Whazaa/Telex session list sync)
    for (const adapter of registry.list()) {
      try {
        const client = new WatcherClient(adapter.socketPath);
        await client.call_raw("rename", { name, sessionId: req.sessionId });
      } catch { /* best effort */ }
    }
    return { ok: true, result: { success: true, name } };
  });

  /**
   * get_persistent_name — Retrieve the user-chosen persistent name for an iTerm2 session.
   *
   * Params: { itermSessionId: string }
   * Result: { name: string | null }
   */
  server.on("get_persistent_name", async (req) => {
    const { itermSessionId } = req.params as { itermSessionId?: string };
    const rawId = itermSessionId ?? req.itermSessionId;
    if (!rawId) return { ok: false, error: "itermSessionId is required" };
    // Normalise "w0t0p0:UUID" → UUID
    const id = rawId.includes(":") ? rawId.split(":").pop()! : rawId;
    const name = getPersistentSessionName(id) ?? null;
    return { ok: true, result: { name } };
  });

  /**
   * get_all_persistent_names — Return all persisted iTerm2 session → name mappings.
   *
   * Used by PAI hooks to re-assert tab titles after Claude Code auto-titles overwrite them.
   * Result: { names: Record<string, string> }
   */
  server.on("get_all_persistent_names", async (_req) => {
    const names = getAllPersistentSessionNames();
    return { ok: true, result: { names } };
  });

  /**
   * clear_session_names — Wipe the persistent session-names store.
   *
   * Removes all entries from ~/.aibroker/session-names.json. Does NOT
   * touch the iTerm2 user.paiName variables — call clear_pai_names for that.
   * Optional param: { sessionId: string } to remove a single entry.
   */
  server.on("clear_session_names", async (req) => {
    const { itermSessionId } = req.params as { itermSessionId?: string };
    const names = getAllPersistentSessionNames();
    if (itermSessionId) {
      const id = itermSessionId.includes(":") ? itermSessionId.split(":").pop()! : itermSessionId;
      removePersistentSessionName(id);
      log(`Cleared persistent name for iTerm session ${id.slice(0, 8)}`);
      return { ok: true, result: { cleared: 1 } };
    }
    // Clear all
    for (const id of Object.keys(names)) {
      removePersistentSessionName(id);
    }
    log(`Cleared all ${Object.keys(names).length} persistent session name(s)`);
    return { ok: true, result: { cleared: Object.keys(names).length } };
  });

  /**
   * clear_pai_names — Clear user.paiName variable from all live iTerm2 sessions.
   *
   * Recovery tool for corrupted state. Returns the number of sessions cleared.
   */
  server.on("clear_pai_names", async (_req) => {
    const cleared = clearAllPaiNames();
    log(`Cleared user.paiName from ${cleared} iTerm session(s)`);
    return { ok: true, result: { cleared } };
  });

  /**
   * discover — Proxy to first available adapter for iTerm2 session scan.
   */
  server.on("discover", async (req) => {
    const adapters = registry.list();
    if (adapters.length === 0) return { ok: false, error: "No adapters registered" };
    try {
      const client = new WatcherClient(adapters[0].socketPath);
      const result = await client.call_raw("discover", { sessionId: req.sessionId });
      return { ok: true, result };
    } catch (e) {
      return { ok: false, error: `discover failed: ${e instanceof Error ? e.message : String(e)}` };
    }
  });

  /**
   * command — Execute a slash command through the hub command handler.
   */
  server.on("command", async (req) => {
    const { text } = req.params as { text: string };
    if (!text) return { ok: false, error: "text is required" };

    // Try the hub's command handler first
    const adapters = registry.list();
    if (adapters.length > 0) {
      try {
        const client = new WatcherClient(adapters[0].socketPath);
        const result = await client.call_raw("command", { text, sessionId: req.sessionId });
        return { ok: true, result };
      } catch { /* fall through */ }
    }
    return { ok: true, result: { executed: true, command: text } };
  });

  // ── Phase 2: Message Routing ──

  /**
   * route_message — Adapters send messages to the hub for routing.
   *
   * The hub inspects the BrokerMessage target and type, then delivers
   * to the appropriate adapter via its IPC socket ("deliver" method).
   */
  server.on("route_message", async (req) => {
    const { message } = req.params as { message: BrokerMessage };
    if (!message || !message.source || !message.type) {
      return { ok: false, error: "Invalid BrokerMessage: source and type are required" };
    }
    const result = await registry.route(message);
    if (result.ok) {
      return { ok: true, result: result as unknown as Record<string, unknown> };
    }
    return { ok: false, error: result.error ?? "Routing failed" };
  });

  // APNs device token registration (from MCP or direct IPC callers)
  server.on("apns_register_token", async (req) => {
    const { token } = req.params as { token?: string };
    if (!token || typeof token !== "string") {
      return { ok: false, error: "token is required" };
    }
    apnsRegisterToken(token);
    return { ok: true, result: { tokens: apnsGetTokens().length } };
  });

  // trace_log — return the last 100 message delivery trace entries
  server.on("trace_log", async (_req) => {
    const { getTraces } = await import("./trace-log.js");
    const traces = getTraces();
    return { ok: true, result: { traces, count: traces.length } };
  });

  /**
   * manage — start, steer or stop the manager for one session.
   *
   * Reached from a session by `/manage …`, which a prompt hook turns into this
   * call before the model ever sees it. That path matters: the point of the
   * whole arrangement is that instructing the manager never has to wait for
   * anything to be idle, so this must not depend on a session's turn.
   */
  server.on("manage", async (req) => {
    const { session, arg, goal, until, every, operator } = req.params as {
      session?: string; arg?: string; goal?: string; until?: string; every?: string | number; operator?: boolean;
    };
    const { handleManage, resolveManageTarget, refuseAgentManage } = await import("./manage.js");
    // "self" or omitted = the caller's own session, by its iTerm id — or, when
    // the caller could name itself no other way, PAI's session map (callerSelfId).
    const target = resolveManageTarget(session, await callerSelfId(req));
    if (!target) return { ok: false, error: "cannot tell which session is asking — name it" };
    const refusal = refuseAgentManage(target, arg ?? "", { until }, operator === true);
    if (refusal) return { ok: false, error: refusal };
    const r = await handleManage(target, arg ?? "", { goal, until, every });
    return r.ok
      ? { ok: true, result: { message: r.message, managed: r.managed ?? false } }
      : { ok: false, error: r.message };
  });

  /**
   * Comment on an issue in a repository this session RECEIVES FROM.
   *
   * The subscription is the permission. A session may write where it already
   * reads, and nowhere else — so the boundary cannot widen by accident, because
   * widening it means creating a route, which is itself an act the session can
   * only perform for itself and which lands in the audit trail.
   *
   * Deliberately NOT the whole lifecycle. A sibling project's tool restricts
   * closing to issues the session itself opened, on the grounds that receiving
   * events about a tracker is not the same as owning what is in it. That
   * distinction is right and it is the operator's to draw, so this does the one
   * verb that was actually asked for and leaves custody alone.
   */
  server.on("issue", async (req) => {
    const { repo, verb, issue, comment, body, title, label, state, count, keepClosed } = req.params as {
      repo?: string; verb?: string; issue?: number; comment?: number;
      body?: string; title?: string; label?: string; state?: string; count?: number; keepClosed?: boolean;
    };
    const ref = parseRepoUrl(repo ?? "");
    if (!ref) return { ok: false, error: "repo must be a repository URL" };
    const known = [...READ_VERBS, ...WRITE_VERBS] as string[];
    if (!verb || !known.includes(verb)) {
      return { ok: false, error: `verb must be one of: ${known.join(", ")}` };
    }

    const id = callerItermId(req);
    const snap = id ? snapshotAllSessions().find((s) => s.id === id) : undefined;
    const owner = snap
      ? lookupPersistentName(getAllPersistentSessionNames(), snap.id, snap.aibrokerId)
      : undefined;
    if (!owner) return { ok: false, error: "cannot tell which session is asking" };

    // The permission check, and the whole of it: is there a route for this
    // repository, and does it deliver HERE? Matching on the derived route name
    // means the same repository always resolves to the same route, so this
    // cannot be fooled by a differently-spelled URL for the same place.
    const route = findRoute(routeNameFor(ref));
    if (!route) {
      return {
        ok: false,
        error: `not subscribed to ${ref.owner}/${ref.repo} — subscribe first, and you may write only where you receive`,
      };
    }
    if (route.owner !== owner) {
      return {
        ok: false,
        error: `${ref.owner}/${ref.repo} delivers to "${route.owner}", not to you — a session writes only to trackers it receives from`,
      };
    }

    const cred = issueWriteCredential(process.env, ref);
    const r = await issueOp(verb as IssueVerb, { issue, comment, body, title, label, state, count, keepClosed }, {
      ref,
      token: cred.credential,
      botLogin: cred.login,
      authorLabel: owner,
    });
    // Reads are traffic; writes are acts. Only the acts go in the trail, so it
    // stays readable as a record of what was changed and by whom.
    if ((WRITE_VERBS as string[]).includes(verb)) {
      audit({
        action: `issue:${verb}`, actor: `session:${owner}`,
        target: `${ref.owner}/${ref.repo}${(issue ?? r.issue) ? `#${issue ?? r.issue}` : ""}`,
        outcome: r.ok ? "ok" : "refused", reason: r.error ?? r.warning,
      });
      // The forge will report this back within a second or two — down every
      // hook it has for this repository, not only the one this permission check
      // resolved. Remember the REPOSITORY, so the session is not handed its own
      // footprint by a second route that names the same place.
      if (r.ok) {
        // r.issue covers the verbs the caller does not name an issue for —
        // amend is given a comment id, and an edit echoes back just as a new
        // comment does.
        const touched = issue ?? r.issue ?? (r.data as { number?: number } | undefined)?.number;
        // A bot account is dropped by name at the route, so the window is kept
        // for the shared-credential case only and the operator's comment made
        // just after a write is not swallowed with it.
        const botLogin = cred.bot && cred.credential
          ? await whoAmI({ ref, token: cred.credential, fetchImpl: fetch, botLogin: cred.login })
          : undefined;
        if (touched && !routeIgnoresAccount(route, botLogin)) noteOwnWrite(`${ref.owner}/${ref.repo}`, touched);
      }
    }
    return r.ok
      ? { ok: true, result: { url: r.url, data: r.data, warning: r.warning } }
      : { ok: false, error: r.error ?? `${verb} failed` };
  });

  /**
   * Bind a repository's issues to the CALLING session's mailbox.
   *
   * Creating the route and registering the webhook were two manual steps with a
   * secret carried between them by hand. This does both, and the secret stays
   * in the daemon unless the forge could not be reached.
   *
   * **There is deliberately no target parameter.** The owner is the caller's own
   * resolved session, so a session can subscribe itself and nothing else. That
   * keeps the property docs/inbound.md rests on — a caller cannot choose which
   * session runs with the operator's rights — while removing the friction that
   * had every subscription going through the operator's terminal.
   */
  server.on("subscribe_issues", async (req) => {
    const { repo } = req.params as { repo?: string };
    const ref = parseRepoUrl(repo ?? "");
    if (!ref) {
      return { ok: false, error: "repo must be a repository URL, e.g. https://forge.example/owner/name" };
    }

    // The caller, and only the caller. Resolved from the request rather than
    // read from params — see callerItermId.
    //
    // Resolved through the PERSISTENT name, the same way callerLabel does, and
    // never from the snapshot's `name`. That field is the iTerm tab title:
    // decorated with a status glyph that CHANGES as the session works, and
    // suffixed "(node)". The first route this created was stored as
    // "◑ 20 - Webseiten (node)" — an owner containing a character that is
    // different a second later. A route outlives the moment it was made, so its
    // owner has to be the name that outlives it too. Refuse rather than store a
    // decorated title: a route pointing at a spinner is worse than an error,
    // because it looks correct in the listing.
    const id = callerItermId(req);
    const snap = id ? snapshotAllSessions().find((s) => s.id === id) : undefined;
    const owner = snap
      ? lookupPersistentName(getAllPersistentSessionNames(), snap.id, snap.aibrokerId)
      : undefined;
    if (!owner) {
      return {
        ok: false,
        error: "cannot tell which session is asking by a stable name — name this session first (aibroker_rename), then subscribe",
      };
    }

    const host = process.env.AIBROKER_PUBLIC_HOST ?? funnelHostname().hostname;
    if (!host) {
      return { ok: false, error: "no public host: set AIBROKER_PUBLIC_HOST or bring the funnel up" };
    }

    // Which account this machine posts as, asked of the forge itself. Falls
    // back to the configured name only when the forge will not answer. Reported
    // back rather than turned into a filter — see below.
    const cred = issueWriteCredential(process.env, ref);
    const postsAs = await whoAmI({
      ref,
      token: cred.credential ?? "",
      fetchImpl: fetch,
      botLogin: cred.login,
    });

    const name = routeNameFor(ref);
    const route = addRoute(name, {
      owner,
      mode: "message",
      fields: ISSUE_FIELDS,
      // One action by a person is several events on the forge: opening an issue
      // with an assignee fires `opened` AND `assigned`, and both arrive within a
      // second of each other. Grouping by issue number turns that back into the
      // one thing that actually happened. 25 seconds is the window the first
      // hand-built route settled on and it has held since 2026-08-18 — copied
      // deliberately rather than re-derived, because the number came from
      // watching real traffic and I have none yet.
      coalesce: { ms: 25_000, key: "issue.number" },
      // The one exception to the above: a dedicated bot account is nobody the
      // route exists to hear, so its events are dropped by name. The operator's
      // comments still arrive.
      ...(cred.bot && postsAs ? { ignore: [botIgnoreRule(postsAs)] } : {}),
      // No account is filtered here, and that is the correction rather than an
      // omission. This used to add `sender.login=<the token's account>` so a
      // session would not be woken by its own footprints. Where the credential
      // is the operator's own — the normal case here, and what the forge
      // answered on 2026-09-02 — that rule silences the OPERATOR's comments,
      // which are the entire reason the route exists. Measured at 08:37:37: two
      // comments by the operator dropped as `sender.login=<operator>`.
      //
      // What stops the loop is the write record in inbound.ts, which asks "did
      // we just do this" instead of "who signed this" and so cannot be defeated
      // by a shared credential. The one case it does not cover is a repo-local
      // script posting with its OWN bot account, which never reaches the daemon
      // to be recorded — that wants an `ignore` naming the bot, added
      // deliberately by the operator who set that script up, because only they
      // can tell a bot account from their own.
      note: `issues and comments from ${ref.owner}/${ref.repo}`,
      repo: `${ref.owner}/${ref.repo}`,
    });
    const hookUrl = `https://${host}/hook/${route.name}`;

    const token = cred.credential;
    const outcome = await registerHook(ref, hookUrl, route.secret, token);

    // Asked after registering, so the answer is what the forge holds now. A
    // second hook for this repository pointing at this machine delivers every
    // event twice, and the copy arriving down the older route is the one that
    // used to come back as news — worth saying at the moment somebody is
    // looking, rather than leaving to be found in the traffic.
    const duplicates = await duplicateHooks(ref, hookUrl, token);
    if (duplicates.length) {
      log(`inbound: ${ref.owner}/${ref.repo} also posts to ${duplicates.join(", ")} — every event arrives twice until one is removed`);
    }

    return {
      ok: true,
      result: {
        route: route.name,
        owner,
        url: hookUrl,
        forge: forgeOf(ref),
        registered: outcome.registered,
        reason: outcome.reason,
        // Which account writes from here will be signed with. Not a filter:
        // stated so it can be recognised in the tracker, and so a credential
        // that turns out to be somebody else's is visible at once.
        postsAs,
        // Named, not counted — the operator has to go and remove one.
        duplicateHooks: duplicates.length ? duplicates : undefined,
        warning: duplicates.length
          ? `${ref.owner}/${ref.repo} also posts to ${duplicates.join(", ")}: every event will arrive twice until one of those hooks is removed`
          : undefined,
        // Handed back ONLY when the operator has to paste it themselves. When
        // the forge took it, the secret has no reason to leave the daemon.
        secret: outcome.registered ? undefined : route.secret,
      },
    };
  });

  /**
   * whatsapp_subscribe / whatsapp_unsubscribe / whatsapp_subscriptions — which
   * WhatsApp groups reach which session. Same shape as subscribe_issues: the
   * owner is the caller's own persistent name, there is no target parameter.
   * Messages from a subscribed group arrive as external, mailbox-only mail
   * (whatsapp-external.ts); an unsubscribed group is ignored.
   */
  const callerOwner = (req: IpcRequest): string | undefined => {
    const id = callerItermId(req);
    const snap = id ? snapshotAllSessions().find((s) => s.id === id) : undefined;
    return snap ? (lookupPersistentName(getAllPersistentSessionNames(), snap.id, snap.aibrokerId) ?? undefined) : undefined;
  };
  const NO_OWNER = "cannot tell which session is asking by a stable name — name this session first (aibroker_rename), then subscribe";

  server.on("whatsapp_subscribe", async (req) => {
    const { groupId, groupName, mode } = req.params as { groupId?: string; groupName?: string; mode?: string };
    if (mode !== undefined && mode !== "deliver" && mode !== "transcribe") return { ok: false, error: 'mode must be "deliver" or "transcribe"' };
    const m = mode ?? "deliver";
    if (!groupId || (m === "deliver" && !isGroupJid(groupId))) return { ok: false, error: "groupId must be a WhatsApp group JID ending in @g.us" };
    const owner = callerOwner(req);
    if (!owner && m === "deliver") return { ok: false, error: NO_OWNER };
    const sub = subscribeGroup(groupId, owner, groupName, m);
    log(`whatsapp: ${owner ?? "(no session)"} subscribed to ${groupName ?? groupId} mode=${m}`);
    return { ok: true, result: { ...sub, owner, mode: m } };
  });

  server.on("whatsapp_unsubscribe", async (req) => {
    const { group, mode } = req.params as { group?: string; mode?: string };
    const m = mode === "transcribe" ? "transcribe" : "deliver";
    const owner = callerOwner(req);
    if (!owner && m === "deliver") return { ok: false, error: NO_OWNER };
    const changed = unsubscribeGroup(group ?? "", owner, m);
    if (changed) log(`whatsapp: ${owner} unsubscribed from group ${group}`);
    return { ok: true, result: { changed } };
  });

  server.on("whatsapp_subscriptions", async () => ({ ok: true, result: { groups: listSubscriptions() } }));

  /**
   * whatsapp_inbound — the WhatsApp adapter asks, for EVERY inbound message,
   * what it is before routing it. `operator` means type it as `[Whazaa]` as
   * before; anything else is never typed, and external group mail has already
   * been deposited when this returns.
   */
  server.on("whatsapp_inbound", async (req) => {
    const p = req.params as Partial<InboundWhatsApp> & { designatedChats?: string[] };
    if (typeof p.chatJid !== "string" || typeof p.text !== "string") return { ok: false, error: "chatJid and text are required" };
    const msg: InboundWhatsApp = {
      chatJid: p.chatJid, fromMe: p.fromMe === true, senderJid: p.senderJid,
      senderName: p.senderName, groupName: p.groupName, text: p.text,
      live: p.live === true, timestamp: typeof p.timestamp === "number" ? p.timestamp : undefined,
      audio: p.audio === true || (p.audio != null && typeof p.audio === "object"),
    };
    const r = await routeInbound(msg, p.designatedChats ?? [], { deliver: deliverExternalToOwner });
    const t = decideTranscribe(msg);
    if (t.reason !== "chat has no transcribe subscription") log(`whatsapp: transcribe=${t.transcribe} for ${msg.chatJid} from ${t.speaker}: ${t.reason}`);
    return { ok: true, result: { ...r, transcribe: t.transcribe, speaker: t.speaker } };
  });

  /**
   * Reply to an A2A task addressed to THIS session. Same identity path as
   * subscribe_issues above: resolved from the caller's persistent name,
   * never from a parameter — a `session` field here would let any caller
   * answer any task, which is exactly the boundary inbound routes and forge
   * subscriptions both hold.
   */
  server.on("a2a_reply", async (req) => {
    const { taskId, text } = req.params as { taskId?: string; text?: string };
    if (!taskId || !text) return { ok: false, error: "taskId and text are required" };

    const { getTask } = await import("../a2a/tasks.js");
    const task = getTask(taskId);
    if (!task) return { ok: false, error: `no such task: ${taskId}` };

    const id = callerItermId(req);
    const snap = id ? snapshotAllSessions().find((s) => s.id === id) : undefined;
    const caller = snap
      ? lookupPersistentName(getAllPersistentSessionNames(), snap.id, snap.aibrokerId)
      : undefined;
    if (!caller || caller.toLowerCase() !== task.session.toLowerCase()) {
      audit({
        action: "a2a-reply", actor: caller ? `session:${caller}` : "unknown-session",
        target: `a2a:${taskId}`, outcome: "refused",
        reason: `task is addressed to "${task.session}"`,
      });
      return { ok: false, error: `task ${taskId} is not addressed to this session` };
    }

    const { applyA2AReply } = await import("../a2a/server.js");
    const result = applyA2AReply(taskId, text);
    if (!result) return { ok: false, error: `no such task: ${taskId}` };
    audit({
      action: "a2a-reply", actor: `session:${caller}`, target: `a2a:${taskId}`,
      outcome: result.task.state, body: text, meta: { agentishOk: result.ag2?.ok },
    });
    return { ok: true, result: { state: result.task.state, agentishOk: result.ag2?.ok } };
  });
}
