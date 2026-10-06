import { describe, expect, it } from "vitest";
import { hasLabel, moneyFigures, quoteIn, titleKey, unsupportedMoney } from "../src/finding-proposal";

// Pure checks behind propose_finding (issue #197, B20).

describe("moneyFigures", () => {
  it("finds amounts with a symbol or a code, either side", () => {
    expect(moneyFigures("It costs £1,234 a month, or $12.5k a year.")).toEqual(["£1,234", "$12.5k"]);
    expect(moneyFigures("About 1,200 GBP and EUR 40, A$900, NZ$5m, C$3.50, USD 2bn.")).toEqual(["1,200gbp", "eur40", "a$900", "nz$5m", "c$3.50", "usd2bn"]);
    expect(moneyFigures("€1.2M of work")).toEqual(["€1.2m"]);
  });

  it("finds a symbol after the number, European style, and prefixes like US$", () => {
    expect(moneyFigures("About 4,512€ a month")).toEqual(["4,512€"]);
    expect(moneyFigures("4.512 € a month")).toEqual(["4.512€"]);
    expect(moneyFigures("US$4,512 and HK$ 30 and AU$12k")).toEqual(["us$4,512", "hk$30", "au$12k"]);
    expect(moneyFigures("5 $ and 7£")).toEqual(["5$", "7£"]);
    expect(unsupportedMoney(["4,512€"], ["Costs €4,512"])).toEqual(["4,512€"]);
  });

  it("ignores hours, percentages, days and bare numbers", () => {
    expect(moneyFigures("12 hours, 40%, 3 days, 1,200 proposals, week 52, 7.5 hours a week")).toEqual([]);
  });

  it("does not take a letter-led word or a suffix glued to a word as an amount's suffix", () => {
    expect(moneyFigures("£5 more")).toEqual(["£5"]);
    expect(moneyFigures("£5months")).toEqual(["£5"]);
    expect(moneyFigures("PRICEUSD 5")).toEqual([]);
  });
});

describe("unsupportedMoney", () => {
  const facts = ["Strategist is overloaded. Costing about £1,234 a month in overtime.", "Queue of 14 days."];
  it("passes a figure that a cited fact states, ignoring case and spaces", () => {
    expect(unsupportedMoney(["Overtime of £1,234 hurts", "Also GBP 5"], [...facts, "Spent GBP 5 more"])).toEqual([]);
    expect(unsupportedMoney(["It's  £1,234."], facts)).toEqual([]);
  });

  it("refuses one that isn't there, once each and in order", () => {
    expect(unsupportedMoney(["£9,999 lost, then £9,999 again and $5k", "and £1,234 fine"], facts)).toEqual(["£9,999", "$5k"]);
  });

  it("refuses everything when no fact states money", () => {
    expect(unsupportedMoney(["£1"], [])).toEqual(["£1"]);
  });
});

describe("hasLabel", () => {
  it("spots Team member labels", () => {
    expect(hasLabel(["Team member B is busy"])).toBe(true);
    expect(hasLabel(["x", "Team member 27 too"])).toBe(true);
    expect(hasLabel(["A team member is busy", "Team members differ", "Team member Alice"])).toBe(false);
  });
});

describe("quoteIn", () => {
  const body = "Priya: “We don’t   check the\nproposal until Friday,” she said.";
  it("matches ignoring case, curly quotes and spacing", () => {
    expect(quoteIn(body, `we don't check the proposal until friday`)).toBe(true);
    expect(quoteIn(body, "“We don’t check the proposal until Friday,”")).toBe(true);
  });

  it("refuses a passage that isn't there, and one under 10 characters", () => {
    expect(quoteIn(body, "we never check the proposal")).toBe(false);
    expect(quoteIn(body, "until Fri")).toBe(false);
    expect(quoteIn("short text here", "short text")).toBe(true);
    expect(quoteIn("Priya said hello", "Priya")).toBe(false);
  });
});

describe("titleKey", () => {
  it("is the same for titles that differ only in case, spacing, quote style or trailing punctuation", () => {
    const k = titleKey("Proposals don't wait too long");
    for (const t of ["Proposals don't wait too long.", "proposals don\u2019t\u00a0wait   too long", "  PROPOSALS DON'T WAIT TOO LONG\u2026", "Proposals don't wait too long?!"]) expect(titleKey(t), t).toBe(k);
    expect(titleKey("Proposals wait too long")).not.toBe(k);
  });
});
