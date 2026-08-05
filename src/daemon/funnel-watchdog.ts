/**
 * daemon/funnel-watchdog.ts — notice when public ingress dies, and only then
 * reconnect the node.
 *
 * Tailscale Funnel can report itself healthy while refusing every connection
 * from the internet. `tailscale funnel status` prints "Funnel on", the serve
 * config is intact, the client version is unchanged, the node is Online — and
 * connections through Tailscale's ingress relays are reset. Inbound webhooks
 * stop arriving and nothing anywhere says so; the outage is discovered when a
 * human notices a message never landed, hours later.
 *
 * The state clears when the node reconnects. So this watchdog is a probe and a
 * single lever, with the probe doing nearly all of the work.
 *
 * WHY THE PROBE HAS TO GO OUT TO THE INTERNET. The tailnet resolver answers the
 * funnel hostname with the node's own 100.x address, so any request made on
 * this machine against that name travels over the tailnet and is answered
 * happily by the same daemon that would answer a real one. That is a false
 * green, and it is what hid this failure before: local curl said 405 while the
 * public path was dead. We therefore resolve the hostname through a PUBLIC
 * resolver, connect to the ingress address it returns, and set SNI by hand.
 * Reaching the node from outside is the only fact that means anything.
 *
 * WHY IT IS RELUCTANT TO ACT. A reconnect drops every live tailnet connection
 * for a moment — SSH, file transfers, other services. So a bounce needs proof,
 * not a hunch:
 *
 *   - three consecutive failed probes, not one, so a blip is never enough;
 *   - an "unknown" verdict (no public DNS, no route off the machine) resets the
 *     counter instead of incrementing it — when the whole network is down the
 *     node is not the problem and bouncing it fixes nothing;
 *   - a cooldown after each attempt, so a fault this lever cannot fix degrades
 *     into a loud log line rather than a reconnect loop.
 *
 * The healthy path costs one TLS handshake every few minutes and touches
 * nothing.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { Resolver } from "node:dns/promises";
import https from "node:https";
import { log } from "../core/log.js";
import { audit } from "./audit.js";

/** Public resolvers, tried in order. The local one cannot be trusted here. */
const PUBLIC_RESOLVERS = ["1.1.1.1", "8.8.8.8"];

/**
 * Where `tailscale` might live, best first. The daemon's PATH under launchd is
 * minimal, so these are absolute.
 *
 * ORDER MATTERS, and not for the reason it usually does. The macOS app ships a
 * single binary that behaves as the GUI or as the CLI, and invoking it inside
 * the bundle from a background process answers "The Tailscale GUI failed to
 * start" — on stdout, with exit status 0, so it reads as success and parses as
 * nothing. The `/usr/local/bin` wrapper the app installs does work from there.
 * Prefer it; the bundle stays as a last resort for a machine that has no
 * wrapper.
 */
const TAILSCALE_CANDIDATES = [
  "/usr/local/bin/tailscale",
  "/opt/homebrew/bin/tailscale",
  "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
];

const HEALTHY_INTERVAL_MS = 5 * 60_000;
/** Once a probe fails, look again soon — to confirm or clear it quickly. */
const SUSPECT_INTERVAL_MS = 30_000;
const FAILURES_BEFORE_HEAL = 3;
const HEAL_COOLDOWN_MS = 15 * 60_000;
const PROBE_TIMEOUT_MS = 10_000;

export type Verdict = "up" | "down" | "unknown";

export interface WatchdogState {
  /** Failed probes in a row. Reset by anything that is not a clear failure. */
  consecutiveDown: number;
  /** When the lever was last pulled, so it cannot be pulled again at once. */
  lastHealAt?: number;
  /** Whether the current outage has already been announced, so we say it once. */
  announced: boolean;
}

export function initialState(): WatchdogState {
  return { consecutiveDown: 0, announced: false };
}

export interface ProbeResult {
  ip: string;
  /** An HTTP status — any status — means the ingress reached the node. */
  status?: number;
  /** ECONNRESET, ETIMEDOUT, … when it did not. */
  error?: string;
}

