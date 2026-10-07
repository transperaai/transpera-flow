// What counts as a money amount in text, in one place: B20's `propose_finding` check (packages/mcp) and a share link's redaction
// (share.ts) both use it, so the two can't drift.

// English ("1,234.50") and European ("1.234,50") digit grouping.
const NUMBER = String.raw`\d{1,3}(?:[.,]\d{3})+(?:[.,]\d+)?|\d+(?:[.,]\d+)?`;
const SUFFIX = String.raw`(?:bn\b|[kKmM]\b)?`;
// £ $ €, or up to three capitals before a dollar sign (A$, NZ$, US$, HK$, AU$...).
const SYMBOL = String.raw`(?:[A-Z]{1,3}\$|[£$€])`;
const SIGN = String.raw`[£$€]`;
const CODE = String.raw`(?:GBP|USD|EUR|AUD|NZD|CAD)`;

const source = (number: string) =>
  String.raw`(?<![A-Za-z0-9])(?:${SYMBOL}|${CODE})\s?(?:${number})${SUFFIX}|(?<![\d,.A-Za-z$£€])(?:${number})${SUFFIX}\s?(?:${CODE}(?![A-Za-z])|${SIGN})`;

/** A symbol or code before the number ("£1,234", "US$12.5k", "EUR 40"), or a symbol or code after it ("4,512€", "1,200 GBP"). */
export const MONEY_SOURCE = source(NUMBER);

/** A new global matcher for money amounts (a regex with the `g` flag keeps state, so each use gets its own). */
export const moneyRegex = (): RegExp => new RegExp(MONEY_SOURCE, "g");

