/**
 * Timestamped logger — all output goes to stderr (stdout is MCP JSON-RPC).
 * The prefix is configurable so each consumer can identify itself.
 */

let _prefix = "aibroker";

export function setLogPrefix(prefix: string): void {
  _prefix = prefix;
}

export function log(...args: unknown[]): void {
  // LOCAL time, not UTC. Every other timestamp a person sees here — the audit
  // trail, the tracker, the messages themselves — is local, and this log is
  // read by lining it up against those. An offset that has to be remembered
  // gets forgotten, and the reader concludes the events are unrelated.
  const now = new Date();
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  const timestamp =
    `${p(now.getHours())}:${p(now.getMinutes())}:${p(now.getSeconds())}.${p(now.getMilliseconds(), 3)}`;
  const parts = args.map((a) =>
    typeof a === "string" ? a : JSON.stringify(a),
  );
  process.stderr.write(`[${_prefix} ${timestamp}] ${parts.join(" ")}\n`);
}
