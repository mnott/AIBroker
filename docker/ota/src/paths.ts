import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DATA_DIR = process.env.DATA_DIR ?? "/data";
export const APPS_DIR = join(DATA_DIR, "apps");
export const TMP_DIR = join(DATA_DIR, "uploads-tmp");

export function ensureDirs(): void {
  mkdirSync(APPS_DIR, { recursive: true });
  mkdirSync(TMP_DIR, { recursive: true });
}

export function slugDir(slug: string): string {
  return join(APPS_DIR, slug);
}

export function metaPath(slug: string): string {
  return join(slugDir(slug), "meta.json");
}

export interface AppMeta {
  name: string;
  bundleId: string;
  version: string;
  platform: "ios" | "android";
  ipaFile?: string;
  apkFile?: string;
  icon?: string;
  updatedAt: string;
  updatedBy: string;
}

export function readMeta(slug: string): AppMeta | null {
  const p = metaPath(slug);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf-8")) as AppMeta;
  } catch {
    return null;
  }
}

export function writeMeta(slug: string, meta: AppMeta): void {
  mkdirSync(slugDir(slug), { recursive: true });
  writeFileSync(metaPath(slug), JSON.stringify(meta, null, 2), "utf-8");
}

export function listSlugs(): string[] {
  if (!existsSync(APPS_DIR)) return [];
  const { readdirSync, statSync } = require("node:fs") as typeof import("node:fs");
  return readdirSync(APPS_DIR).filter((e: string) =>
    statSync(join(APPS_DIR, e)).isDirectory()
  );
}
