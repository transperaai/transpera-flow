// One list of texts for the share link's money rule with Financials off, run through the app (`shareMoneyRegex`: the redaction and
// `shareSnapshotLeaks`) and through the database (`private.share_snapshot_problem`), so the two can't disagree. B3 follow-up (#32):
// a hyphen or a slash between a number and a code after it no longer counts at the end of a date, a version or a standard's,
// product's or document's number. Every case also runs through the rule on main before this change (`OLD_SHARE_MONEY_SOURCE` here,
// and B4's body of the function in the database): what it refused is still refused, except MONEY_NOT.

/** Not money: exactly the texts the change exempts (Austin, 7 Oct). The rule before refused each; now each is left as written. */
export const MONEY_NOT: readonly { text: string; joinedBy: string }[] = [
  { text: "2026-10-06-CAD", joinedBy: "a date" },
  { text: "ISO 4217-GBP", joinedBy: "a standard's number" },
  { text: "Windows 10-USD", joinedBy: "a product's version" },
  { text: "v1.2/EUR", joinedBy: "a version" },
  { text: "page 3/GBP", joinedBy: "a place in a document" },
];

/** Money: hidden by the app and refused by the database, before the change and after it. */
export const MONEY_YES: readonly string[] = [
  "4100-GBP",
  "GBP-4100",
  "GBP/4100",
  "4100/GBP",
  "1e6 GBP",
  "1.5e3 USD",
  "usd-1e6",
  "1.5e3/USD",
  "£4.1k",
  "4,512€",
  "4,100 quid",
  "costs 4100-GBP a month",
  "4,100.50-EUR",
  "4100,50-EUR",
  "4.1k-GBP",
  "4 512-EUR",
  "4100 - GBP",
  "4,100-4,500 GBP",
  "GBP 4,100",
  "about 300/usd",
  "fee: 2,000-CAD",
  // Negative amounts.
  "-4100-GBP",
  "costs -4100-GBP",
  "-4,100/EUR",
  // Ranges joined by a hyphen or a slash.
  "4,100-4,500-GBP",
  "4100-4500-GBP",
  "from 4100-4500-USD",
  "4100/4500/GBP",
  "06-10-2026-CAD",
  "x2-4100-GBP",
  // Glued to a letter and a separator, or ending in a dot.
  "x/4100-GBP",
  "a,4100-GBP",
  "a.4100-GBP",
  "4100.-GBP",
  // A grouped, scientific or long number after a word: never an identifier.
  "sprint 4,500-GBP",
  "item 4,100-GBP",
  "table 2000-GBP",
  "build 1e6-gbp",
  "line 4100-GBP",
  "model 4100-GBP",
  "page 4100-GBP",
  "page 100/GBP",
  "ISO 4,217-GBP",
  "en 4100-GBP",
  // A decimal after a place word (page, row, part ...): only a whole number there is a place in a document.
  "page 12.50-GBP",
  "row 99,99-EUR",
  "part 1.5/EUR",
  "table 2.5 - AUD",
];

/**
 * Not money either: a rule can't exempt the five texts above without exempting text of the same shape, so these pass too. Each names
 * the exemption it is a variant of. The before-and-after test allows exactly MONEY_NOT and these, nothing else.
 */
export const MONEY_NOT_VARIANTS: readonly { text: string; like: string }[] = [
  { text: "Windows 10 - USD build", like: "Windows 10-USD" },
  { text: "1.2.3-EUR", like: "v1.2/EUR" },
  { text: "release 1.2.3-EUR", like: "v1.2/EUR" },
  { text: "v 1.2/EUR", like: "v1.2/EUR" },
  { text: "see section 4/USD and table 2-AUD", like: "page 3/GBP" },
  { text: "PAGE 3/GBP", like: "page 3/GBP" },
  { text: "RFC 4217/NZD", like: "ISO 4217-GBP" },
  { text: "2026-10-06/CAD", like: "2026-10-06-CAD" },
];

/** More texts for the before-and-after comparison only: neither rule refuses them, or both do. */
export const MONEY_OTHER: readonly string[] = [
  "ref4100GBP",
  "CAD3D",
  "4100GBPx",
  "1e6 rows",
  "Q4-EUR region",
  "EU-27 rollout",
  "pricing in GBP/USD pairs",
  "#2a78d6",
  "Covid-19 cover",
  "2026-10-06 CAD",
  "06/10/2026/GBP",
  "4100–GBP",
  "4 100-GBP",
  "4k-5k-GBP",
];

/** The share money rule on main before this change (packages/db/src/money.ts at bf61be0e), for the before-and-after test. */
const SPACED = String.raw`\d+(?:\.\d+)?e[+-]?\d+|\d{1,3}(?: \d{3})+(?:[.,]\d+)?|\d[\d.,]*`;
const SIGNS = String.raw`[£$€¥₹]`;
const MAG = String.raw`(?:\s*(?:bn|[km])\b)?`;
const ISO = String.raw`(?:gbp|usd|eur|aud|nzd|cad)`;
export const OLD_SHARE_MONEY_SOURCE = [
  String.raw`(?<![a-z0-9])(?:[a-z]{1,3}\$|${SIGNS}|${ISO}|rs\.?)[\s\-/]*(?:${SPACED})${MAG}(?![a-z0-9])`,
  String.raw`${SIGNS}\s*\d[\d.,]*`,
  String.raw`(?:${SPACED})${MAG}\s*[£€¥₹]`,
  String.raw`(?<![a-z0-9])(?:${SPACED})${MAG}[\s\-/]*${ISO}(?![a-z0-9])`,
  String.raw`(?:${SPACED})${MAG}\s*(?:pounds?|dollars?|euros?|quid|sterling)(?![a-z])`,
].join("|");
