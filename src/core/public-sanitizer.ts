/**
 * public-sanitizer — refuse text that carries site details or secrets before
 * it is posted publicly. Pure: no I/O, no network.
 */

export type SanitizeHit = { rule: string; match: string; index: number };

const RULES: Array<[string, RegExp]> = [
  ["private-key", /-----BEGIN [A-Z ]*PRIVATE KEY/g],
  ["token", /\b(?:ghp_|gho_|github_pat_|sk-|xox[bp]-)[A-Za-z0-9_-]{8,}|\bAKIA[0-9A-Z]{12,}\b/g],
  ["secret-assignment", /\b(?:token|secret|password|key)\s*[=:]\s*["']?[A-Za-z0-9+/_-]{32,}={0,2}/gi],
  ["email", /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g],
  ["ipv4", /\b(?:\d{1,3}\.){3}\d{1,3}\b/g],
  ["ipv6", /(?<![\w:])(?:[0-9a-fA-F]{1,4}:){2,7}[0-9a-fA-F]{0,4}(?![\w:])|(?<![\w:])(?:[0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{0,4}(?![\w:])/g],
  ["internal-host", /\b(?:[a-z0-9-]+\.)+(?:local|lan|internal|mnsoft\.org)\b|\b[a-z0-9.-]*localhost[a-z0-9.-]*\b/gi],
  ["fs-path", /\/Users\/[^\s/]+|\/home\/[^\s/]+|\/var\/folders\/\S*|\/Volumes\/\S*|(?<![\w.])~\/\S+|\b[A-Za-z]:\\Users\\/g],
  ["forge-ref", /\bAPPS\/[\w.-]+#\d+/g],
  ["internal-id", /\b\d{8}-\d{6}-\d+\b/g],
];

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function checkPublicText(text: string, extraDenyTerms: string[] = []): { ok: boolean; hits: SanitizeHit[] } {
  const hits: SanitizeHit[] = [];
  for (const [rule, re] of RULES) {
    for (const m of text.matchAll(new RegExp(re.source, re.flags))) {
      hits.push({ rule, match: m[0], index: m.index ?? 0 });
    }
  }
  for (const term of extraDenyTerms) {
    if (!term) continue;
    const re = new RegExp(`(?<![\\w])${escapeRe(term)}(?![\\w])`, "gi");
    for (const m of text.matchAll(re)) hits.push({ rule: "deny-term", match: m[0], index: m.index ?? 0 });
  }
  hits.sort((a, b) => a.index - b.index);
  return { ok: hits.length === 0, hits };
}

export function assertPublicSafe(text: string, extra: string[] = []): void {
  const { ok, hits } = checkPublicText(text, extra);
  if (ok) return;
  const counts = new Map<string, number>();
  for (const h of hits) counts.set(h.rule, (counts.get(h.rule) ?? 0) + 1);
  const list = [...counts].map(([r, n]) => `${r} x${n}`).join(", ");
  throw new Error(`text is not safe for public posting: ${list}`);
}

export function twinBranchName(prNumber: number): string {
  if (!Number.isInteger(prNumber) || prNumber <= 0) throw new Error(`invalid PR number: ${prNumber}`);
  return `gh-pr-${prNumber}`;
}
