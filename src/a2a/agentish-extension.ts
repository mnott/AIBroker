/**
 * a2a/agentish-extension.ts — Agentish v2 (AG2) declared as an A2A protocol
 * extension.
 *
 * A2A already carries a Message built of typed Parts (spec 4.1.4/4.1.6 in
 * the current draft; 6.4/6.5 in the stable v0.3.0 JSON-RPC spec) — it does
 * not say what the words inside a text part mean. AG2 is a wire format for
 * what agents tell each other about a job: a kind line plus k=v lines
 * instead of prose. Declaring it as an A2A extension (spec 4.6 "Extensions",
 * 5.5.2.1 "AgentExtension Object" in v0.3.0) means any A2A agent can say "I
 * understand AG2" in its AgentCard, and any other A2A agent can check that
 * declaration before sending AG2 text — without AG2 needing its own
 * transport, auth, or discovery story. A2A already has those.
 *
 * This module defines the extension: its URI, its AgentCard fragment, and
 * helpers to mark and validate a Part as carrying AG2 text. It does not run
 * an A2A server — see docs/a2a-agentish-extension.md for what that would
 * still take.
 */

import { AG2_SPEC, AG2_EXTENSIONS, AGENTISH_URI, check } from "../agentish/index.js";

/**
 * Extension identifier (A2A spec 5.5.2.1: AgentExtension.uri — "The unique
 * URI identifying the extension"). One URN, one definition — this is an
 * alias of `AGENTISH_URI` from agentish/index.ts, not a second constant
 * that could drift from it. A2A does not require the URI to resolve, so it
 * is a `urn:`, not an `https:` URL pointing at a domain nobody has
 * registered or serves. `AGENTISH_SPEC_URL` below is the resolvable
 * pointer, for callers that want one.
 */
export const AGENTISH_EXTENSION_URI = AGENTISH_URI;

/**
 * Where to find the AG2 spec this extension declares. Not a network
 * location — an aibroker installation ships this file at this path, so it
 * resolves against the aibroker package or repository you installed from
 * (npm package root, or a checkout of the source repository).
 */
export const AGENTISH_SPEC_URL = "docs/agentish.md";

/** Media type an AG2-carrying Part may advertise instead of (or in addition
 *  to) the `metadata.agentish` tag — see isAg2Part(). Matches the emerging
 *  A2A draft's per-part `mediaType` field (not yet in the stable v0.3.0
 *  TextPart shape); ag2Part() does not emit it today, but isAg2Part()
 *  already recognizes it so a differently-built AG2 part is not missed. */
export const AGENTISH_MEDIA_TYPE = "text/x-agentish";

/** Shape of one `AgentCard.capabilities.extensions[]` entry (A2A spec
 *  5.5.2.1, AgentExtension Object: uri, description, required, params). */
export interface AgentishExtensionDeclaration {
  uri: string;
  description: string;
  required: boolean;
  params: {
    version: string;
    spec: string;
    spec_url: string;
    extensions: string;
    validator: string;
  };
}

/**
 * Build the `AgentCard.capabilities.extensions[]` entry that declares AG2
 * support. `required: false` — an agent that does not understand AG2 can
 * still exchange plain-text Messages with this one; AG2 is additive, never
 * load-bearing for the base protocol.
 */
export function agentCardExtension(): AgentishExtensionDeclaration {
  return {
    uri: AGENTISH_EXTENSION_URI,
    description:
      "Agentish v2 (AG2): a compact kind+k=v wire format for agent-to-agent " +
      "task reports. params.spec carries the format; params.validator names " +
      "the CLI that checks a message against it.",
    required: false,
    params: {
      version: "2",
      spec: AG2_SPEC,
      spec_url: AGENTISH_SPEC_URL,
      extensions: AG2_EXTENSIONS,
      validator: "aibroker agentish check",
    },
  };
}

/**
 * Minimal shape this module needs from A2A's TextPart (spec 6.5.1, stable
 * v0.3.0: `{ kind: "text", text, metadata? }`), declared locally so this
 * module carries no dependency on an A2A SDK.
 */
export interface A2ATextPart {
  readonly kind: "text";
  text: string;
  metadata?: Record<string, unknown>;
  /** Not part of the stable v0.3.0 TextPart shape — carried here only so
   *  isAg2Part() can also recognize a part tagged this way instead of via
   *  metadata. See AGENTISH_MEDIA_TYPE. */
  mediaType?: string;
}

/**
 * Build a TextPart carrying AG2 text, tagged via `metadata.agentish: "2"`
 * so a receiver can recognize it as AG2 before parsing the text itself.
 * Metadata is the extension point A2A defines for exactly this purpose
 * (spec 4.6.2 "Extension Points": Message/Part metadata keyed by the
 * extension's concern).
 */
export function ag2Part(text: string): A2ATextPart {
  return {
    kind: "text",
    text,
    metadata: { agentish: "2" },
  };
}

/**
 * True if `part` is a TextPart tagged as AG2, either by ag2Part()'s
 * `metadata.agentish === "2"` convention or by a `mediaType`/`mimeType` of
 * `text/x-agentish` (AGENTISH_MEDIA_TYPE) — some other sender may tag a
 * part that way instead. Either is sufficient; neither is required to be
 * absent. Does not validate the text itself — use validateAg2Part() for
 * that.
 */
export function isAg2Part(part: unknown): part is A2ATextPart {
  if (typeof part !== "object" || part === null) return false;
  const p = part as Record<string, unknown>;
  if (p.kind !== "text") return false;
  if (typeof p.text !== "string") return false;

  const metadata = p.metadata;
  const taggedByMetadata =
    typeof metadata === "object" &&
    metadata !== null &&
    (metadata as Record<string, unknown>).agentish === "2";

  const taggedByMediaType = p.mediaType === AGENTISH_MEDIA_TYPE || p.mimeType === AGENTISH_MEDIA_TYPE;

  return taggedByMetadata || taggedByMediaType;
}

export interface Ag2PartValidation {
  ok: boolean;
  errors: string[];
}

/**
 * Validate an AG2-tagged Part's text against the AG2 grammar. Delegates to
 * daemon/agentish.ts's `check()` — this module owns only the A2A wrapping,
 * not the grammar itself. `earlier` is the thread's prior AG2 message texts,
 * passed through unchanged so `@n=path` symbols they declared stay in scope
 * (same contract as `check()`).
 *
 * Returns `ok: false` with one synthetic error if `part` is not an AG2 part
 * at all, so a caller that skipped `isAg2Part()` still gets a usable result
 * instead of a thrown error.
 */
export function validateAg2Part(part: unknown, earlier: string[] = []): Ag2PartValidation {
  if (!isAg2Part(part)) {
    return {
      ok: false,
      errors: ["not an AG2 part: missing kind:\"text\" or metadata.agentish:\"2\""],
    };
  }
  const result = check(part.text, earlier);
  return { ok: result.errors.length === 0, errors: result.errors };
}
