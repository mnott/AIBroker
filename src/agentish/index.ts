/**
 * agentish/index.ts — Agentish v2 (AG2), the wire format sessions use to
 * talk to each other.
 *
 * A session working a long shift reports to whoever is managing it many
 * times a night, and every one of those reports is budget spent before any
 * work gets done. Prose restates the task to prove it was understood, hedges
 * where a fact would do, and buries the one field a reader actually needs —
 * did the gate pass — in a paragraph. AG2 is the alternative: a kind line
 * plus `k=v` lines with one-letter keys, so a report costs as few tokens as
 * the facts it carries and can be checked by a machine instead of read by
 * one. `check` refuses a report that is missing a required field, uses a key
 * its kind does not have, carries a field of the wrong shape, or claims
 * success (`r=+`) without the proof that success requires; `measure` prints
 * a message's token count beside a prose twin so the saving is a number, not
 * a claim.
 *
 * This module is deliberately dependency-free — no daemon code, no Node API
 * beyond what plain JS already gives it — so a team that wants the validator
 * without AIBroker's daemon can take this one file (or `npm install` it,
 * once it is split into its own package) and get CI checking for free. See
 * `docs/agentish.md`, section "Use in CI".
 *
 * This is a port, not an original design — a sibling project's validator
 * (`tools/agentish.py`) worked out the shape of these checks first. AG2_SPEC
 * is the sibling's wire format, unchanged. `why` (the `y` key) is this
 * project's own addition: it is not in AG2_SPEC, it is documented separately
 * as AG2_EXTENSIONS, and it is accepted only where a report needs room to
 * explain a result that is not a plain pass — R, Q, X. The sibling has not
 * adopted it; until it does, "why" is something this validator alone checks.
 */

/** The wire format itself, unmodified, as it is told to every session that
 * must speak it. This is the sibling project's spec — extensions live in
 * AG2_EXTENSIONS instead of being folded in here. */
export const AG2_SPEC =
  "AG2. msg=kind line+k=v lines. kinds T R S Q A X. keys i id g goal o own n forbid d steps p proof u out l limits r res c changes t tests G gate I inst m images # nums w worst x next z note(<200ch). sep |. outcomes + - ~ ? !. @n=path declared once then reused; @n:12=file:line. tests as Name+ Name-. no prose, no articles, never restate, unknown=?. r=+ only if all t +.";

/** What this validator accepts beyond AG2_SPEC. Not yet proposed back to the
 * sibling project — see the module comment. */
export const AG2_EXTENSIONS = "y why(≤600ch)";

/** This validator's own identity when it is carried over a channel that
 * needs one — e.g. an A2A extension declaration. Not part of AG2_SPEC. */
export const AGENTISH_URI = "urn:aibroker:a2a:ext:agentish:2";

export type AgentishKind = "T" | "R" | "S" | "Q" | "A" | "X";

/** One-letter key → canonical field name. */
const KEYS: Record<string, string> = {
  i: "id", g: "goal", o: "own", n: "no", d: "do", p: "prove",
  u: "out", l: "lim", r: "res", c: "chg", t: "test", G: "gate",
  I: "inst", m: "img", "#": "num", w: "worst", x: "next", z: "note",
  a: "a", q: "q", b: "blk", e: "eta", y: "why", s: "at",
};

/** The one or two fields each kind cannot be validated without, by their
 * short letter — so a missing one is reported the way it is written. */
const REQUIRED: Record<AgentishKind, string[]> = {
  T: ["i", "g", "d", "t"],
  R: ["i", "r", "t", "c"],
  A: ["i", "r"],
  Q: ["i", "z"],
  S: ["i"],
  X: ["i", "z"],
};

/** Everything else a kind may carry, by canonical name. `why` (the
 * AG2_EXTENSIONS field) is deliberately absent from T, S and A: a task or a
 * status has nothing yet to explain, and an answer either is one or is not. */
const OPTIONAL: Record<AgentishKind, string[]> = {
  T: ["own", "no", "prove", "out", "lim", "gate", "note"],
  R: ["inst", "img", "num", "worst", "next", "note", "gate", "prove", "why"],
  S: ["at", "res", "blk", "eta", "note"],
  Q: ["q", "dflt", "opts", "why"],
  A: ["a", "note"],
  X: ["why"],
};

/** Canonical name → the short symbol a "bad shape" error names it by. */
const SHAPE_SYMBOL: Record<string, string> = {
  id: "i", res: "r", gate: "G", num: "#", img: "m", chg: "c",
};

const OUTCOMES = new Set(["+", "-", "~", "?", "!"]);
const MAX_LINES = 25;
const NOTE_MAX_CHARS = 200;
const WHY_MAX_CHARS = 600;
const ID_SHAPE = /^[a-z0-9][\w.-]*$/;
const NUM_SHAPE = /^[\d,. ]*$/;
const IMG_SHAPE = /\.(png|jpe?g|pdf)$/i;
const AT_REF = /@[A-Za-z0-9_]+(?::\d+)?/;

