/**
 * adapters/pailot/mqtt-broker.ts — Embedded MQTT broker for PAILot app connections.
 *
 * Runs an aedes MQTT broker in-process alongside the existing WebSocket gateway.
 * Phase 1: dual-publish — the hub publishes to both WS and MQTT. The MQTT broker
 * also handles inbound messages from app clients and routes them to the hub
 * command handler (same path as WebSocket).
 *
 * See Notes/SPEC-mqtt-pailot.md for the full protocol specification.
 */

import { createServer as createTlsServer } from "node:tls";
import { type Server } from "node:net";
import { randomUUID } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { log } from "../../core/log.js";
import { enqueue } from "./message-queue.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const require = createRequire(import.meta.url);

// aedes is an ESM package — use dynamic import with named export
let AedesFactory: any;
let aedesLoaded = false;

async function loadAedes(): Promise<boolean> {
  if (aedesLoaded) return !!AedesFactory;
  aedesLoaded = true;
  try {
    const mod: any = await import("aedes");
    AedesFactory = mod.Aedes;
    if (!AedesFactory?.createBroker) {
      log("[MQTT] aedes.Aedes.createBroker not found — wrong version?");
      return false;
    }
    return true;
  } catch (err) {
    log(`[MQTT] failed to load aedes: ${err instanceof Error ? err.message : err}`);
    return false;
  }
}

// --- TLS certificate management ---

const TLS_DIR = join(process.env.HOME ?? "/tmp", ".aibroker", "tls");
const TLS_CERT = join(TLS_DIR, "cert.pem");
const TLS_KEY = join(TLS_DIR, "key.pem");

/**
 * Ensure a self-signed TLS certificate exists at ~/.aibroker/tls/.
 * Generates one using openssl if missing. Returns { key, cert } buffers.
 */
