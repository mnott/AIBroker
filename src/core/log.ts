/**
 * Timestamped logger — all output goes to stderr (stdout is MCP JSON-RPC).
 * The prefix is configurable so each consumer can identify itself.
 */

let _prefix = "aibroker";

export function setLogPrefix(prefix: string): void {
  _prefix = prefix;
}

export function log(...args: unknown[]): void {
  const timestamp = new Date().toISOString().slice(11, 23);
  const parts = args.map((a) =>
    typeof a === "string" ? a : JSON.stringify(a),
  );
  process.stderr.write(`[${_prefix} ${timestamp}] ${parts.join(" ")}\n`);
}
