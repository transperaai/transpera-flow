// What counts as a money amount in text, in one place: B20's `propose_finding` check (packages/mcp) and a share link's redaction
// (share.ts) both use it, so the two can't drift.

// English ("1,234.50") and European ("1.234,50") digit grouping.
const NUMBER = String.raw`\d{1,3}(?:[.,]\d{3})+(?:[.,]\d+)?|\d+(?:[.,]\d+)?`;
const SUFFIX = String.raw`(?:bn\b|[kKmM]\b)?`;
// £ $ €, or up to three capitals before a dollar sign (A$, NZ$, US$, HK$, AU$...).
const SYMBOL = String.raw`(?:[A-Z]{1,3}\$|[£$€])`;
const SIGN = String.raw`[£$€]`;
const CODE = String.raw`(?:GBP|USD|EUR|AUD|NZD|CAD)`;

/** A symbol or code before the number ("£1,234", "US$12.5k", "EUR 40"), or a symbol or code after it ("4,512€", "1,200 GBP"). */
export const MONEY_SOURCE = String.raw`(?<![A-Za-z0-9])(?:${SYMBOL}|${CODE})\s?(?:${NUMBER})${SUFFIX}|(?<![\d,.A-Za-z$£€])(?:${NUMBER})${SUFFIX}\s?(?:${CODE}(?![A-Za-z])|${SIGN})`;

/** A new global matcher for money amounts (a regex with the `g` flag keeps state, so each use gets its own). */
export const moneyRegex = (): RegExp => new RegExp(MONEY_SOURCE, "g");

/** Amounts written in words after a number ("4,100 pounds", "40 euros"): not part of B20's check, added for share links. */
const WORD_AMOUNT = String.raw`(?<![A-Za-z0-9])(?:${NUMBER})${SUFFIX}\s?(?:pounds?|dollars?|euros?)(?![A-Za-z])`;

/** Money in a share link's text: B20's pattern, in any case, plus amounts written in words. */
export const shareMoneyRegex = (): RegExp => new RegExp(`${MONEY_SOURCE}|${WORD_AMOUNT}`, "gi");
