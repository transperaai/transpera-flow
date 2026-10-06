// Pure checks for `propose_finding` (issue #197, B20). No database, no engine: the tool applies them to what Claude wrote
// before anything is stored. They keep two promises: a finding states no money except as a cited fact states it (members
// and viewers get no pay data, #30), and a quote is really a passage of its source.

/** A label the app uses for a person ("Team member A", "Team member 27"). Claude must write names, not these. */
const LABEL_IN_TEXT = /\bTeam member (?:[A-Z]|\d{1,4})\b/;

/** True when any of the texts already holds a "Team member X" label (it would be read as whoever holds that letter). */
export const hasLabel = (texts: readonly string[]): boolean => texts.some((t) => LABEL_IN_TEXT.test(t));

const NUMBER = String.raw`\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?`;
const SUFFIX = String.raw`(?:bn\b|[kKmM]\b)?`;
const SYMBOL = String.raw`(?:A\$|NZ\$|C\$|[£$€])`;
const CODE = String.raw`(?:GBP|USD|EUR|AUD|NZD|CAD)`;
// A symbol or code before the number ("£1,234", "$12.5k", "EUR 40"), or a code after it ("1,200 GBP").
const MONEY = new RegExp(
  String.raw`(?<![A-Za-z0-9])(?:${SYMBOL}|${CODE})\s?(?:${NUMBER})${SUFFIX}|(?<![\d,.A-Za-z$£€])(?:${NUMBER})${SUFFIX}\s?${CODE}(?![A-Za-z])`,
  "g",
);

/** Every money amount in the text, normalised (lower case, no spaces): "£1,234" -> "£1,234", "1,200 GBP" -> "1,200gbp". */
export function moneyFigures(text: string): string[] {
  return [...text.matchAll(MONEY)].map((m) => m[0].toLowerCase().replace(/\s+/g, ""));
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