/**
 * A stable identifier for one failure, so a CI script can branch on `code`
 * instead of grepping `message`. This table is a public contract once
 * published — see docs/agentish.md's "Use in CI" section, which says so.
 */
export type AgentishErrorCode =
  | "E_EMPTY" | "E_KIND" | "E_TOO_LONG" | "E_PARSE" | "E_DUP" | "E_REQUIRED"
  | "E_KEY" | "E_SHAPE" | "E_REF_UNDECLARED" | "E_R_UNPROVEN" | "E_Z_LEN"
  | "E_Y_LEN" | "E_T_OMITTED" | "E_T_UNREQUESTED";

export interface AgentishError {
  code: AgentishErrorCode;
  message: string;
  /** 1-based position among this message's own non-blank lines, where known. */
  line?: number;
}

export interface AgentishCheckResult {
  kind: AgentishKind | null;
  fields: Record<string, string>;
  symbols: Record<string, string>;
  /** Human-readable messages, in order — the format every existing caller
   * and test in this codebase reads. Same content as `details[].message`. */
  errors: string[];
  /** The same failures, with a stable code and a line where one applies. */
  details: AgentishError[];
}

function splitOnce(s: string, sep: string): [string, string] {
  const i = s.indexOf(sep);
  return i < 0 ? [s, ""] : [s.slice(0, i), s.slice(i + 1)];
}

/** `Name+` → `+`, `Name=+` → `+`, bare `+` → `+`. */
function outcomeOf(entry: string): string {
  const e = entry.trim();
  if (!e) return "";
  return e.includes("=") ? e.split("=").pop()! : e.slice(-1);
}

/** `Name+` → `Name`, `Name=+` → `Name`. Used to compare test sets by name,
 * ignoring the outcome each side attached to that name. */
function nameOf(entry: string): string {
  const e = entry.trim();
  if (!e) return "";
  if (e.includes("=")) return e.split("=")[0];
  return OUTCOMES.has(e.slice(-1)) ? e.slice(0, -1) : e;
}

function tokenNames(field: string | undefined): Set<string> {
  const names = (field ?? "").trim().split(/\s+/).filter(Boolean).map(nameOf).filter(Boolean);
  return new Set(names);
}

function lines(text: string): string[] {
  return text
    .trim()
    .split(/\r\n|\r|\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.trim().length > 0);
}

/**
 * Validate one Agentish message. `earlier` is the thread's prior messages —
 * read for their `@n=path` declarations, so a reply can reuse a symbol
 * without repeating the line that introduced it, and for a `T` sharing this
 * message's `id`, so an `R` can be held to the tests that `T` asked for.
 */
