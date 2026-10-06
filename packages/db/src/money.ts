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

/** Money in a share link's normalised text: a symbol or code before a number, a number before a symbol, code or amount in words (pounds, dollars, euros, quid, sterling). */
export const shareMoneyRegex = (): RegExp =>
  new RegExp(
    [
      String.raw`(?<![a-z0-9])(?:[a-z]{1,3}\$|${SIGNS}|${ISO}|rs\.?)[\s\-/]*(?:${SPACED})${MAG}(?![a-z0-9])`,
      String.raw`${SIGNS}\s*\d[\d.,]*`,
      String.raw`(?:${SPACED})${MAG}\s*[£€¥₹]`,
      // A code after the number is a standalone token: not a digit run glued to letters inside something longer.
      String.raw`(?<![a-z0-9])(?:${SPACED})${MAG}[\s\-/]*${ISO}(?![a-z0-9])`,
      String.raw`(?:${SPACED})${MAG}\s*(?:pounds?|dollars?|euros?|quid|sterling)(?![a-z])`,
    ].join("|"),
    "giu",
  );
