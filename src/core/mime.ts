/**
 * MIME type lookup table for file sending.
 * Superset of WhatsApp and Telegram MIME maps.
 */

export const MIME_MAP: Record<string, string> = {
  // Documents
  ".pdf": "application/pdf",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".zip": "application/zip",
  ".tar": "application/x-tar",
  ".gz": "application/gzip",
  ".json": "application/json",
  // Images
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  // Video
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".avi": "video/x-msvideo",
  ".mkv": "video/x-matroska",
  // Audio
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".m4a": "audio/mp4",
};

/**
 * Look up MIME type for a file extension.
 * Falls back to "application/octet-stream" for unknown extensions.
 */
export function lookupMime(ext: string): string {
  const normalized = ext.startsWith(".") ? ext.toLowerCase() : `.${ext.toLowerCase()}`;
  return MIME_MAP[normalized] ?? "application/octet-stream";
}

/**
 * The extension a MIME type should be saved under, WITHOUT a leading dot.
 *
 * The reverse direction needs to exist here rather than at each call site. Both
 * places that had their own answer got it wrong in the same way: a short list of
 * types they had thought about, and `bin` for everything else — so a video
 * arrived as `.bin`, unplayable until renamed by hand. A table that already
 * knows every type it accepts should also know what to call it on the way back.
 *
 * Falls back to `bin`, which is honest for a type nothing here recognises.
 */
export function extForMime(mime: string): string {
  const normalized = mime.toLowerCase().split(";")[0].trim();
  for (const [ext, type] of Object.entries(MIME_MAP)) {
    if (type === normalized) return ext.slice(1);
  }
  // A type we do not carry, but whose subtype names itself: image/heic -> heic.
  const subtype = normalized.split("/")[1];
  if (subtype && /^[a-z0-9]{2,5}$/.test(subtype)) return subtype;
  return "bin";
}
