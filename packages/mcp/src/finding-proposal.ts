// Pure checks for `propose_finding` (issue #197, B20). No database, no engine: the tool applies them to what Claude wrote
// before anything is stored. They keep two promises: a finding states no money except as a cited fact states it (members
// and viewers get no pay data, #30), and a quote is really a passage of its source.

import { moneyRegex } from "@transpera-flow/db";

/** A label the app uses for a person ("Team member A", "Team member 27"). Claude must write names, not these. */
const LABEL_IN_TEXT = /\bTeam member (?:[A-Z]|\d{1,4})\b/;

/** True when any of the texts already holds a "Team member X" label (it would be read as whoever holds that letter). */
export const hasLabel = (texts: readonly string[]): boolean => texts.some((t) => LABEL_IN_TEXT.test(t));

// The pattern lives in packages/db (src/money.ts) so a share link's redaction uses the same one.

/** Every money amount in the text, normalised (lower case, no spaces): "£1,234" -> "£1,234", "1,200 GBP" -> "1,200gbp". */
export function moneyFigures(text: string): string[] {
  return [...text.matchAll(moneyRegex())].map((m) => m[0].toLowerCase().replace(/\s+/g, ""));
}

/** The money figures of `texts` that no text of `factTexts` states, in the order found, each once. */
export function unsupportedMoney(texts: readonly string[], factTexts: readonly string[]): string[] {
  const allowed = new Set(factTexts.flatMap(moneyFigures));
  const out: string[] = [];
  for (const t of texts) {
    for (const f of moneyFigures(t)) if (!allowed.has(f) && !out.includes(f)) out.push(f);
  }
  return out;
}

/** As `squeeze` in apps/web/src/lib/ai/facts.ts (copied: this package doesn't import from the app): lower case, straight quotes, one space, trimmed. */
export const squeeze = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ")
    .trim();

/** True when `quote` (at least 10 characters) is a passage of `body`, ignoring case, quote style and spacing. */
export function quoteIn(body: string, quote: string): boolean {
  const q = squeeze(quote);
  return q.length >= 10 && squeeze(body).includes(q);
}

/**
 * A title as the database's key reads it (`private.findings_before_write`, migration 20261212000000): Unicode NFKC (a
 * no-break space becomes a space), curly quotes straightened, lower case, white space to one space, trailing punctuation and
 * spaces dropped. Two titles with the same key are the same proposal.
 */
export function titleKey(title: string): string {
  return title
    .normalize("NFKC")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[\]).!?,;:'"–—-]+$/, "")
    .trim();
}
