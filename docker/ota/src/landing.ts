import { Request } from "express";
import { AppMeta } from "./paths.js";

export function renderLanding(req: Request, slug: string, meta: AppMeta): string {
  const proto = (req.headers["x-forwarded-proto"] as string | undefined) ?? req.protocol;
  const host = req.headers.host ?? "localhost";
  const base = `${proto}://${host}`;

  if (meta.platform === "ios") {
    const manifestUrl = `${base}/install/${slug}/manifest.plist`;
    const itmsUrl = `itms-services://?action=download-manifest&url=${encodeURIComponent(manifestUrl)}`;
    return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Install ${meta.name}</title>
<style>body{font-family:system-ui;max-width:480px;margin:60px auto;padding:0 24px;text-align:center}
a.btn{display:inline-block;margin-top:24px;padding:14px 32px;background:#007aff;color:#fff;border-radius:12px;text-decoration:none;font-size:18px}</style>
</head>
<body>
<h1>${meta.name}</h1>
<p>Version ${meta.version}</p>
${meta.icon ? `<img src="/install/${slug}/icon.png" width="120" height="120" style="border-radius:22px">` : ""}
<br>
<a class="btn" href="${itmsUrl}">Install on iOS</a>
<p style="margin-top:32px;font-size:13px;color:#888">
  Ad-hoc build — your device UDID must be in the provisioning profile.
</p>
</body>
</html>`;
  }

  // Android
  const apkUrl = `${base}/install/${slug}/${meta.apkFile ?? ""}`;
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Install ${meta.name}</title>
<style>body{font-family:system-ui;max-width:480px;margin:60px auto;padding:0 24px;text-align:center}
a.btn{display:inline-block;margin-top:24px;padding:14px 32px;background:#3ddc84;color:#000;border-radius:12px;text-decoration:none;font-size:18px}</style>
</head>
<body>
<h1>${meta.name}</h1>
<p>Version ${meta.version}</p>
${meta.icon ? `<img src="/install/${slug}/icon.png" width="120" height="120" style="border-radius:22px">` : ""}
<br>
<a class="btn" href="${apkUrl}">Download APK</a>
<p style="margin-top:32px;font-size:13px;color:#888">
  Enable "Install unknown apps" in Android settings before installing.
</p>
</body>
</html>`;
}
