import express, { Request, Response } from "express";
import multer from "multer";
import { z } from "zod";
import { existsSync, createReadStream, readdirSync } from "node:fs";
import { join, extname, basename } from "node:path";
import { rename } from "node:fs/promises";
import {
  ensureDirs, slugDir, listSlugs, readMeta, writeMeta,
  APPS_DIR, TMP_DIR, AppMeta,
} from "./paths.js";
import { requirePublisher, callerLogin } from "./auth.js";
import { renderManifest } from "./manifest.js";
import { renderLanding } from "./landing.js";

ensureDirs();

const app = express();
app.use(express.json());

// Multer stores to TMP_DIR (same volume as APPS_DIR — avoids cross-device rename on big IPAs)
const upload = multer({ dest: TMP_DIR });

const UploadSchema = z.object({
  slug: z.string().min(1).regex(/^[a-z0-9-]+$/, "slug must be lowercase alphanumeric + hyphens"),
  name: z.string().min(1),
  bundleId: z.string().min(1),
  version: z.string().min(1),
  platform: z.enum(["ios", "android"]),
});

// ── Health ──────────────────────────────────────────────────────────────────

app.get("/healthz", (_req, res) => {
  res.json({ ok: true });
});

// ── Apps API ────────────────────────────────────────────────────────────────

app.get("/api/apps", (_req, res) => {
  const slugs = listSlugs();
  const apps = slugs.map((slug) => ({ slug, ...readMeta(slug) })).filter((a) => a.name);
  res.json(apps);
});

app.post("/api/apps", requirePublisher, upload.single("file"), async (req: Request, res: Response) => {
  const parsed = UploadSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  if (!req.file) {
    res.status(400).json({ error: "Missing file field" });
    return;
  }

  const { slug, name, bundleId, version, platform } = parsed.data;
  const ext = extname(req.file.originalname).toLowerCase();

  if (platform === "ios" && ext !== ".ipa") {
    res.status(400).json({ error: "iOS platform requires .ipa file" });
    return;
  }
  if (platform === "android" && ext !== ".apk") {
    // .aab is not installable on devices — only .apk
    res.status(400).json({ error: "Android platform requires .apk file (.aab is not device-installable)" });
    return;
  }

  const dir = slugDir(slug);
  const fileName = `${name}-${version}${ext}`;
  const dest = join(dir, fileName);

  // ensureDirs for this slug
  const { mkdirSync } = await import("node:fs");
  mkdirSync(dir, { recursive: true });

  await rename(req.file.path, dest);

  // Merge into the existing record so an iOS publish keeps the APK and vice
  // versa; the landing page offers every platform that has a file.
  const previous = readMeta(slug);
  const meta: AppMeta = {
    ...(previous ?? {}),
    name, bundleId, version, platform,
    updatedAt: new Date().toISOString(),
    updatedBy: callerLogin(req),
    ...(platform === "ios" ? { ipaFile: fileName } : { apkFile: fileName }),
  };
  writeMeta(slug, meta);

  const proto = (req.headers["x-forwarded-proto"] as string | undefined) ?? req.protocol;
  const host = req.headers.host ?? "localhost";
  res.status(201).json({
    ok: true,
    installUrl: `${proto}://${host}/install/${slug}/`,
  });
});

app.delete("/api/apps/:slug", requirePublisher, (req: Request, res: Response) => {
  const { slug } = req.params;
  const dir = slugDir(slug);
  if (!existsSync(dir)) {
    res.status(404).json({ error: "App not found" });
    return;
  }
  const { rmSync } = require("node:fs") as typeof import("node:fs");
  rmSync(dir, { recursive: true, force: true });
  res.json({ ok: true });
});

// ── Install routes ──────────────────────────────────────────────────────────

app.get("/install/:slug/", (req: Request, res: Response) => {
  const { slug } = req.params;
  const meta = readMeta(slug);
  if (!meta) {
    res.status(404).send("App not found");
    return;
  }
  res.send(renderLanding(req, slug, meta));
});

app.get("/install/:slug/manifest.plist", (req: Request, res: Response) => {
  const { slug } = req.params;
  const meta = readMeta(slug);
  if (!meta || !meta.ipaFile) {
    res.status(404).send("Not found");
    return;
  }
  // manifest URL must be derived from req — iOS fails silently on host mismatch
  res.set({
    "Content-Type": "application/xml",
    "Cache-Control": "no-store",
  });
  res.send(renderManifest(req, slug, meta));
});

// Stream IPA / APK / icon files
app.get("/install/:slug/:file", (req: Request, res: Response) => {
  const { slug, file } = req.params;
  const filePath = join(slugDir(slug), file);
  if (!existsSync(filePath)) {
    res.status(404).send("Not found");
    return;
  }
  // Prevent path traversal
  if (!filePath.startsWith(APPS_DIR)) {
    res.status(403).send("Forbidden");
    return;
  }
  const ext = extname(file).toLowerCase();
  if (ext === ".ipa") {
    res.set({ "Content-Type": "application/octet-stream", "Cache-Control": "no-store" });
  } else if (ext === ".apk") {
    res.set({ "Content-Type": "application/vnd.android.package-archive", "Cache-Control": "no-store" });
  } else if (ext === ".png") {
    res.set("Content-Type", "image/png");
  }
  createReadStream(filePath).pipe(res);
});

// 8767, not 8765, and not 8766 either.
//
// This server used to claim 8765, which the AIBroker daemon's PAILot MQTT
// broker binds. The daemon is launchd-managed, so it always won the race: the
// container could not bind, `ota_publish` POSTed to a port that speaks MQTT and
// got nothing back, and the Tailscale Serve mappings for /install/ and /api/
// forwarded to the broker. Nothing surfaced any of it, because there was never
// a working case to compare against.
//
// 8766 is not the fix — that is the daemon's Todoist webhook, and moving here
// only swaps one silent collision for another (it answers 405 to a GET, which
// looks enough like a live server to fool a quick check). The daemon owns 8765
// and 8766; 8767 was confirmed unused before being chosen.
//
// PORT stays overridable so the container, compose and a bare
// `node dist/server.js` cannot drift apart.
const PORT = Number(process.env.PORT ?? 8767);
app.listen(PORT, "0.0.0.0", () => {
  console.log(`aibroker-ota listening on :${PORT}`);
});
