/**
 * Environment a supervised (launchd / systemd) process must carry: the
 * installing shell's PATH plus every AIBROKER_* var, because a service manager
 * starts with neither.
 */

export function serviceEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = { PATH: env.PATH || "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" };
  for (const [k, v] of Object.entries(env)) if (k.startsWith("AIBROKER_") && v !== undefined) out[k] = v;
  return out;
}

export const xmlEscape = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** `<key>K</key><string>V</string>` pairs for a plist EnvironmentVariables dict. */
export function plistEnvEntries(env: Record<string, string>): string {
  return Object.entries(env).map(([k, v]) => `<key>${xmlEscape(k)}</key><string>${xmlEscape(v)}</string>`).join("");
}
