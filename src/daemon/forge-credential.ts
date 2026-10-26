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
 */

export interface ForgeWriteCredential {
  /** Passed to authHeader: a bare token, or `user:password`. Absent when nothing is configured. */
  credential?: string;
  /** True when the bot account is the one in use. */
  bot: boolean;
  /** The configured name of the account, used when the forge will not say. */
  login?: string;
}

type Env = Record<string, string | undefined>;

const set = (v: string | undefined): string | undefined => (v && v.trim() ? v.trim() : undefined);

/** The credential for issue, comment and webhook writes. */
export function issueWriteCredential(env: Env = process.env): ForgeWriteCredential {
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
