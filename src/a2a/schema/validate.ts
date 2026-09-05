/**
 * a2a/schema/validate.ts — structural validation against the vendored A2A
 * subset in types.ts. Dependency-free by design (no npm JSON-Schema
 * engine): this is small enough to hand-check field by field, and every
 * check cites the field it is checking so a mismatch is traceable back to
 * README.md's source.
 *
 * Used two ways: the server validates every AgentCard and Task it emits
 * (a bug that shapes an invalid card is worse when nothing notices), and
 * `aibroker a2a check` uses the same functions against an ARBITRARY
 * remote agent's card, which is what makes that command interoperability
 * tooling rather than a self-test.
 */

import { TASK_STATES, type TaskState } from "./types.js";

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function isStr(v: unknown): v is string { return typeof v === "string"; }
function isStrArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

/** Spec 6.5.1 TextPart Object — the only Part kind this project checks
 *  strictly; a `file`/`data` kind part is accepted opaquely. */
function checkPart(v: unknown, path: string, errors: string[]): void {
  if (!isObj(v)) { errors.push(`${path}: not an object`); return; }
  if (v.kind === "text") {
    if (!isStr(v.text)) errors.push(`${path}: TextPart.text must be a string`);
    return;
  }
  if (v.kind !== "file" && v.kind !== "data") {
    errors.push(`${path}: Part.kind must be "text", "file" or "data"`);
  }
}

/** Spec 5.5.4 AgentSkill Object. */
function checkSkill(v: unknown, path: string, errors: string[]): void {
  if (!isObj(v)) { errors.push(`${path}: not an object`); return; }
  if (!isStr(v.id)) errors.push(`${path}.id: required string`);
  if (!isStr(v.name)) errors.push(`${path}.name: required string`);
  if (!isStr(v.description)) errors.push(`${path}.description: required string`);
  if (!isStrArray(v.tags)) errors.push(`${path}.tags: required string[]`);
}

/**
 * Spec 5.5 AgentCard Object. Checks only the fields this project sets —
 * see schema/README.md for what is deliberately out of scope.
 */
export function validateAgentCard(card: unknown): ValidationResult {
  const errors: string[] = [];
  if (!isObj(card)) return { ok: false, errors: ["AgentCard: not an object"] };

  if (!isStr(card.protocolVersion)) errors.push("protocolVersion: required string");
  if (!isStr(card.name)) errors.push("name: required string");
  if (!isStr(card.description)) errors.push("description: required string");
  if (!isStr(card.url)) errors.push("url: required string");
  if (card.preferredTransport !== "JSONRPC") errors.push('preferredTransport: must be "JSONRPC"');
  if (!isStr(card.version)) errors.push("version: required string");
  if (!isStrArray(card.defaultInputModes)) errors.push("defaultInputModes: required string[]");
  if (!isStrArray(card.defaultOutputModes)) errors.push("defaultOutputModes: required string[]");

  if (!isObj(card.capabilities)) {
    errors.push("capabilities: required object (AgentCapabilities)");
  } else {
    const cap = card.capabilities;
    if (cap.streaming !== undefined && typeof cap.streaming !== "boolean") errors.push("capabilities.streaming: must be boolean");
    if (cap.pushNotifications !== undefined && typeof cap.pushNotifications !== "boolean") errors.push("capabilities.pushNotifications: must be boolean");
    if (cap.extensions !== undefined) {
      if (!Array.isArray(cap.extensions)) errors.push("capabilities.extensions: must be an array");
      else for (const [i, ext] of cap.extensions.entries()) {
        if (!isObj(ext) || !isStr(ext.uri)) errors.push(`capabilities.extensions[${i}].uri: required string`);
      }
    }
  }

  if (!Array.isArray(card.skills)) {
    errors.push("skills: required array (AgentSkill[])");
  } else {
    card.skills.forEach((s, i) => checkSkill(s, `skills[${i}]`, errors));
  }

  if (card.securitySchemes !== undefined) {
    if (!isObj(card.securitySchemes)) errors.push("securitySchemes: must be an object");
    else for (const [key, scheme] of Object.entries(card.securitySchemes)) {
      if (!isObj(scheme) || scheme.type !== "http" || scheme.scheme !== "bearer") {
        errors.push(`securitySchemes.${key}: only HTTPAuthSecurityScheme{type:"http",scheme:"bearer"} is vendored`);
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

/** Spec 6.1 Task Object + 6.2 TaskStatus Object + 6.3 TaskState Enum. */
export function validateTask(task: unknown): ValidationResult {
  const errors: string[] = [];
  if (!isObj(task)) return { ok: false, errors: ["Task: not an object"] };

  if (task.kind !== "task") errors.push('kind: must be "task"');
  if (!isStr(task.id)) errors.push("id: required string");
  if (!isStr(task.contextId)) errors.push("contextId: required string");

  if (!isObj(task.status)) {
    errors.push("status: required object (TaskStatus)");
  } else {
    const state = task.status.state as TaskState;
    if (!TASK_STATES.includes(state)) {
      errors.push(`status.state: "${String(task.status.state)}" is not a TaskState`);
    }
    if (task.status.timestamp !== undefined && !isStr(task.status.timestamp)) {
      errors.push("status.timestamp: must be a string");
    }
  }

  if (task.artifacts !== undefined) {
    if (!Array.isArray(task.artifacts)) errors.push("artifacts: must be an array");
    else for (const [i, a] of task.artifacts.entries()) {
      if (!isObj(a) || !isStr(a.artifactId)) errors.push(`artifacts[${i}].artifactId: required string`);
      else if (!Array.isArray(a.parts)) errors.push(`artifacts[${i}].parts: required array`);
      else a.parts.forEach((p, j) => checkPart(p, `artifacts[${i}].parts[${j}]`, errors));
    }
  }

  if (task.history !== undefined) {
    if (!Array.isArray(task.history)) errors.push("history: must be an array");
    else for (const [i, m] of task.history.entries()) {
      if (!isObj(m) || m.kind !== "message") errors.push(`history[${i}].kind: must be "message"`);
      else {
        if (m.role !== "user" && m.role !== "agent") errors.push(`history[${i}].role: must be "user" or "agent"`);
        if (!isStr(m.messageId)) errors.push(`history[${i}].messageId: required string`);
        if (!Array.isArray(m.parts)) errors.push(`history[${i}].parts: required array`);
        else m.parts.forEach((p, j) => checkPart(p, `history[${i}].parts[${j}]`, errors));
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

/** Spec 6.4 Message Object — used to validate an inbound message/send params.message. */
export function validateMessage(msg: unknown): ValidationResult {
  const errors: string[] = [];
  if (!isObj(msg)) return { ok: false, errors: ["Message: not an object"] };
  if (msg.kind !== "message") errors.push('kind: must be "message"');
  if (msg.role !== "user" && msg.role !== "agent") errors.push('role: must be "user" or "agent"');
  if (!isStr(msg.messageId)) errors.push("messageId: required string");
  if (!Array.isArray(msg.parts) || msg.parts.length === 0) {
    errors.push("parts: required non-empty array");
  } else {
    msg.parts.forEach((p, i) => checkPart(p, `parts[${i}]`, errors));
  }
  return { ok: errors.length === 0, errors };
}