// A share link's text is normalised first (every space a plain one, lower case), and its money check must refuse at least what the
// database's does (`private.share_snapshot_problem`), so this is B20's idea widened: any symbol next to a digit, an amount in
// words, a space before the magnitude, French thousands ("4 512 €"), and no left boundary on an amount that ends in a code.
const SPACED = String.raw`\d+(?:\.\d+)?e[+-]?\d+|\d{1,3}(?: \d{3})+(?:[.,]\d+)?|\d[\d.,]*`;
const SIGNS = String.raw`[£$€¥₹]`;
const MAG = String.raw`(?:\s*(?:bn|[km])\b)?`;
const ISO = String.raw`(?:gbp|usd|eur|aud|nzd|cad)`;
// A number joined to the code AFTER it by a hyphen or a slash ("4100-GBP", "4100/GBP") is money unless it is the end of a date,
// a version or a standard's or product's number, which are written the same way ("2026-10-06-CAD", "v1.2/EUR", "ISO 4217-GBP",
// "Windows 10-USD", "page 3/GBP"). So the amount right before the code:
//   * is not glued to a letter or a digit, nor to a digit and a dot or comma ("v1.2", the "2" of "1.2"), nor to a digit and a
//     hyphen or slash ("2026-10-06") unless it has 3 or more digits, thousands groups or an exponent (a range's second amount,
//     "4100-4500-GBP"; a date's last part has 1 or 2). A hyphen or slash after a letter or space is a sign ("-4100-GBP") or a
//     separator ("x/4100-GBP"), and counts;
//   * may follow another amount and a hyphen or slash (a range, "4,100-4,500-GBP", "4100/4500/GBP"), hidden as one;
//   * if it is a plain number (no thousands groups, no exponent), is not right after a word of JOIN_STANDARD_WORDS ("iso 4217");
//     if it also has 1 or 2 digits, not right after a word of JOIN_VERSION_WORDS ("windows 10", "v 1.2"), and if it is also whole,
//     not right after a word of JOIN_PLACE_WORDS ("page 3"; "page 12.50-GBP" is money), with only spaces between.
// A space between the number and the code, a code BEFORE the number ("GBP-4100", "GBP/4100") and a symbol are unchanged. Every
// text this rule matches, the rule before it matched (a test runs both). The database's check (`private.share_snapshot_problem`,
// migration 20261224500000) applies the same rule; keep the two equal.
/** Words naming a standard: a plain number of any length after them is its number, not an amount. */
export const JOIN_STANDARD_WORDS: readonly string[] = ["iso", "rfc"];
/** Words naming a product or a version: a plain 1- or 2-digit number after them, whole or decimal ("v 1.2"), is its version. */
export const JOIN_VERSION_WORDS: readonly string[] = [
  "windows", "win", "ios", "android", "macos", "office", "version", "ver", "v", "build", "release", "rev", "revision",
];
/** Words naming a place in a document or a plan: a WHOLE 1- or 2-digit number after them is its number ("page 3"); a decimal is money ("page 12.50"). */
export const JOIN_PLACE_WORDS: readonly string[] = [
  "page", "pages", "p", "pp", "chapter", "ch", "section", "sec", "clause", "para", "paragraph", "article", "appendix", "annex", "row",
  "column", "col", "table", "figure", "fig", "vol", "volume", "part", "phase", "sprint", "ticket", "slide",
];
const notAfter = (words: readonly string[]) => String.raw`(?<!(?:^|[^a-z])(?:${words.join("|")}) +)`;
const SCI = String.raw`\d+(?:\.\d+)?e[+-]?\d+`;
const SPACE_GROUPED = String.raw`\d{1,3}(?: \d{3})+(?:[.,]\d+)?`;
const GROUPED = String.raw`\d{1,3}(?:[.,]\d{3})+(?:[.,]\d+)?`;
/** Any amount: the first of a range. */
const RANGE_FROM = String.raw`${SCI}|${SPACE_GROUPED}|${GROUPED}|\d+(?:[.,]\d+)?`;
/** An amount that can't be a date's last part: grouped, scientific, or 3 or more digits. */
const LONG = String.raw`${SCI}|${SPACE_GROUPED}|(?:${GROUPED})[.,]?|\d{3,}(?:[.,]\d+)?[.,]?`;
/** The amount before the code, with the word exemptions on plain numbers only. */
const JOINED = String.raw`${SCI}|${SPACE_GROUPED}|(?:${GROUPED})[.,]?|${notAfter(JOIN_STANDARD_WORDS)}\d{3,}(?:[.,]\d+)?[.,]?|${notAfter(JOIN_STANDARD_WORDS)}${notAfter(JOIN_VERSION_WORDS)}${notAfter(JOIN_PLACE_WORDS)}\d{1,2}[.,]?|${notAfter(JOIN_STANDARD_WORDS)}${notAfter(JOIN_VERSION_WORDS)}\d{1,2}[.,]\d+[.,]?`;
const TO_CODE = String.raw`${MAG}\s*[\-/]\s*${ISO}(?![a-z0-9])`;

/** Money in a share link's normalised text: a symbol or code before a number, a number before a symbol, code or amount in words (pounds, dollars, euros, quid, sterling). */
export const shareMoneyRegex = (): RegExp =>
  new RegExp(
    [
      String.raw`(?<![a-z0-9])(?:[a-z]{1,3}\$|${SIGNS}|${ISO}|rs\.?)[\s\-/]*(?:${SPACED})${MAG}(?![a-z0-9])`,
      String.raw`${SIGNS}\s*\d[\d.,]*`,
      String.raw`(?:${SPACED})${MAG}\s*[£€¥₹]`,
      // A code after the number is a standalone token: not a digit run glued to letters inside something longer.
      String.raw`(?<![a-z0-9])(?:${SPACED})${MAG}\s*${ISO}(?![a-z0-9])`,
      // The same joined by a hyphen or a slash (above): an amount, or a range, not glued to a letter, a digit or a digit's . , - /.
      String.raw`(?<![a-z0-9])(?<!\d[.,])(?<!\d[\-/])(?:(?:${RANGE_FROM})${MAG}\s*[\-/]\s*)?(?:${JOINED})${TO_CODE}`,
      // ... or glued to a digit and a hyphen or slash when it can't be a date's last part (a range's second amount).
      String.raw`(?<=\d[\-/])(?:${LONG})${TO_CODE}`,
      String.raw`(?:${SPACED})${MAG}\s*(?:pounds?|dollars?|euros?|quid|sterling)(?![a-z])`,
    ].join("|"),
    "giu",
  );
