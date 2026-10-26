/**
 * Which forge credential a write uses.
 *
 * Two accounts live in the environment. AIBROKER_FORGE_TOKEN is the operator's
 * own and is what release and push-mirror work needs (repo admin). Issue and
 * comment writes should not be signed with it: a comment written by a session
 * then appears under the operator's name. So issue-tracker writes and webhook
 * registration prefer a bot account when one is configured, in either form:
 *
 *   AIBROKER_FORGE_BOT_TOKEN                          sent as `token <t>`
 *   AIBROKER_FORGE_BOT_USER + AIBROKER_FORGE_BOT_PASSWORD   sent as Basic
 *
 * and fall back to AIBROKER_FORGE_TOKEN when neither is set. This is the only
 * place those variables are read for a tracker write.
 *
 * Different projects may live on different forges or need different accounts,
 * so ~/.aibroker/config.json may carry a map that NAMES env variables (the
 * secrets stay in ~/.aibroker/env):
 *
 *   { "forge": { "credentials": [
 *     { "match": "git.example.org/OWNER/REPO", "token_env": "NAME" },
 *     { "match": "github.com/OWNER/*", "user_env": "NAME", "password_env": "NAME" },
 *     { "match": "git.example.org", "token_env": "NAME" } ] } }
 *
 * The most specific match wins (repo > owner > host); no match, or a match whose
 * variables are unset, falls through to the global bot and then operator token.
 */

import { readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

export interface ForgeWriteCredential {
  /** Passed to authHeader: a bare token, or `user:password`. Absent when nothing is configured. */
  credential?: string;
  /** True when the bot account is the one in use. */
  bot: boolean;
  /** The configured name of the account, used when the forge will not say. */
  login?: string;
  /** The `match` of the configured rule that chose this credential, when one did. */
  rule?: string;
}

export interface CredentialRule {
  match: string;
  token_env?: string;
  user_env?: string;
  password_env?: string;
}

/** Where a repository is, for matching against rules. */
export interface RuleTarget { origin: string; owner: string; repo: string }

/** The `forge.credentials` map from ~/.aibroker/config.json. Empty when absent or unreadable. */
export function loadCredentialRules(path: string = join(homedir(), ".aibroker", "config.json")): CredentialRule[] {
  try {
    const list = JSON.parse(readFileSync(path, "utf8"))?.forge?.credentials;
    return Array.isArray(list) ? list.filter((r) => r && typeof r.match === "string") : [];
  } catch {
    return [];
  }
}

/** How specific a rule is for this repository: 3 repo, 2 owner, 1 host, 0 no match. */
function specificity(match: string, t: RuleTarget): number {
  const parts = match.trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "").toLowerCase().split("/");
  const host = new URL(t.origin).host.toLowerCase();
  if (parts[0] !== host) return 0;
  if (parts.length === 1) return 1;
  if (parts[1] !== t.owner.toLowerCase()) return 0;
  if (parts.length === 2 || (parts.length === 3 && parts[2] === "*")) return 2;
  return parts.length === 3 && parts[2] === t.repo.toLowerCase() ? 3 : 0;
}

function fromRule(r: CredentialRule, env: Env): ForgeWriteCredential | undefined {
  const token = r.token_env ? set(env[r.token_env]) : undefined;
  if (token) return { credential: token, bot: true, rule: r.match };
  const user = r.user_env ? set(env[r.user_env]) : undefined;
  const password = r.password_env ? env[r.password_env] : undefined;
  if (user && password) return { credential: `${user}:${password}`, bot: true, login: user, rule: r.match };
  return undefined;
}

type Env = Record<string, string | undefined>;

const set = (v: string | undefined): string | undefined => (v && v.trim() ? v.trim() : undefined);

/** The credential for issue, comment and webhook writes, for `target` when given. */
export function issueWriteCredential(
  env: Env = process.env,
  target?: RuleTarget,
  rules: CredentialRule[] = target ? loadCredentialRules() : [],
): ForgeWriteCredential {
  if (target) {
    const ranked = rules
      .map((r) => ({ r, s: specificity(r.match, target) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s);
    for (const { r } of ranked) {
      const hit = fromRule(r, env);
      if (hit) return hit;
    }
  }
  const configuredLogin = set(env.AIBROKER_FORGE_BOT_LOGIN);
  const botToken = set(env.AIBROKER_FORGE_BOT_TOKEN);
  if (botToken) return { credential: botToken, bot: true, login: configuredLogin };

  const user = set(env.AIBROKER_FORGE_BOT_USER);
  const password = env.AIBROKER_FORGE_BOT_PASSWORD;
  if (user && password) {
    return { credential: `${user}:${password}`, bot: true, login: configuredLogin ?? user };
  }

  return { credential: set(env.AIBROKER_FORGE_TOKEN), bot: false, login: configuredLogin };
}

/** The credential for release and push-mirror work. Always the operator's. */
export function releaseCredential(env: Env = process.env): string | undefined {
  return set(env.AIBROKER_FORGE_TOKEN);
}

/**
 * The route rule that drops events authored by the bot account.
 *
 * Keyed on the account actually used, so the bot's own comments never come back
 * as operator input while the operator's still do.
 */
export function botIgnoreRule(login: string): string {
  return `sender.login=${login}`;
}

/**
 * Does the route already drop the bot's own events by account? When it does,
 * the short "we just wrote to this issue" window is not needed, and would only
 * swallow an operator comment made in the same minute and a half.
 */
export function routeIgnoresAccount(route: { ignore?: string[] }, login: string | undefined): boolean {
  if (!login) return false;
  const want = botIgnoreRule(login).toLowerCase();
  return (route.ignore ?? []).some((r) => r.trim().toLowerCase() === want);
}
