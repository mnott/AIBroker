/**
 * daemon/image-context.ts — Per-session image context for conversational refinement.
 *
 * Tracks prompt history and the last generated image per routing context.
 * The composite key (source:recipient:sessionId) ensures complete isolation
 * between users, adapters, and sessions.
 */

export interface ImageContext {
  /** Each refinement step as a standalone phrase, oldest first. */
  promptHistory: string[];
  /** The most recently generated image buffer (for native img2img). */
  lastImage?: Buffer;
  /** MIME type of lastImage ("image/webp" | "image/png"). */
  lastImageMime: string;
  /** Unix ms timestamp — used for TTL eviction. */
  updatedAt: number;
}

const MAX_HISTORY = 8;
const DEFAULT_TTL_MS = 30 * 60 * 1000; // 30 minutes

const store = new Map<string, ImageContext>();

/**
 * Build the composite routing key for image context lookup.
 * Format: "{source}:{recipient}:{sessionId}"
 */
export function buildImageContextKey(
  source: string,
  recipient: string | undefined,
  sessionId: string | undefined,
): string {
  return `${source}:${recipient ?? ""}:${sessionId ?? ""}`;
}

export function getImageContext(key: string): ImageContext | undefined {
  return store.get(key);
}

export function setImageContext(key: string, ctx: ImageContext): void {
  store.set(key, ctx);
}

export function clearImageContext(key: string): void {
  store.delete(key);
}

/**
 * Remove image contexts that haven't been updated within the TTL window.
 * Returns the number of evicted entries.
 */
export function pruneStaleContexts(ttlMs = DEFAULT_TTL_MS): number {
  const cutoff = Date.now() - ttlMs;
  let evicted = 0;
  for (const [key, ctx] of store) {
    if (ctx.updatedAt < cutoff) {
      store.delete(key);
      evicted++;
    }
  }
  return evicted;
}

/**
 * Classify an incoming text message as a new image request, a refinement
 * of the current image context, or unrelated to image generation.
 *
 * Only returns "refine" when there is an actual signal — a pronoun
 * referencing the image, a modification verb, or a style keyword.
 * Messages that don't contain any image-related signal fall through
 * as "unrelated" so they reach normal routing (Claude, slash commands, etc.).
 */
export function classifyImageRequest(
  text: string,
  context: ImageContext | undefined,
): { type: "new" | "refine" | "unrelated"; prompt: string } {
  // No context — always new
  if (!context || context.promptHistory.length === 0) {
    return { type: "new", prompt: text };
  }

  const lower = text.toLowerCase().trim();

  // Explicit new-image signals (English + German)
  if (
    /^(new image|different image|new picture|start over|forget the image|neues bild|vergiss das bild)[:\s]/i.test(text) ||
    /^(new image|different image|new picture|start over|forget the image|neues bild|vergiss das bild)$/i.test(text)
  ) {
    const prompt = text.replace(/^[^:]+:\s*/i, "").trim();
    return { type: "new", prompt: prompt || text };
  }

  // Refinement signals: pronouns + modification verbs (English)
  if (
    /\b(it|the image|the picture|that)\b/i.test(text) ||
    /^(put|add|remove|change|make|give|turn|render|show)\b/i.test(text) ||
    /\b(style|as a|in a|black and white|watercolor|oil paint(ing)?|sketch|pixelated|cartoon|anime)\b/i.test(lower) ||
    /\b(more|less|brighter|darker|bigger|smaller|closer|farther)\b/i.test(lower)
  ) {
    return { type: "refine", prompt: text };
  }

  // Refinement signals: German
  if (
    /\b(das bild|das foto)\b/i.test(lower) ||
    /^(mach|ändere|füge hinzu|entferne|gib|zeig|setz)\b/i.test(lower)
  ) {
    return { type: "refine", prompt: text };
  }

  // Prepositional phrases that only make sense as image modifications
  // e.g., "with a hat", "in watercolor", "but bigger", "without the chair"
  if (/^(with|without|in|but|and|plus|minus)\b/i.test(lower)) {
    return { type: "refine", prompt: text };
  }
  if (/^(mit|ohne|in|aber|und|als)\b/i.test(lower)) {
    return { type: "refine", prompt: text };
  }

  // No image-related signal — this message is not about the image
  return { type: "unrelated", prompt: text };
}

/**
 * Build a combined prompt from the full prompt history using prompt chaining.
 *
 * The first entry is the base description; subsequent entries are refinement
 * phrases appended with ", ". Cap at MAX_HISTORY entries.
 */
export function buildChainedPrompt(history: string[]): string {
  const capped = history.slice(0, MAX_HISTORY);
  if (capped.length === 1) return capped[0];
  const [base, ...modifications] = capped;
  return `${base}, ${modifications.join(", ")}`;
}

/**
 * Append a new prompt phrase to the context's history, enforcing the cap.
 * Returns an updated context object (does NOT mutate the original).
 */
export function appendPromptToContext(
  existing: ImageContext | undefined,
  prompt: string,
  imageBuffer?: Buffer,
  imageMime = "image/png",
): ImageContext {
  const history = existing ? [...existing.promptHistory] : [];
  history.push(prompt);
  // Enforce cap
  while (history.length > MAX_HISTORY) history.shift();
  return {
    promptHistory: history,
    lastImage: imageBuffer ?? existing?.lastImage,
    lastImageMime: imageBuffer ? imageMime : (existing?.lastImageMime ?? "image/png"),
    updatedAt: Date.now(),
  };
}