/**
 * One reachable relay is enough.
 *
 * Tailscale publishes several ingress addresses and they do not fail together:
 * during recovery two answered while the third still reset. Requiring all of
 * them would call a working funnel broken and bounce a healthy node.
 */
export function classify(results: ProbeResult[]): Verdict {
  if (results.length === 0) return "unknown";
  if (results.some((r) => typeof r.status === "number")) return "up";
  return "down";
}

export interface Decision {
  action: "sleep" | "heal";
  sleepMs: number;
  reason: string;
}

export interface DecideOptions {
  failuresBeforeHeal?: number;
  healCooldownMs?: number;
  healthyIntervalMs?: number;
  suspectIntervalMs?: number;
}

/**
 * What to do about a verdict. Pure, because this is the part that must be
 * right: everything it can get wrong is either an outage nobody notices or a
 * reconnect nobody asked for.
 *
 * Mutates `state`, returns the decision.
 */
export function decide(
  state: WatchdogState,
  verdict: Verdict,
  now: number,
  opts: DecideOptions = {},
): Decision {
  const threshold = opts.failuresBeforeHeal ?? FAILURES_BEFORE_HEAL;
  const cooldown = opts.healCooldownMs ?? HEAL_COOLDOWN_MS;
  const healthy = opts.healthyIntervalMs ?? HEALTHY_INTERVAL_MS;
  const suspect = opts.suspectIntervalMs ?? SUSPECT_INTERVAL_MS;

  if (verdict === "up") {
    state.consecutiveDown = 0;
    state.announced = false;
    return { action: "sleep", sleepMs: healthy, reason: "ingress reachable" };
  }

  if (verdict === "unknown") {
    // Could not tell. Not evidence of a broken node — evidence of a broken
    // vantage point. Forget the streak rather than building toward a bounce on
    // the strength of our own blindness.
    state.consecutiveDown = 0;
    return { action: "sleep", sleepMs: healthy, reason: "probe inconclusive" };
  }

  state.consecutiveDown += 1;
  if (state.consecutiveDown < threshold) {
    return {
      action: "sleep",
      sleepMs: suspect,
      reason: `ingress unreachable (${state.consecutiveDown}/${threshold})`,
    };
  }

  const since = state.lastHealAt === undefined ? Infinity : now - state.lastHealAt;
  if (since < cooldown) {
    return {
      action: "sleep",
      sleepMs: healthy,
      reason: `ingress unreachable but a reconnect ${Math.round(since / 1000)}s ago did not fix it`,
    };
  }

  state.lastHealAt = now;
  state.consecutiveDown = 0;
  return { action: "heal", sleepMs: suspect, reason: "ingress unreachable from every relay" };
}

/** The `tailscale` binary, or undefined when it is not installed here. */
export function tailscaleBinary(): string | undefined {
  return TAILSCALE_CANDIDATES.find((p) => existsSync(p));
}

export interface CliResult { ok: boolean; stdout?: string; error?: string; }

function firstLine(s?: string): string {
  return (s ?? "").trim().split("\n")[0].slice(0, 160) || "(no output)";
}

/**
 * Run the client, and report failure rather than swallowing it.
 *
 * The macOS app's CLI is not always usable from a background process: it wants
 * to talk to the GUI app and answers "The Tailscale GUI failed to start" when
 * it cannot. The first version of this file treated that error as "no funnel
 * configured", so the watchdog returned quietly and looked exactly like a
 * watchdog that was working — the precise failure it exists to prevent.
 */
export function runTailscale(bin: string, args: string[]): CliResult {
  try {
    const stdout = execFileSync(bin, args, { encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "pipe"] });
    return { ok: true, stdout };
  } catch (e) {
    const err = e as { stderr?: Buffer | string; message?: string };
    const text = (typeof err.stderr === "string" ? err.stderr : err.stderr?.toString()) || err.message || "unknown error";
    return { ok: false, error: text.trim().split("\n")[0] };
  }
}

/**
 * The node's funnel hostname, read from the client rather than configured.
 *
 * Hard-coding it would put one machine's name in the source and go stale the
 * first time the node is renamed.
 */
