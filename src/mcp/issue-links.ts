/**
 * mcp/issue-links.ts — a report that names an issue has to link to it.
 *
 * Observed over an evening of unattended work: reports arrive saying "#4 and
 * #159 done", and the reader is on a phone. A bare number is not a reference
 * to anyone who cannot type a URL from memory, and asking for links politely
 * in a rule was forgotten within the hour — twice, then a third time after the
 * rule was written down.
 *
 * So the tool refuses instead of asking. The check is deliberately narrow: it
 * fires only when a message NAMES an issue and carries no link at all, which is
 * exactly the observed failure and nothing else. A greeting is not a report; a
 * report with a link is fine; a report with a link to the wrong thing is not
 * something a string check can know, and pretending otherwise would be the kind
 * of instrument that reports a cause rather than an observation.
 */

/** `#173`, but not `#` inside a word, a colour, or an anchor in a URL. */
const ISSUE_REF = /(^|[\s([])#(\d{1,6})\b/;

/** Any absolute link at all. Markdown or bare — both survive to the phone. */
const HAS_LINK = /https?:\/\/\S+/;

export interface LinkComplaint {
  /** The issue the message named, so the refusal can be specific. */
  ref: string;
  message: string;
}

/**
 * Why this message may not be sent, or undefined when it is fine.
 *
 * Returns the complaint rather than throwing: the caller turns it into the
 * tool's own error shape, and a test can read it without catching.
 */
export function missingIssueLink(text: string): LinkComplaint | undefined {
  const m = ISSUE_REF.exec(text);
  if (!m) return undefined;
  if (HAS_LINK.test(text)) return undefined;
  const ref = `#${m[2]}`;
  return {
    ref,
    message:
      `Refused: this names ${ref} and carries no link. ` +
      `The reader is usually on a phone and cannot type a URL from memory. ` +
      `Include the link to the COMMENT you just wrote — the tracker returns its address when you post ` +
      `(html_url on the created comment) — or, failing that, to the issue. ` +
      `Send it again with the link in it.`,
  };
}
