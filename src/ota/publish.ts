/**
 * ota/publish.ts — the one publish call to the OTA install hub, shared by the
 * MCP tool `ota_publish` and the CLI `aibroker ota publish`.
 */
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { otaCurlArgs } from "../mcp/ota-args.js";
import { OTA_PORT } from "../daemon/ota.js";

export interface OtaPublishInput {
  slug: string;
  name: string;
  bundleId: string;
  version: string;
  platform: string;
  filePath: string;
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

/** Upload the build via curl (multipart, no FormData polyfill needed). */
export function publishOta(f: OtaPublishInput, port: number = OTA_PORT): OtaPublishResult {
  validateOtaInput(f);
  const raw = execFileSync("curl", otaCurlArgs(port, f), { encoding: "utf-8" });
  const parsed = JSON.parse(raw);
  return { installUrl: parsed?.installUrl || undefined, raw };
}
