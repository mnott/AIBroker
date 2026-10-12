/**
 * Claude Code background sessions: the session runs detached under the Claude
 * daemon (`claude --session-id <uuid>`), and the pane you see runs a viewer
 * (`claude attach <uuid-or-prefix>`). Identity and mailbox must follow the
 * session uuid, not the pane.
 */

const UUID = "[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){0,3}(?:-[0-9a-fA-F]{12})?";

/** The uuid (or prefix) a `claude attach <id>` command line views, else undefined. */
export function parseAttachUuid(command: string): string | undefined {
  return new RegExp(`(?:^|/)claude(?:\\.exe)?\\s+attach\\s+(${UUID})(?:\\s|$)`).exec(command.trim())?.[1];
}

/** The uuid of a `claude … --session-id <uuid>` command line, else undefined. */
export function parseSessionIdArg(command: string): string | undefined {
  return new RegExp(`(?:^|/|\\s)claude(?:\\.exe)?\\s(?:.*\\s)?--session-id[ =](${UUID})(?:\\s|$)`).exec(command.trim())?.[1];
}

/** Whether two session uuids name the same session; either may be a prefix. */
export function sameClaudeSession(a: string, b: string): boolean {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x.length >= 8 && y.length >= 8 && (x.startsWith(y) || y.startsWith(x));
}
