/**
 * daemon/agentish-stats.ts — is AG2 actually cheaper, measured on the real
 * traffic between sessions rather than a hand-picked pair.
 *
 * `agentish measure` compares one message against a prose twin somebody
 * wrote to make the point. That is a demonstration, not a measurement: it
 * proves AG2 CAN be smaller, not that it IS, night after night, across every
 * session that is supposed to be speaking it. This reads the audit log
 * instead — every `send` between two sessions is already recorded there,
 * body and all — and classifies each one as AG2 or prose by running it
 * through the real validator, not a guess from its shape.
 */

import { readAudit, resolveBody } from "./audit.js";
import { check } from "../agentish/index.js";

const SESSION_ACTOR = /^session:/;

/**
 * A target is a session unless it looks like a transport address instead —
 * `@` (an email-shaped todoist actor showing up as a target), `uds:` or `/`
 * (a socket or path). Everything else — `session:Name`, or a bare `Name` —
 * is a session: on this log the hub records the actor as `session:X` but the
 * target as the bare display name, and requiring the same prefix on both
 * sides made this classifier match 0 of 1366 real sends and print "no data"
 * on a 5MB log — an instrument measuring nothing while reporting clean is
 * exactly the failure this whole validator exists to catch elsewhere.
 */
const NOT_A_SESSION_TARGET = /@|uds:|\//;

function isSessionTarget(target: string | undefined): boolean {
  return typeof target === "string" && target.trim().length > 0 && !NOT_A_SESSION_TARGET.test(target);
}

/**
 * AG2 did not exist before this date, so a send from before it is prose
 * however it happens to parse — a validator that classified by shape alone
 * would call a coincidentally `k=v`-shaped sentence "AG2" and quietly
 * inflate the count of a format nobody was using yet.
 */
export const AG2_BASELINE_DATE = "2026-09-05";

export type MessageClass = "ag2" | "prose";

interface ClassifiedMessage {
  ts: string;
  cls: MessageClass;
  tokens: number;
}

/**
 * Tokens, from raw characters — not tiktoken (no such dependency here), and
 * not the word-plus-punctuation counter `agentish.ts`'s `measure()` uses for
 * a pairwise comparison either. That counter treats `|`, `@`, `=` — AG2's
 * own punctuation — as one token each, the same as it treats an English
 * word; real tokenizers pack runs of ordinary text tighter than runs of
 * symbols. So this heuristic UNDERSTATES the AG2 side specifically, more
 * than it understates prose, which means the ratio this module prints is a
 * floor on the real saving, not a ceiling — read it as "at least this much",
 * never as "exactly this much".
 */
export function approxTokens(text: string): number {
  const base = Math.ceil(text.length / 4);
  const symbolRuns = text.match(/[^\sA-Za-z0-9]+/g)?.length ?? 0;
  return base + Math.ceil(symbolRuns * 0.5);
}

function classify(ts: string, body: string): MessageClass {
  if (ts < `${AG2_BASELINE_DATE}T00:00:00.000Z`) return "prose";
  const { kind, errors } = check(body);
  return kind !== null && errors.length === 0 ? "ag2" : "prose";
}

export interface AgentishStatsOptions {
  since?: Date;
  until?: Date;
}

export interface ClassSummary {
  count: number;
  totalTokens: number;
  meanTokens: number;
  medianTokens: number;
}

export interface DayRow {
  day: string;
  ag2: number;
  prose: number;
}

export interface AgentishStatsReport {
  ag2: ClassSummary;
  prose: ClassSummary;
  /** prose mean / ag2 mean, or null when either class has no messages. */
  ratio: number | null;
  perDay: DayRow[];
  baseline: string;
  heuristic: string;
}

function summarize(msgs: ClassifiedMessage[]): ClassSummary {
  const tokens = msgs.map((m) => m.tokens).sort((a, b) => a - b);
  const count = tokens.length;
  const totalTokens = tokens.reduce((a, b) => a + b, 0);
  const meanTokens = count ? totalTokens / count : 0;
  const mid = Math.floor(count / 2);
  const medianTokens = count === 0 ? 0 : count % 2 ? tokens[mid] : (tokens[mid - 1] + tokens[mid]) / 2;
  return { count, totalTokens, meanTokens, medianTokens };
}

/**
 * Every session-to-session `send` in the audit log, classified and summed.
 * Reads real messages, not samples — the whole point is that this is the
 * traffic that actually happened, not a fixture built to make a point.
 */
export function agentishStats(opts: AgentishStatsOptions = {}): AgentishStatsReport {
  const since = opts.since?.toISOString();
  const untilIso = opts.until?.toISOString();
  const events = readAudit({ action: "send", since }).filter(
    (e) => SESSION_ACTOR.test(e.actor) && isSessionTarget(e.target) && (!untilIso || e.ts <= untilIso),
  );

  const classified: ClassifiedMessage[] = events.map((e) => {
    const body = resolveBody(e) ?? "";
    return { ts: e.ts, cls: classify(e.ts, body), tokens: approxTokens(body) };
  });

  const ag2Msgs = classified.filter((m) => m.cls === "ag2");
  const proseMsgs = classified.filter((m) => m.cls === "prose");

  const perDayMap = new Map<string, { ag2: number; prose: number }>();
  for (const m of classified) {
    const day = m.ts.slice(0, 10);
    const row = perDayMap.get(day) ?? { ag2: 0, prose: 0 };
    row[m.cls] += 1;
    perDayMap.set(day, row);
  }
  const perDay = [...perDayMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, counts]) => ({ day, ...counts }));

  const ag2 = summarize(ag2Msgs);
  const prose = summarize(proseMsgs);
  const ratio = ag2.meanTokens > 0 && prose.count > 0 ? prose.meanTokens / ag2.meanTokens : null;

  return {
    ag2,
    prose,
    ratio,
    perDay,
    baseline: `every send before ${AG2_BASELINE_DATE} predates AG2 and counts as prose regardless of shape`,
    heuristic:
      "tokens ≈ ceil(chars/4) + half a token per run of non-alphanumeric symbols — punctuation-dense text (AG2's own | @ = characters) is undercounted more than prose is, so this UNDERSTATES the AG2 side; the ratio below is a floor on the real saving, not a ceiling",
  };
}

/** The report, as a human reads it — never a bare ratio. */
export function formatStatsReport(r: AgentishStatsReport): string {
  if (r.ag2.count === 0 && r.prose.count === 0) {
    return "no session-to-session sends found in the audit log for this range";
  }
  const lines: string[] = [
    `ag2:   ${r.ag2.count} msgs, mean ${r.ag2.meanTokens.toFixed(1)} tok, median ${r.ag2.medianTokens.toFixed(1)} tok, total ${r.ag2.totalTokens}`,
    `prose: ${r.prose.count} msgs, mean ${r.prose.meanTokens.toFixed(1)} tok, median ${r.prose.medianTokens.toFixed(1)} tok, total ${r.prose.totalTokens}`,
    r.ratio !== null
      ? `ratio (prose mean / ag2 mean): ${r.ratio.toFixed(2)}x`
      : "ratio: not enough data — need at least one message in each class",
    "",
    "per day (ag2 / prose):",
    ...r.perDay.map((row) => `  ${row.day}  ${row.ag2} / ${row.prose}`),
    "",
    `baseline: ${r.baseline}`,
    `heuristic: ${r.heuristic}`,
  ];
  return lines.join("\n");
}