function ensureTlsCert(): { key: Buffer; cert: Buffer } | null {
  try {
    if (!existsSync(TLS_CERT) || !existsSync(TLS_KEY)) {
      log("[MQTT] TLS: generating self-signed certificate...");
      mkdirSync(TLS_DIR, { recursive: true });

      // Generate a 2048-bit RSA key and a self-signed cert valid for 10 years
      execFileSync("openssl", [
        "req",
        "-x509",
        "-newkey", "rsa:2048",
        "-keyout", TLS_KEY,
        "-out", TLS_CERT,
        "-days", "3650",
        "-nodes",
        "-subj", "/CN=aibroker.local/O=AIBroker/C=CH",
        "-addext", "subjectAltName=DNS:aibroker.local,DNS:localhost,IP:127.0.0.1",
      ], { stdio: "pipe" });

      log(`[MQTT] TLS: certificate generated at ${TLS_DIR}`);
    } else {
      log("[MQTT] TLS: using existing certificate");
    }

    return {
      key: readFileSync(TLS_KEY),
      cert: readFileSync(TLS_CERT),
    };
  } catch (err) {
    log(`[MQTT] TLS: certificate setup failed: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

// --- State ---

let broker: any = null;
let mqttServer: Server | null = null;
let bonjourInstance: any = null;
let bonjourService: any = null;

/** Number of currently connected MQTT clients. */
let mqttClientCount = 0;

/** Returns the number of currently connected MQTT clients. */
export function getMqttClientCount(): number {
  return mqttClientCount;
}

/** Dedup set for inbound messages from app clients. */
const seenInboundIds = new Set<string>();
const SEEN_MAX = 500;

function evictOldIds(): void {
  if (seenInboundIds.size > SEEN_MAX) {
    // Remove oldest entries (Set iteration order = insertion order)
    const toRemove = seenInboundIds.size - SEEN_MAX;
    let removed = 0;
    for (const id of seenInboundIds) {
      if (removed >= toRemove) break;
      seenInboundIds.delete(id);
      removed++;
    }
  }
}

// --- MQTT publish helpers ---

function mqttPublish(topic: string, payload: Record<string, unknown>, opts?: { qos?: number; retain?: boolean }): void {
  if (!broker) { log(`[MQTT] publish skipped (no broker): ${topic}`); return; }
  log(`[MQTT] → ${topic} (${JSON.stringify(payload).length} bytes)`);
  const qos = opts?.qos ?? 1;
  const retain = opts?.retain ?? false;
  const buf = Buffer.from(JSON.stringify(payload));
  broker.publish(
    { topic, payload: buf, qos, retain, cmd: "publish" },
    (err: Error | null) => {
      if (err) log(`[MQTT] publish error on ${topic}: ${err.message}`);
    },
  );
}

/** Publish a text message to a session output topic. */
export function mqttPublishText(sessionId: string, content: string, messageId?: string): void {
  const msgId = messageId ?? randomUUID();
  const payload: Record<string, unknown> = {
    msgId,
    type: "text",
    sessionId,
    content,
    ts: Date.now(),
  };
  const seq = enqueue(sessionId, "text", payload);
  if (seq > 0) payload.seq = seq;
  mqttPublish(`pailot/${sessionId}/out`, payload);
}

/** Publish a voice message to a session output topic. */
export function mqttPublishVoice(
  sessionId: string,
  audioBase64: string,
  transcript: string,
  messageId?: string,
  chunkMeta?: { groupId: string; chunkIndex: number; totalChunks: number },
): void {
  const msgId = messageId ?? randomUUID();
  const payload: Record<string, unknown> = {
    msgId,
    type: "voice",
    sessionId,
    audioBase64,
    transcript,
    ts: Date.now(),
  };
  if (chunkMeta) {
    payload.groupId = chunkMeta.groupId;
    payload.chunkIndex = chunkMeta.chunkIndex;
    payload.totalChunks = chunkMeta.totalChunks;
  }
  const seq = enqueue(sessionId, "voice", payload);
  if (seq > 0) payload.seq = seq;
  mqttPublish(`pailot/${sessionId}/out`, payload);
}

/** Publish an image message to a session output topic. */
export function mqttPublishImage(sessionId: string, imageBase64: string, caption?: string, messageId?: string): void {
  const msgId = messageId ?? randomUUID();
  const payload: Record<string, unknown> = {
    msgId,
    type: "image",
    sessionId,
    imageBase64,
    mimeType: "image/png",
    caption: caption ?? "",
    ts: Date.now(),
  };
  const seq = enqueue(sessionId, "image", payload);
  if (seq > 0) payload.seq = seq;
  mqttPublish(`pailot/${sessionId}/out`, payload);
}

/** Publish a typing indicator (QoS 0, no msgId — ephemeral). */
export function mqttPublishTyping(sessionId: string, active: boolean): void {
  mqttPublish(`pailot/${sessionId}/typing`, {
    type: "typing",
    sessionId,
    active,
    ts: Date.now(),
  }, { qos: 0 });
}

/** Publish the session list (retained). */
export function mqttPublishSessions(sessions: unknown[]): void {
  mqttPublish("pailot/sessions", {
    msgId: randomUUID(),
    type: "sessions",
    sessions,
    ts: Date.now(),
  }, { retain: true });
}

/** Publish a screenshot for a session (retained). */
export function mqttPublishScreenshot(sessionId: string, imageBase64: string): void {
  mqttPublish(`pailot/${sessionId}/screenshot`, {
    msgId: randomUUID(),
    type: "screenshot",
    sessionId,
    imageBase64,
    mimeType: "image/png",
    ts: Date.now(),
  }, { retain: true });
}

/** Publish a voice transcript reflection. */
export function mqttPublishTranscript(messageId: string, content: string, sessionId?: string): void {
  mqttPublish("pailot/voice/transcript", {
    msgId: randomUUID(),
    type: "transcript",
    messageId,
    ...(sessionId && { sessionId }),
    content,
    ts: Date.now(),
  });
}

/** Publish daemon status (retained). */
export function mqttPublishStatus(status: string, version?: string): void {
  mqttPublish("pailot/status", {
    msgId: randomUUID(),
    type: "status",
    status,
    ...(version && { version }),
    ts: Date.now(),
  }, { retain: true });
}

/** Publish a control response (command results, unread, errors). */
export function mqttPublishControl(payload: Record<string, unknown>): void {
  mqttPublish("pailot/control/out", {
    msgId: randomUUID(),
    ...payload,
    ts: Date.now(),
  });
}

// --- Broker lifecycle ---

export type MqttInboundHandler = (
  sessionId: string | undefined,
  type: string,
  payload: Record<string, unknown>,
) => void;

let inboundHandler: MqttInboundHandler | null = null;

/**
 * Set the handler for inbound MQTT messages from app clients.
 * Called for messages on pailot/+/in and pailot/control/in.
 */
export function setMqttInboundHandler(handler: MqttInboundHandler): void {
  inboundHandler = handler;
}

/**
 * Start the embedded aedes MQTT broker.
 * @param version — daemon version string for status messages
 */
export async function startMqttBroker(version?: string): Promise<void> {
  if (!await loadAedes() || !AedesFactory) {
    log("[MQTT] aedes not available — MQTT broker disabled");
    return;
  }

  const MQTT_PORT = parseInt(process.env.MQTT_PORT ?? process.env.PAILOT_PORT ?? "8765", 10);
  const MQTT_TOKEN = process.env.MQTT_TOKEN;

  // Build aedes options
  const aedesOpts: Record<string, unknown> = {
    // Allow large payloads (files, images) — 50MB max
    maxPayload: 50 * 1024 * 1024,
  };

  // Authentication: only enforce if MQTT_TOKEN is set
  if (MQTT_TOKEN) {
    aedesOpts.authenticate = (
      _client: any,
      username: string | undefined,
      password: Buffer | undefined,
      callback: (error: Error | null, authenticated: boolean) => void,
    ) => {
      const valid = username === "pailot" && password?.toString() === MQTT_TOKEN;
      if (!valid) {
        log(`[MQTT] auth failed for user="${username ?? "(none)"}"`);
      }
      callback(null, valid);
    };
  }

  // Authorization: only allow pailot/ topics
  aedesOpts.authorizePublish = (
    _client: any,
    packet: any,
    callback: (error: Error | null) => void,
  ) => {
    // Allow pailot/ topics and the device token registration topic
    if (packet.topic.startsWith("pailot/")) {
      callback(null);
    } else {
      callback(new Error("Unauthorized topic"));
    }
  };

  aedesOpts.authorizeSubscribe = (
    _client: any,
    sub: any,
    callback: (error: Error | null, sub: any) => void,
  ) => {
    if (sub.topic.startsWith("pailot/")) {
      callback(null, sub);
    } else {
      callback(new Error("Unauthorized topic"), sub);
    }
  };

  broker = await AedesFactory.createBroker(aedesOpts);

  // --- Handle inbound messages from app clients ---
  broker.on("publish", (packet: any, client: any) => {
    // Ignore messages published by the broker itself (no client = server-side publish)
    if (!client) return;

    const topic = packet.topic as string;

    // Match pailot/{sessionId}/in — inbound text/voice/image from app
    const sessionInMatch = topic.match(/^pailot\/([^/]+)\/in$/);
    if (sessionInMatch) {
      try {
        // Strip control characters (0x00-0x1F) except \t \n \r before parsing
        const raw = packet.payload.toString();
        const sanitized = raw.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "");
        const payload = JSON.parse(sanitized) as Record<string, unknown>;
        const msgId = payload.msgId as string | undefined;

        // Dedup
        if (msgId) {
          if (seenInboundIds.has(msgId)) return;
          seenInboundIds.add(msgId);
          evictOldIds();
        }

        const sessionId = sessionInMatch[1];
        const type = (payload.type as string) ?? "text";
        log(`[MQTT] <- ${type} from session ${sessionId.slice(0, 8)}...`);
        inboundHandler?.(sessionId, type, payload);
      } catch (err) {
        const raw = packet.payload.toString();
        log(`[MQTT] invalid inbound message on ${topic}: ${err} — payload: ${raw.slice(0, 200)}`);
      }
      return;
    }

    // Match pailot/device/token — APNs device token registration from app
    if (topic === "pailot/device/token") {
      try {
        const raw = packet.payload.toString();
        const sanitized = raw.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "");
        const payload = JSON.parse(sanitized) as Record<string, unknown>;
        const token = payload.token as string | undefined;
        if (token) {
          inboundHandler?.(undefined, "apns_token", { token });
        }
      } catch (err) {
        log(`[MQTT] invalid device token message: ${err}`);
      }
      return;
    }

    // Match pailot/control/in — commands from app
    if (topic === "pailot/control/in") {
      try {
        // Strip control characters (0x00-0x1F) except \t \n \r before parsing
        const raw = packet.payload.toString();
        const sanitized = raw.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "");
        const payload = JSON.parse(sanitized) as Record<string, unknown>;
        const msgId = payload.msgId as string | undefined;

        // Dedup
        if (msgId) {
          if (seenInboundIds.has(msgId)) return;
          seenInboundIds.add(msgId);
          evictOldIds();
        }

        const command = (payload.command as string) ?? (payload.type as string);
        log(`[MQTT] <- command: ${command}`);
        inboundHandler?.(undefined, "command", payload);
      } catch (err) {
        const raw = packet.payload.toString();
        log(`[MQTT] invalid control message: ${err} — payload: ${raw.slice(0, 200)}`);
      }
      return;
    }
  });

  // --- Connection events ---
  broker.on("client", (client: any) => {
    mqttClientCount++;
    log(`[MQTT] client connected: ${client?.id ?? "unknown"} (total: ${mqttClientCount})`);
  });

  broker.on("clientDisconnect", (client: any) => {
    mqttClientCount = Math.max(0, mqttClientCount - 1);
    log(`[MQTT] client disconnected: ${client?.id ?? "unknown"} (total: ${mqttClientCount})`);
  });

  broker.on("clientError", (client: any, err: Error) => {
    log(`[MQTT] client error (${client?.id ?? "unknown"}): ${err.message}`);
  });

  // --- Start TLS server ---
  const tlsCreds = ensureTlsCert();
  if (tlsCreds) {
    mqttServer = createTlsServer({ key: tlsCreds.key, cert: tlsCreds.cert }, broker.handle) as unknown as Server;
    log("[MQTT] TLS enabled");
  } else {
    // Fallback: plain TCP if TLS setup fails (openssl not available, etc.)
    log("[MQTT] WARNING: TLS setup failed — falling back to plain TCP (not recommended)");
    const { createServer: createTcpServer } = await import("node:net");
    mqttServer = createTcpServer(broker.handle);
  }

  mqttServer.on("error", (err: Error) => {
    log(`[MQTT] server error: ${err.message}`);
  });

  mqttServer.listen(MQTT_PORT, () => {
    log(`[MQTT] broker listening on port ${MQTT_PORT}${MQTT_TOKEN ? " (auth enabled)" : " (no auth)"}${tlsCreds ? " [TLS]" : " [PLAIN TCP]"}`);

    // Publish initial "ready" status (overwrites any stale LWT from previous crash)
    mqttPublishStatus("ready", version);

    // Advertise via Bonjour/mDNS so PAILot app can auto-discover on LAN
    try {
      const { Bonjour } = require("bonjour-service");
      bonjourInstance = new Bonjour();
      bonjourService = bonjourInstance.publish({
        name: "AIBroker",
        type: "mqtt",
        port: MQTT_PORT,
      });
      log(`[MQTT] Bonjour advertising _mqtt._tcp on port ${MQTT_PORT}`);
    } catch (err) {
      log(`[MQTT] Bonjour advertising failed (non-fatal): ${err instanceof Error ? err.message : err}`);
    }
  });
}

/**
 * Stop the MQTT broker and TCP server.
 */
export function stopMqttBroker(): void {
  if (bonjourService) {
    try { bonjourService.stop(); } catch { /* ignore */ }
    bonjourService = null;
  }
  if (bonjourInstance) {
    try { bonjourInstance.destroy(); } catch { /* ignore */ }
    bonjourInstance = null;
  }
  if (broker) {
    // Publish shutting_down before closing
    mqttPublishStatus("shutting_down");

    broker.close(() => {
      log("[MQTT] broker closed");
    });
    broker = null;
  }
  if (mqttServer) {
    mqttServer.close();
    mqttServer = null;
  }
}

/** Returns true if the MQTT broker is running. */
export function isMqttRunning(): boolean {
  return broker !== null;
}