export function funnelHostname(bin = tailscaleBinary()): CliResult & { hostname?: string } {
  // An explicit override keeps the probe running where the client cannot be
  // queried. Watching is worth having on its own: it is what turns a silent
  // outage into a log line, even when this process cannot pull the lever.
  const override = process.env.AIBROKER_FUNNEL_HOST;
  if (override) return { ok: true, hostname: override };
  if (!bin) return { ok: false, error: "no tailscale binary" };

  const r = runTailscale(bin, ["status", "--json"]);
  if (!r.ok) return r;
  try {
    const name = JSON.parse(r.stdout ?? "")?.Self?.DNSName;
    return typeof name === "string" && name
      ? { ok: true, hostname: name.replace(/\.$/, "") }
      : { ok: false, error: "client reported no DNS name" };
  } catch {
    // Quote what it actually said: this is where a client that "succeeded"
    // while printing an error message gets caught.
    return { ok: false, error: `unparseable status output — ${firstLine(r.stdout)}` };
  }
}

/** Is a funnel even configured? Nothing to watch when it is not. */
export function funnelConfigured(bin = tailscaleBinary()): CliResult & { configured?: boolean } {
  if (process.env.AIBROKER_FUNNEL_HOST) return { ok: true, configured: true };
  if (!bin) return { ok: false, error: "no tailscale binary" };

  const r = runTailscale(bin, ["serve", "status", "--json"]);
  if (!r.ok) return r;
  try {
    const cfg = JSON.parse(r.stdout ?? "");
    return { ok: true, configured: Boolean(cfg?.AllowFunnel && Object.keys(cfg.AllowFunnel).length > 0) };
  } catch {
    return { ok: false, error: `unparseable serve output — ${firstLine(r.stdout)}` };
  }
}

/** Public ingress addresses for the funnel hostname, via a public resolver. */
export async function resolveIngress(hostname: string): Promise<string[]> {
  for (const server of PUBLIC_RESOLVERS) {
    try {
      const r = new Resolver({ timeout: 5_000, tries: 1 });
      r.setServers([server]);
      const ips = await r.resolve4(hostname);
      if (ips.length) return ips;
    } catch { /* try the next resolver */ }
  }
  return [];
}

/** One request to one ingress address, with SNI set to the funnel hostname. */
export function probeOne(ip: string, hostname: string, path = "/"): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const req = https.request(
      {
        host: ip,
        port: 443,
        path,
        method: "GET",
        servername: hostname,
        headers: { Host: hostname },
        timeout: PROBE_TIMEOUT_MS,
      },
      (res) => {
        // Any status at all proves the relay reached this node. 404 from an
        // unmapped path is as good a proof as 200.
        resolve({ ip, status: res.statusCode });
        res.resume();
      },
    );
    req.on("timeout", () => { req.destroy(); resolve({ ip, error: "ETIMEDOUT" }); });
    req.on("error", (e: NodeJS.ErrnoException) => resolve({ ip, error: e.code ?? e.message }));
    req.end();
  });
}

/** Probe every published ingress address. */
export async function probeIngress(hostname: string): Promise<ProbeResult[]> {
  const ips = await resolveIngress(hostname);
  if (!ips.length) return [];
  return Promise.all(ips.map((ip) => probeOne(ip, hostname)));
}

