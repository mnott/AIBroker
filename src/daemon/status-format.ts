/** daemon/status-format.ts — text rendering of the hub status for `aibroker status`. */

import type { ValidatedHubStatus } from "../ipc/validate.js";

export function formatHubStatus(status: ValidatedHubStatus): string[] {
  const out = [`AIBroker Hub v${status.version}`];
  if (status.status !== "ok") {
    out.push(`  Status:         ${status.status}${status.detail ? ` — ${status.detail}` : ""}`);
  }
  out.push(`  Transport:      ${status.transport}`);
  out.push(`  Active session: ${status.activeSession ?? "(none)"}`);
  out.push(`  Sessions:       ${status.activeSessions}`);
  out.push(`  Adapters:       ${status.adapters.join(", ") || "(none)"}`);
  if (Object.keys(status.adapterHealth).length > 0) {
    out.push("", "  Adapter Health:");
    for (const [name, h] of Object.entries(status.adapterHealth)) {
      const icon = h.status === "ok" ? "●" : h.status === "degraded" ? "◐" : "○";
      const detail = h.detail ? ` — ${h.detail}` : "";
      const msgs = `↓${h.stats.messagesReceived} ↑${h.stats.messagesSent}`;
      out.push(`    ${icon} ${name}: ${h.status} (${h.connectionStatus}) ${msgs}${detail}`);
    }
  }
  return out;
}
