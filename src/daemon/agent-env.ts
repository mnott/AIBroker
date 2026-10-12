/**
 * Does this process run under an agent (Claude Code session or PAI worker)?
 * `aibroker manage` from such a process is never the operator: it cannot end
 * or shorten a goal.
 */
export function runsUnderAgent(env: NodeJS.ProcessEnv): boolean {
  return env.CLAUDECODE === "1" || !!env.CLAUDE_CODE_SESSION_ID || env.PAI_WORKER === "1";
}