/** Reconnect the node. The one lever, pulled only on proof. */
export function reconnect(bin = tailscaleBinary()): boolean {
  if (!bin) return false;
  try {
    execFileSync(bin, ["down"], { timeout: 30_000, stdio: "ignore" });
    execFileSync(bin, ["up"], { timeout: 60_000, stdio: "ignore" });
    return true;
  } catch (e) {
    log(`funnel-watchdog: reconnect failed — ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

/**
 * Watch public ingress for as long as the daemon runs.
 *
 * Returns a stop function. Safe to start when Tailscale is absent: it says so
 * once and does nothing further.
 */
export function startFunnelWatchdog(opts: {
  probe?: (hostname: string) => Promise<ProbeResult[]>;
  heal?: () => boolean;
  hostname?: string;
} = {}): () => void {
  const bin = tailscaleBinary();
  if (!bin) {
    log("funnel-watchdog: not started — no tailscale binary found");
    return () => {};
  }

  const probe = opts.probe ?? probeIngress;
  const heal = opts.heal ?? (() => reconnect(bin));
  const state = initialState();
  let stopped = false;
  let watching = false;
  let cliComplained = false;
  let timer: NodeJS.Timeout | undefined;

  const arm = (ms: number) => {
    if (stopped) return;
    timer = setTimeout(tick, ms);
    timer.unref?.(); // never hold the process open
  };

  const tick = async () => {
    if (stopped) return;
    try {
      let hostname = opts.hostname;
      if (!hostname) {
        const found = funnelHostname(bin);
        if (!found.ok) {
          // Cannot ask the client. Say it once — quietly returning here is what
          // made the first version of this watchdog indistinguishable from a
          // working one.
          if (!cliComplained) {
            cliComplained = true;
            log(`funnel-watchdog: cannot query the Tailscale client — ${found.error}. ` +
                "Set AIBROKER_FUNNEL_HOST to watch anyway (healing still needs the client).");
          }
          return arm(HEALTHY_INTERVAL_MS);
        }
        hostname = found.hostname;
      }

      const cfg = funnelConfigured(bin);
      if (!cfg.ok) {
        if (!cliComplained) {
          cliComplained = true;
          log(`funnel-watchdog: cannot read the serve config — ${cfg.error}`);
        }
        return arm(HEALTHY_INTERVAL_MS);
      }
      if (!hostname || !cfg.configured) {
        // No funnel to watch. Not an error — the OTA hub and the webhook are
        // both optional — so check again later rather than giving up for good.
        return arm(HEALTHY_INTERVAL_MS);
      }
      cliComplained = false;

      const results = await probe(hostname);
      const verdict = classify(results);

      if (!watching) {
        // Say once that this is running. A watchdog whose healthy path is
        // silent is indistinguishable from one that never started — which is
        // the same invisibility it exists to fix.
        watching = true;
        log(`funnel-watchdog: watching public ingress across ${results.length} relay(s), ` +
            `every ${Math.round(HEALTHY_INTERVAL_MS / 1000)}s — currently ${verdict}`);
      }
      const decision = decide(state, verdict, Date.now());

      if (verdict === "down" && !state.announced) {
        state.announced = true;
        const detail = results.map((r) => `${r.ip} ${r.error ?? r.status}`).join(", ");
        log(`funnel-watchdog: public ingress is refusing connections — ${detail || "no ingress addresses"}`);
        audit({
          action: "funnel-watchdog", actor: "aibroker", target: "funnel",
          outcome: "down", meta: { results },
        });
      }

      if (decision.action === "heal") {
        log(`funnel-watchdog: ${decision.reason} — reconnecting the node`);
        const ok = heal();
        const after = ok ? classify(await probe(hostname)) : "unknown";
        log(`funnel-watchdog: reconnect ${ok ? "done" : "failed"}, ingress is now ${after}`);
        audit({
          action: "funnel-watchdog", actor: "aibroker", target: "funnel",
          outcome: after === "up" ? "recovered" : "unresolved",
          reason: decision.reason,
          meta: { reconnected: ok, verdictAfter: after },
        });
        if (after === "up") {
          state.consecutiveDown = 0;
          state.announced = false;
          return arm(HEALTHY_INTERVAL_MS);
        }
        // Still dead after the one lever we have. Say it plainly and stop
        // pulling it — from here a human is the next step, and a reconnect
        // loop would only add outages of its own.
        log("funnel-watchdog: ingress is STILL unreachable after a reconnect. " +
            "Inbound webhooks are not arriving; this needs a look.");
        return arm(decision.sleepMs);
      }

      arm(decision.sleepMs);
    } catch (e) {
      log(`funnel-watchdog: tick failed — ${e instanceof Error ? e.message : String(e)}`);
      arm(HEALTHY_INTERVAL_MS);
    }
  };

  void tick(); // check at startup: an outage may already be in progress
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = undefined;
  };
}
