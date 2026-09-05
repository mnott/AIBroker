/**
 * a2a/schema/types.ts — the subset of the A2A v0.3.0 wire types this project
 * actually emits or consumes. See README.md in this directory for the
 * source, retrieval date, and what is deliberately NOT here.
 */

/** Spec 6.3 TaskState Enum — full enum, though this server only ever
 *  produces submitted/working/input-required/completed/canceled/failed. */
export type TaskState =
  | "submitted" | "working" | "input-required" | "completed"
  | "canceled" | "failed" | "rejected" | "auth-required" | "unknown";

export const TASK_STATES: readonly TaskState[] = [
  "submitted", "working", "input-required", "completed",
  "canceled", "failed", "rejected", "auth-required", "unknown",
];

/** Spec 6.5.1 TextPart Object. The only Part kind this project emits. */
export interface TextPart {
  readonly kind: "text";
  text: string;
  metadata?: Record<string, unknown>;
}

/** Spec 6.5 Part Union Type — FilePart/DataPart are accepted opaquely on
 *  read (never produced), so callers sending them are not rejected outright. */
export type Part = TextPart | { readonly kind: "file" | "data"; [k: string]: unknown };

/** Spec 6.4 Message Object. */
export interface A2AMessage {
  readonly kind: "message";
  readonly role: "user" | "agent";
  parts: Part[];
  messageId: string;
  taskId?: string;
  contextId?: string;
  metadata?: Record<string, unknown>;
  extensions?: string[];
  referenceTaskIds?: string[];
}

/** Spec 6.2 TaskStatus Object. */
export interface TaskStatus {
  state: TaskState;
  message?: A2AMessage;
  timestamp?: string;
}

/** Spec 6.7 Artifact Object. */
export interface Artifact {
  artifactId: string;
  name?: string;
  description?: string;
  parts: Part[];
  metadata?: Record<string, unknown>;
  extensions?: string[];
}

/** Spec 6.1 Task Object. */
export interface Task {
  readonly kind: "task";
  id: string;
  contextId: string;
  status: TaskStatus;
  history?: A2AMessage[];
  artifacts?: Artifact[];
  metadata?: Record<string, unknown>;
}

/** Spec 5.5.2.1 AgentExtension Object. */
export interface AgentExtension {
  uri: string;
  description?: string;
  required?: boolean;
  params?: Record<string, unknown>;
}

/** Spec 5.5.2 AgentCapabilities Object. */
export interface AgentCapabilities {
  streaming?: boolean;
  pushNotifications?: boolean;
  stateTransitionHistory?: boolean;
  extensions?: AgentExtension[];
}

/** Spec 5.5.4 AgentSkill Object. */
export interface AgentSkill {
  id: string;
  name: string;
  description: string;
  tags: string[];
  examples?: string[];
  inputModes?: string[];
  outputModes?: string[];
  security?: Record<string, string[]>[];
}

/**
 * Spec 5.5.3 SecurityScheme Object — discriminated union over the OpenAPI
 * 3.0 Security Scheme Object (https://swagger.io/specification/#security-scheme-object).
 * Only the HTTP bearer variant is vendored: it is the only one this project
 * emits.
 */
export interface HTTPAuthSecurityScheme {
  type: "http";
  scheme: "bearer";
  bearerFormat?: string;
  description?: string;
}

/** Spec 5.5 AgentCard Object — fields this project sets. `provider`,
 *  `iconUrl`, `documentationUrl`, `additionalInterfaces`, `signatures`
 *  and `supportsAuthenticatedExtendedCard` are all optional in the spec
 *  and omitted here rather than guessed. */
export interface AgentCard {
  protocolVersion: string;
  name: string;
  description: string;
  url: string;
  preferredTransport: "JSONRPC";
  version: string;
  capabilities: AgentCapabilities;
  securitySchemes?: Record<string, HTTPAuthSecurityScheme>;
  security?: Record<string, string[]>[];
  defaultInputModes: string[];
  defaultOutputModes: string[];
  skills: AgentSkill[];
}

/**
 * Spec 8.1 Standard JSON-RPC Errors + 8.2 A2A-Specific Errors, verbatim.
 * A2A-specific codes are in the JSON-RPC-reserved server-error range
 * (-32000..-32099).
 */
export const JSONRPC_ERRORS = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  TASK_NOT_FOUND: -32001,
  TASK_NOT_CANCELABLE: -32002,
  PUSH_NOTIFICATION_NOT_SUPPORTED: -32003,
  UNSUPPORTED_OPERATION: -32004,
  CONTENT_TYPE_NOT_SUPPORTED: -32005,
  INVALID_AGENT_RESPONSE: -32006,
} as const;

export interface JSONRPCError {
  code: number;
  message: string;
  data?: unknown;
}

export interface JSONRPCRequest {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
}

export interface JSONRPCSuccess {
  jsonrpc: "2.0";
  id: string | number;
  result: unknown;
}

export interface JSONRPCFailure {
  jsonrpc: "2.0";
  id: string | number | null;
  error: JSONRPCError;
}
