/**
 * transport/policy.ts — the one place that decides which terminal hosts are
 * in play. Pure and dependency-free so the iTerm primitives (adapters/iterm/
 * core.ts), the facade and the selector can all ask it without import cycles.
 *
 *   AIBROKER_TRANSPORT=tmux   → tmux only
 *   AIBROKER_TRANSPORT=iterm  → iTerm only
 *   unset, darwin             → both (auto, availability checked live)
 *   unset, anything else      → tmux only — there is no iTerm, and never an osascript
 */

export interface TransportPolicy {
  allowIterm: boolean;
  allowTmux: boolean;
}

export function transportPolicy(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): TransportPolicy {
  const override = (env.AIBROKER_TRANSPORT ?? "").trim().toLowerCase();
  if (override === "tmux") return { allowIterm: false, allowTmux: true };
  if (override === "iterm") return { allowIterm: true, allowTmux: false };
  if (platform !== "darwin") return { allowIterm: false, allowTmux: true };
  return { allowIterm: true, allowTmux: true };
}

/** Is iTerm (and therefore AppleScript, lsappinfo, iTerm's pgrep) in play at all? */
export function itermInPlay(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return transportPolicy(env, platform).allowIterm;
}

/** AIBP terminal plugin id for this host: `terminal:iterm` where iTerm is in play, else `terminal:tmux`. */
export function terminalPluginId(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): "iterm" | "tmux" {
  return itermInPlay(env, platform) ? "iterm" : "tmux";
}

/** Is this AIBP address a terminal plugin of either kind? Consumers must not key on `terminal:iterm` alone. */
export function isTerminalAddress(address: string): boolean {
  return address === "terminal:iterm" || address === "terminal:tmux";
}

/** Human label for `aibroker status`: permitted transports plus why, e.g. `tmux (linux)`, `iterm+tmux (auto)`. */
export function transportLabel(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const p = transportPolicy(env, platform);
  const names = [p.allowIterm && "iterm", p.allowTmux && "tmux"].filter(Boolean).join("+");
  const override = (env.AIBROKER_TRANSPORT ?? "").trim().toLowerCase();
  const why = override === "tmux" || override === "iterm" ? "env" : platform === "darwin" ? "auto" : platform;
  return `${names} (${why})`;
}
