import { Request } from "express";
import { AppMeta } from "./paths.js";
import { escapeXml as e } from "./escape.js";

/**
 * One landing page per app. Each platform that has a file gets its own
 * button — an app published for iOS and Android must not hide one behind the
 * other, which is what happened when the page branched on `meta.platform`
 * (the platform of the most recent publish).
 */
export function renderLanding(req: Request, slug: string, meta: AppMeta): string {
  const proto = (req.headers["x-forwarded-proto"] as string | undefined) ?? req.protocol;
  const host = req.headers.host ?? "localhost";
  const base = `${proto}://${host}`;

  const buttons: string[] = [];
  const notes: string[] = [];

  if (meta.ipaFile) {
    const manifestUrl = `${base}/install/${encodeURIComponent(slug)}/manifest.plist`;
    const itmsUrl = `itms-services://?action=download-manifest&url=${encodeURIComponent(manifestUrl)}`;
    buttons.push(`<a class="btn ios" href="${e(itmsUrl)}">Install on iOS</a>`);
    notes.push("iOS: ad-hoc build — your device UDID must be in the provisioning profile.");
    notes.push("Close the app first (swipe it away in the app switcher), then tap Install. The install runs in the background; the icon shows progress.");
  }
  if (meta.apkFile) {
    const apkUrl = `${base}/install/${encodeURIComponent(slug)}/${encodeURIComponent(meta.apkFile)}`;
    buttons.push(`<a class="btn android" href="${e(apkUrl)}">Download APK</a>`);
    notes.push('Android: enable "Install unknown apps" in settings before installing.');
  }

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Install ${e(meta.name)}</title>
<style>body{font-family:system-ui;max-width:480px;margin:60px auto;padding:0 24px;text-align:center}
a.btn{display:block;margin:16px auto 0;max-width:280px;padding:14px 32px;border-radius:12px;text-decoration:none;font-size:18px}
a.ios{background:#007aff;color:#fff}
a.android{background:#3ddc84;color:#000}</style>
</head>
<body>
<h1>${e(meta.name)}</h1>
<p>Version ${e(meta.version)}${meta.build ? ` (build ${e(meta.build)})` : ""}<br>
<span style="font-size:13px;color:#888">Published ${e(meta.updatedAt)}</span></p>
${meta.icon ? `<img src="/install/${e(encodeURIComponent(slug))}/icon.png" width="120" height="120" style="border-radius:22px">` : ""}
<br>
${buttons.join("\n")}
<p style="margin-top:32px;font-size:13px;color:#888">
  ${notes.join("<br>")}
</p>
</body>
</html>`;
}
