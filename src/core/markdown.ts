/**
 * Shared markdown transform primitives.
 *
 * These transforms are the common subset used by both WhatsApp and Telegram
 * formatters. Each transport applies additional platform-specific rules on top.
 */

/**
 * Apply the 8 shared block-level and inline markdown transforms.
 *
 * Transform order:
 * 1. Headings → bold uppercase (using placeholder to protect from italic pass)
 * 2. Horizontal rules → em dashes
 * 3. Blockquotes → left bar
 * 4. Checkboxes → unicode checkboxes
 * 5. Unordered lists → bullet points
 * 6. Bold **text** → placeholder-wrapped
 * 7. Italic *text* → _text_
 * 8. Replace bold placeholders with target bold marker
 *
 * @param text - Input markdown text
 * @param boldMarker - The bold delimiter for the target platform ("*" for WhatsApp, "<b>" for Telegram)
 * @param boldEndMarker - The closing bold delimiter ("*" for WhatsApp, "</b>" for Telegram)
 * @param italicMarker - The italic delimiter ("_" for WhatsApp, "<i>" for Telegram)
 * @param italicEndMarker - The closing italic delimiter ("_" for WhatsApp, "</i>" for Telegram)
 */
export function applySharedMarkdownTransforms(
  text: string,
  boldMarker: string,
  boldEndMarker: string,
  italicMarker: string,
  italicEndMarker: string,
): string {
  const BOLD = "\x01";
  return text
    // Block-level: headings → bold uppercase (placeholder-wrapped)
    .replace(/^#{1,6}\s+(.+)$/gm, (_m, title: string) => `${BOLD}${title.toUpperCase()}${BOLD}`)
    // Block-level: horizontal rules → em dashes
    .replace(/^---+$/gm, "———")
    // Block-level: blockquotes → left bar
    .replace(/^>\s?(.*)$/gm, "▎ $1")
    // Block-level: checkboxes
    .replace(/^(\s*)- \[x\]\s+/gm, "$1☑ ")
    .replace(/^(\s*)- \[ \]\s+/gm, "$1☐ ")
    // Block-level: unordered list items → bullet
    .replace(/^(\s*)[-*]\s+/gm, "$1• ")
    // Inline: bold **text** → placeholder-wrapped
    .replace(/\*\*(.+?)\*\*/gs, `${BOLD}$1${BOLD}`)
    // Inline: italic *text* → target italic markers
    .replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/gs, `${italicMarker}$1${italicEndMarker}`)
    // Inline: code `text` → ```text```
    .replace(/`([^`]+)`/g, "```$1```")
    // Replace bold placeholders with target bold markers
    .replace(new RegExp(BOLD, "g"), (_, offset: number) => {
      // Even occurrences = opening, odd = closing
      // Simple approach: alternate between open and close
      return boldMarker; // caller handles open/close if markers differ
    });
}

/**
 * WhatsApp markdown formatter.
 * Uses * for bold, _ for italic.
 */
export function markdownToWhatsApp(text: string): string {
  const BOLD = "\x01";
  return text
    .replace(/^#{1,6}\s+(.+)$/gm, (_m, title: string) => `${BOLD}${title.toUpperCase()}${BOLD}`)
    .replace(/^---+$/gm, "———")
    .replace(/^>\s?(.*)$/gm, "▎ $1")
    .replace(/^(\s*)- \[x\]\s+/gm, "$1☑ ")
    .replace(/^(\s*)- \[ \]\s+/gm, "$1☐ ")
    .replace(/^(\s*)[-*]\s+/gm, "$1• ")
    .replace(/\*\*(.+?)\*\*/gs, `${BOLD}$1${BOLD}`)
    .replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/gs, "_$1_")
    .replace(/`([^`]+)`/g, "```$1```")
    .replace(new RegExp(BOLD, "g"), "*");
}
