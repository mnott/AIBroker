import { RequestHandler } from "express";

// TRUST_HEADER defaults true only when the bind is loopback (127.0.0.1).
// If the bind ever changes to 0.0.0.0, set TRUST_HEADER=true explicitly.
// WARNING: on loopback, local processes on the Mac can spoof Tailscale-User-Login
// because the header is set by Tailscale Serve, not verified by the kernel.
// This is an accepted assumption: the threat model is remote attackers, not local root.

const TRUST = process.env.TRUST_HEADER !== "false";

if (!TRUST) {
  console.warn("[auth] TRUST_HEADER=false — all write operations will be rejected");
}

function publishers(): string[] {
  return (process.env.AIBROKER_OTA_PUBLISHERS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function isPublisher(login: string | undefined, allowed: string[]): boolean {
  if (!login) return false;
  const l = login.trim().toLowerCase();
  return allowed.some((p) => p.toLowerCase() === l);
}

/** Allow any tailnet user to read. Gate writes to the publisher allowlist. */
export const requirePublisher: RequestHandler = (req, res, next) => {
  if (!TRUST) {
    res.status(403).json({ error: "Write operations disabled (TRUST_HEADER=false)" });
    return;
  }
  const login = req.headers["tailscale-user-login"] as string | undefined;
  const allowed = publishers();
  if (allowed.length === 0) {
    res.status(403).json({ error: "Writes refused: AIBROKER_OTA_PUBLISHERS is empty; set it to a comma-separated list of allowed logins" });
    return;
  }
  if (!isPublisher(login, allowed)) {
    res.status(403).json({ error: "Not in publisher allowlist" });
    return;
  }
  next();
};

export function callerLogin(req: import("express").Request): string {
  return (req.headers["tailscale-user-login"] as string | undefined) ?? "unknown";
}
