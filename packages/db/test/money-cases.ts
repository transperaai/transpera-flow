// One list of texts for the share link's money rule with Financials off, run through the app (`shareMoneyRegex`: the redaction and
// `shareSnapshotLeaks`) and through the database (`private.share_snapshot_problem`), so the two can't disagree. B3 follow-up (#32):
// a hyphen or a slash between a number and a code after it counts only for a standalone amount.

/** Not money: a date, a version or the number of a standard, a product or a place in a document, joined to a code. Left as written. */
export const MONEY_NOT: readonly { text: string; joinedBy: string }[] = [
  { text: "2026-10-06-CAD", joinedBy: "a date" },
  { text: "ISO 4217-GBP", joinedBy: "a standard's number" },
  { text: "Windows 10-USD build", joinedBy: "a product's version" },
  { text: "v1.2/EUR", joinedBy: "a version" },
  { text: "page 3/GBP", joinedBy: "a place in a document" },
  { text: "release 1.2.3-EUR", joinedBy: "a dotted version" },
  { text: "see section 4/USD and table 2-AUD", joinedBy: "places in a document" },
  { text: "RFC 4217/NZD", joinedBy: "a standard's number" },
];

/** Money: every form the rule hid before the change and must still hide (a code before or after, a symbol, words). */
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
  "4.1k-GBP",
  "4 512-EUR",
  "4100 - GBP",
  "4,100-4,500 GBP",
  "GBP 4,100",
  "about 300/usd",
  "fee: 2,000-CAD",
];
