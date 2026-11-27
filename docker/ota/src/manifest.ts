import { Request } from "express";
import { AppMeta } from "./paths.js";

// manifest URL must be derived from req — iOS fails silently on host mismatch
export function renderManifest(req: Request, slug: string, meta: AppMeta): string {
  const proto = (req.headers["x-forwarded-proto"] as string | undefined) ?? req.protocol;
  const host = req.headers.host ?? "localhost";
  const base = `${proto}://${host}`;
  const ipaFile = meta.ipaFile ?? "";
  const assetUrl = `${base}/install/${slug}/${ipaFile}`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>items</key>
  <array>
    <dict>
      <key>assets</key>
      <array>
        <dict>
          <key>kind</key>
          <string>software-package</string>
          <key>url</key>
          <string>${assetUrl}</string>
        </dict>
      </array>
      <key>metadata</key>
      <dict>
        <key>bundle-identifier</key>
        <string>${meta.bundleId}</string>
        <key>bundle-version</key>
        <string>${meta.version}</string>
        <key>kind</key>
        <string>software</string>
        <key>title</key>
        <string>${meta.name}</string>
      </dict>
    </dict>
  </array>
</dict>
</plist>`;
}
