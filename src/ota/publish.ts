/**
 * ota/publish.ts — the one publish call to the OTA install hub, shared by the
 * MCP tool `ota_publish` and the CLI `aibroker ota publish`.
 */
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { otaCurlArgs } from "../mcp/ota-args.js";
import { OTA_PORT } from "../daemon/ota.js";

export interface OtaPublishInput {
  slug: string;
  name: string;
  bundleId: string;
  version: string;
  platform: string;
  filePath: string;
  /** Optional build number; derived from the file when absent. */
  build?: string;
}

export interface OtaPublishResult {
  /** Install URL, when the hub returned one. */
  installUrl?: string;
  /** Raw hub response. */
  raw: string;
}

const SLUG_RE = /^[a-z0-9-]+$/;

/** Throws Error with a one-line reason on any invalid input or failure. */
export function validateOtaInput(f: OtaPublishInput): void {
  for (const k of ["slug", "name", "bundleId", "version", "platform", "filePath"] as const) {
    if (!f[k]) throw new Error(`Missing ${k}`);
  }
  if (!SLUG_RE.test(f.slug)) throw new Error(`Bad slug "${f.slug}": lowercase alphanumeric and hyphens only`);
  if (f.platform !== "ios" && f.platform !== "android") throw new Error(`Unknown platform "${f.platform}": use ios or android`);
  if (!existsSync(f.filePath)) throw new Error(`File not found: ${f.filePath}`);
}

/** "1.1.23 (40)" -> version 1.1.23, build 40. Anything else passes through. */
export function splitVersion(version: string): { version: string; build?: string } {
  const m = /^\s*(\S+)\s*\((\w[\w.-]*)\)\s*$/.exec(version);
  return m ? { version: m[1], build: m[2] } : { version };
}

function tool(cmd: string, args: string[], input?: Buffer): Buffer | null {
  const r = spawnSync(cmd, args, { input, maxBuffer: 16 * 1024 * 1024 });
  return r.status === 0 && !r.error ? r.stdout : null;
}

/** aapt/aapt2 candidates: PATH first, then Android SDK build-tools (highest version first). */
export function aaptCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  const out = ["aapt", "aapt2"];
  const sdks = [env.ANDROID_HOME, env.ANDROID_SDK_ROOT, join(homedir(), "Library/Android/sdk")];
  for (const sdk of sdks) {
    if (!sdk) continue;
    const bt = join(sdk, "build-tools");
    let vers: string[] = [];
    try { vers = readdirSync(bt); } catch { continue; }
    vers.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    for (const v of vers) for (const n of ["aapt", "aapt2"]) {
      const p = join(bt, v, n);
      if (existsSync(p)) out.push(p);
    }
  }
  return out;
}

/** Best effort: CFBundleVersion of an .ipa or versionCode of an .apk; undefined when unavailable. */
export function deriveBuild(filePath: string, platform: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  try {
    if (platform === "ios") {
      const list = tool("unzip", ["-Z1", filePath])?.toString("utf-8").split("\n");
      const entry = list?.find((l) => /^Payload\/[^/]+\.app\/Info\.plist$/.test(l));
      if (!entry) return undefined;
      const plist = tool("unzip", ["-p", filePath, entry]);
      if (!plist) return undefined;
      const v = tool("plutil", ["-extract", "CFBundleVersion", "raw", "-o", "-", "-"], plist)?.toString("utf-8").trim();
      return v || undefined;
    }
    for (const bin of aaptCandidates(env)) {
      const out = tool(bin, ["dump", "badging", filePath])?.toString("utf-8");
      const v = out ? /versionCode='([^']+)'/.exec(out)?.[1] : undefined;
      if (v) return v;
    }
    return undefined;
  } catch { return undefined; }
}

/** Split a "V (B)" version and fill a missing build from the file. */
export function resolveOtaInput(f: OtaPublishInput): OtaPublishInput {
  const s = splitVersion(f.version);
  const build = f.build || s.build || deriveBuild(f.filePath, f.platform);
  return { ...f, version: s.version, ...(build ? { build } : {}) };
}

/** Upload the build via curl (multipart, no FormData polyfill needed). */
export function publishOta(f: OtaPublishInput, port: number = OTA_PORT): OtaPublishResult {
  validateOtaInput(f);
  const raw = execFileSync("curl", otaCurlArgs(port, resolveOtaInput(f)), { encoding: "utf-8" });
  const parsed = JSON.parse(raw);
  return { installUrl: parsed?.installUrl || undefined, raw };
}