export function check(msg: string, earlier: string[] = []): AgentishCheckResult {
  const details: AgentishError[] = [];
  const errors: string[] = [];
  const fail = (code: AgentishErrorCode, message: string, line?: number): void => {
    details.push(line === undefined ? { code, message } : { code, message, line });
    errors.push(message);
  };

  const ls = lines(msg);
  if (ls.length === 0) {
    fail("E_EMPTY", "empty message");
    return { kind: null, fields: {}, symbols: {}, errors, details };
  }

  const kind = ls[0].trim() as AgentishKind;
  const fields: Record<string, string> = {};
  const fieldLine: Record<string, number> = {};
  const symbols: Record<string, string> = {};

  if (!(kind in REQUIRED)) {
    fail("E_KIND", `unknown kind ${JSON.stringify(ls[0].trim())}; one of ${Object.keys(REQUIRED).join(" ")}`, 1);
    return { kind: null, fields, symbols, errors, details };
  }
  if (ls.length > MAX_LINES) {
    fail("E_TOO_LONG", `${ls.length} lines > ${MAX_LINES}`, 1);
  }

  const earlierParsed = earlier.map((e) => check(e));
  for (const parsed of earlierParsed) Object.assign(symbols, parsed.symbols);

  for (let i = 1; i < ls.length; i++) {
    const l = ls[i];
    const lineNo = i + 1;
    if (l.startsWith("@") && l.includes("=")) {
      const [sym, path] = splitOnce(l.slice(1), "=");
      symbols[sym.trim()] = path.trim();
      continue;
    }
    const eq = l.indexOf("=");
    const colon = l.indexOf(":");
    const sep = eq >= 0 && (colon < 0 || eq < colon) ? "=" : ":";
    if (l.indexOf(sep) < 0) {
      fail("E_PARSE", `not k=v: ${JSON.stringify(l.slice(0, 40))}`, lineNo);
      continue;
    }
    const [rawKey, rawValue] = splitOnce(l, sep);
    const k = KEYS[rawKey.trim()] ?? rawKey.trim();
    if (k in fields) fail("E_DUP", `duplicate key ${k}`, lineNo);
    fields[k] = rawValue.trim();
    fieldLine[k] = lineNo;
  }

  for (const short of REQUIRED[kind]) {
    if (!(KEYS[short] in fields)) fail("E_REQUIRED", `${kind} requires ${short}`, 1);
  }
  const allowed = new Set([...REQUIRED[kind].map((s) => KEYS[s]), ...OPTIONAL[kind]]);
  for (const k of Object.keys(fields)) {
    if (!allowed.has(k)) fail("E_KEY", `unknown key ${k}`, fieldLine[k]);
  }

  // Value shapes. Run whenever the field is present, independent of whether
  // this kind accepts it — a malformed value is worth reporting even when
  // "unknown key" already covers the field not belonging here at all.
  if ("id" in fields && !ID_SHAPE.test(fields.id)) fail("E_SHAPE", `${SHAPE_SYMBOL.id}: bad shape`, fieldLine.id);
  if ("res" in fields && !OUTCOMES.has(fields.res)) fail("E_SHAPE", `${SHAPE_SYMBOL.res}: bad shape`, fieldLine.res);
  if ("gate" in fields && !OUTCOMES.has(fields.gate)) fail("E_SHAPE", `${SHAPE_SYMBOL.gate}: bad shape`, fieldLine.gate);
  if ("num" in fields && !NUM_SHAPE.test(fields.num)) fail("E_SHAPE", `${SHAPE_SYMBOL.num}: bad shape`, fieldLine.num);
  if ("img" in fields) {
    const bad = fields.img.split("|").some((p) => {
      const e = p.trim();
      return e !== "" && !e.includes("/") && !IMG_SHAPE.test(e);
    });
    if (bad) fail("E_SHAPE", `${SHAPE_SYMBOL.img}: bad shape`, fieldLine.img);
  }

  if (kind === "R") {
    const test = fields.test ?? "";
    if (test && !test.trim().split(/\s+/).filter(Boolean).every((tk) => OUTCOMES.has(outcomeOf(tk)))) {
      fail("E_SHAPE", "test: every entry ends with + - ~ ?", fieldLine.test);
    }

    if ("chg" in fields) {
      const entries = fields.chg.split("|").map((p) => p.trim()).filter(Boolean);
      if (entries.some((e) => !AT_REF.test(e) && !e.includes("/"))) {
        fail("E_SHAPE", `${SHAPE_SYMBOL.chg}: bad shape`, fieldLine.chg);
      }
      for (const entry of entries) {
        const head = entry.split(" ")[0].split(":")[0];
        if (head.startsWith("@") && !(head.slice(1) in symbols)) {
          fail("E_REF_UNDECLARED", `chg uses undeclared symbol ${head}`, fieldLine.chg);
        }
      }
    }

    // Success is a claim this validator holds a message to, not a tone: all
    // three of the gate, the proof, and every named test have to say so.
    if (fields.res === "+") {
      const gatePassed = fields.gate === "+";
      const hasProof = (fields.prove ?? "").trim().length > 0;
      const testsPassed = test.trim().split(/\s+/).filter(Boolean).every((tk) => outcomeOf(tk) === "+");
      if (!gatePassed || !hasProof || !testsPassed) fail("E_R_UNPROVEN", "r=+ without proof", fieldLine.res);
    }
    // Anything short of a clean pass, or a named worst-remaining issue, owes
    // a reason — otherwise "~" and "-" read exactly like "didn't get to it".
    const needsWhy = fields.res === "-" || fields.res === "~" || "worst" in fields;
    if (needsWhy && !(fields.why ?? "").trim()) fail("E_REQUIRED", "R requires y", fieldLine.res ?? 1);

    const priorT = [...earlierParsed].reverse().find((p) => p.kind === "T" && p.fields.id === fields.id);
    if (priorT) {
      const wanted = tokenNames(priorT.fields.test);
      const got = tokenNames(fields.test);
      for (const name of wanted) if (!got.has(name)) fail("E_T_OMITTED", `t omitted: ${name}`, fieldLine.test);
      for (const name of got) if (!wanted.has(name)) fail("E_T_UNREQUESTED", `t unrequested: ${name}`, fieldLine.test);
    }
  }

  if ((fields.why ?? "").length > WHY_MAX_CHARS) {
    fail("E_Y_LEN", `y > ${WHY_MAX_CHARS} chars (extension field too long)`, fieldLine.why);
  }
  if ((fields.note ?? "").length > NOTE_MAX_CHARS) {
    fail("E_Z_LEN", `note > ${NOTE_MAX_CHARS} chars (restating the task)`, fieldLine.note);
  }

  return { kind, fields, symbols, errors, details };
}

/**
 * Tokens ≈ words + punctuation. The sibling project counts with tiktoken;
 * this repo takes on no tokenizer dependency for a number that only needs to
 * land on the same conclusion as that one, not match it digit for digit.
 */
function approxTokens(text: string): number {
  const found = text.match(/[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu);
  return found ? found.length : 0;
}

export interface AgentishMeasureResult {
  agentish: number;
  prose: number;
  ratio: number;
  valid: boolean;
}

/** A message's token cost beside its prose twin, so a saving is a number. */
export function measure(msg: string, proseTwin: string): AgentishMeasureResult {
  const agentish = approxTokens(msg);
  const prose = approxTokens(proseTwin);
  const { errors } = check(msg);
  return { agentish, prose, ratio: prose === 0 ? 0 : agentish / prose, valid: errors.length === 0 };
}
