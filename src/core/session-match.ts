/**
 * core/session-match.ts — one place that decides which session a name means.
 *
 * There were three. `dispatch` compared PAI project names against session
 * labels exactly; `send_to_session` did a ranked substring search; PAILot was
 * handed an id and never resolved anything. Different rules, different edge
 * cases, each fixed on its own — so `jobs-matthias` failed to match a session
 * named `Jobs Matthias` in the first while the second would have found it, and
 * the miss did not fail, it spawned a duplicate tab with none of the context.
 *
 * Matching is ranked rather than first-past-the-post, and two properties are
 * load-bearing:
 *
 * SEPARATORS ARE NOT SIGNIFICANT. Aliases are written machine-style and
 * sessions are named by a human; hyphen, underscore and whitespace all fold.
 *
 * A CALLER'S PREFERENCE OUTRANKS EXACTNESS. `send_to_session` prefers a live
 * Claude session over a shell, and must: every ended session leaves a shell tab
 * behind, and addressing "Clickr" after that session ended once matched the
 * leftover shell sitting in ~/dev/ai/clickr — where the message was executed
 * rather than read. An exact match against a shell must lose to a fuzzy match
 * against something that can actually receive.
 */

export interface SessionCandidate {
  id: string;
  name: string;
  paiName?: string | null;
}

/** How a name was matched, weakest last. Reported so a fuzzy hit is visible. */
export type MatchKind = "exact" | "normalised" | "substring";

const KIND_RANK: Record<MatchKind, number> = { exact: 3, normalised: 2, substring: 1 };

/** The name a human would call this session. */
export function labelOf(s: SessionCandidate): string {
  return s.paiName ?? s.name;
}

/** Fold the written forms of one name onto common ground. */
export function normaliseLabel(s: string): string {
  return s.toLowerCase().replace(/[\s_-]+/g, " ").trim();
}

export interface MatchOptions {
  /** Which strategies to try. Default: exact and normalised, never substring. */
  kinds?: MatchKind[];
  /**
   * Extra score per session, dominating match quality.
   *
   * Use for "this one can actually receive a message". Returning 1 for a live
   * Claude session and 0 for a shell reproduces the ranking send_to_session
   * needs, where a substring hit on a live session beats an exact hit on a
   * dead tab.
   */
  prefer?: (s: SessionCandidate) => number;
}

/**
 * Resolve any of `references` to a session.
 *
 * Substring is opt-in for a reason: a project called `sl` would otherwise match
 * every session whose title happens to contain those letters, and for dispatch
 * a wrong match spawns nothing and delivers to the wrong place instead.
 */
export function matchSession(
  references: string[],
  sessions: SessionCandidate[],
  opts: MatchOptions = {},
): { session: SessionCandidate; label: string; kind: MatchKind } | null {
  const kinds = opts.kinds ?? ["exact", "normalised"];
  const prefer = opts.prefer ?? (() => 0);

  const refs = references.filter(Boolean).map((r) => ({ raw: r.toLowerCase(), norm: normaliseLabel(r) }));
  if (refs.length === 0) return null;

  let best: { session: SessionCandidate; label: string; kind: MatchKind; score: number } | null = null;

  for (const s of sessions) {
    const label = labelOf(s);
    if (!label) continue;
    const lower = label.toLowerCase();
    const norm = normaliseLabel(label);

    let kind: MatchKind | null = null;
    for (const ref of refs) {
      if (kinds.includes("exact") && lower === ref.raw) { kind = "exact"; break; }
      if (kinds.includes("normalised") && norm === ref.norm) { kind = kind ?? "normalised"; continue; }
      if (kinds.includes("substring") && (lower.includes(ref.raw) || norm.includes(ref.norm))) {
        kind = kind ?? "substring";
      }
    }
    if (!kind) continue;

    // Preference dominates: 100 leaves room for every match kind beneath it.
    const score = prefer(s) * 100 + KIND_RANK[kind];
    if (!best || score > best.score) best = { session: s, label, kind, score };
  }

  return best ? { session: best.session, label: best.label, kind: best.kind } : null;
}
