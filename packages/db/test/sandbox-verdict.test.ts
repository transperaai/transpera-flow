import { describe, expect, test } from "vitest";
import { peakOver, verdict, verdictText, type PlaySeries, type VerdictContext } from "../src";
import type { HiringAdvice } from "../src";

// The verdict, hand-checked on small literal series (three months where the prototype used twelve; `last` is the final month).

const ctx: VerdictContext = { monthNames: ["Nov", "Dec", "Jan"], money: (v) => `$${Math.round(v).toLocaleString("en-US")}` };

const advice = (roleId: string, name: string, overFrom: number | null, delay = 2): HiringAdvice => ({ roleId, name, line: 0.85, overFrom, hireBy: overFrom === null ? null : overFrom - delay, series: [] });
const person = (id: string, name: string, busy: (number | null)[], line = 0.85) => ({ id, name, line, busy });

const today: PlaySeries = {
  clients: [100, 100, 100],
  retainers: [200_000, 200_000, 200_000],
  dler: [3.2, 3.2, 3.2],
  advice: [advice("pmm", "Performance managers", 2), advice("links", "Link builders", null), advice("mgr", "SEO managers", 1)],
  people: [person("ann", "Ann", [0.7, 0.8, 0.9]), person("bo", "Bo", [0.5, 0.5, 0.5]), person("cy", "Cy", [0.9, 0.9, 0.9])],
};

describe("verdict", () => {
  test("the first line gives clients, retainers and DLER at the last month against today's path", () => {
    const run: PlaySeries = { ...today, clients: [100, 104, 110], retainers: [200_000, 210_000, 232_000], dler: [3.2, 3.3, 3.55] };
    const [first] = verdict(today, run, ctx);
    expect(verdictText(first!)).toBe("By Jan: 110 clients (+10 against today's path), retainers $232,000 a month (+$32,000), DLER 3.6 (3.2 on today's path).");
    // The numbers are bold, the rest plain.
    expect(first!.filter((s) => s.bold).map((s) => s.text)).toEqual(["Jan", "110 clients", "$232,000", "3.6"]);
  });

  test("fewer clients and less money read as a minus", () => {
    const run: PlaySeries = { ...today, clients: [100, 98, 95], retainers: [200_000, 190_000, 185_000], dler: [3.2, 3, 2.9] };
    expect(verdictText(verdict(today, run, ctx)[0]!)).toBe("By Jan: 95 clients (−5 against today's path), retainers $185,000 a month (−$15,000), DLER 2.9 (3.2 on today's path).");
  });

  test("with pay hidden there is no DLER in the line", () => {
    const run: PlaySeries = { ...today, dler: [null, null, null] };
    expect(verdictText(verdict({ ...today, dler: [null, null, null] }, run, ctx)[0]!)).toBe("By Jan: 100 clients (+0 against today's path), retainers $200,000 a month (+$0).");
  });

  test("a team that goes over its line sooner is flagged with when to hire; one that was already over later says when it was", () => {
    // Performance managers: over from month 1 (was 2); SEO managers: over from month 0 (was 1). Link builders: still never.
    const run: PlaySeries = { ...today, advice: [advice("pmm", "Performance managers", 1), advice("links", "Link builders", null), advice("mgr", "SEO managers", 0)] };
    const lines = verdict(today, run, ctx).map(verdictText);
    // Earliest first: SEO managers from Nov (straight away), hiring by -2: now. Performance managers from Dec, hire by Nov-1 = -1: now.
    expect(lines[1]).toBe("SEO managers: over the line straight away (Dec on today's path). Start hiring now.");
    expect(lines[2]).toBe("Performance managers: over the line from Dec (Jan on today's path). Start hiring now.");
  });

  test("hire by is the month over the line minus the hiring delay", () => {
    const base: PlaySeries = { ...today, advice: [advice("pmm", "Performance managers", null)] };
    const run: PlaySeries = { ...today, advice: [advice("pmm", "Performance managers", 4, 2)] };
    const long = { monthNames: ["Nov", "Dec", "Jan", "Feb", "Mar"], money: ctx.money };
    // Over from Mar (index 4), a 2-month delay: hire by Jan.
    expect(verdictText(verdict({ ...base, clients: [1, 1, 1, 1, 1], retainers: [1, 1, 1, 1, 1], dler: [1, 1, 1, 1, 1] }, { ...run, clients: [1, 1, 1, 1, 1], retainers: [1, 1, 1, 1, 1], dler: [1, 1, 1, 1, 1] }, long)[1]!)).toBe(
      "Performance managers: over the line from Mar. Start hiring by Jan.",
    );
  });

  test("a team over its line today and not now is named as no longer over", () => {
    const run: PlaySeries = { ...today, advice: [advice("pmm", "Performance managers", null), advice("links", "Link builders", null), advice("mgr", "SEO managers", null)] };
    const lines = verdict(today, run, ctx).map(verdictText);
    expect(lines[1]).toBe("Performance managers, SEO managers: no longer over the line (over from Jan, Dec on today's path).");
  });

  test("a team that is no worse than on today's path is not flagged", () => {
    const lines = verdict(today, today, ctx).map(verdictText);
    expect(lines.some((l) => l.includes("Start hiring"))).toBe(false);
    expect(lines.some((l) => l.includes("no longer over"))).toBe(false);
  });

  test("people who go over sooner are named with their month; people relieved are named too", () => {
    // Bo goes over from Dec (never before). Ann was over from Jan, now from Nov. Cy was over all along, now never.
    const run: PlaySeries = {
      ...today,
      people: [person("ann", "Ann", [0.9, 0.9, 0.9]), person("bo", "Bo", [0.5, 0.9, 0.9]), person("cy", "Cy", [0.6, 0.6, 0.6])],
    };
    const lines = verdict(today, run, ctx).map(verdictText);
    expect(lines).toContain("Ann (Nov), Bo (Dec) go over their line sooner than on today's path.");
    expect(lines).toContain("Cy no longer go over their line.");
  });

  test("more than five people over sooner are cut to five and counted", () => {
    const many = (busy: number) => Array.from({ length: 8 }, (_, i) => person(`p${i}`, `P${i}`, [busy, busy, busy]));
    const lines = verdict({ ...today, people: many(0.5) }, { ...today, people: many(0.9) }, ctx).map(verdictText);
    expect(lines).toContain("P0 (Nov), P1 (Nov), P2 (Nov), P3 (Nov), P4 (Nov) and 3 more go over their line sooner than on today's path.");
  });

  test("a person is over at their own line, not a global one, and not when they aren't there", () => {
    const run: PlaySeries = { ...today, people: [person("ann", "Ann", [0.7, null, null], 0.7), person("bo", "Bo", [0.9, 0.9, 0.9], 0.95)] };
    expect(peakOver(run.people)).toBe(1);
    expect(peakOver([])).toBe(0);
  });

  test("the last line counts the worst month's people over their line", () => {
    const run: PlaySeries = { ...today, people: [person("ann", "Ann", [0.9, 0.9, 0.5]), person("bo", "Bo", [0.5, 0.9, 0.9]), person("cy", "Cy", [0.5, 0.9, 0.5])] };
    const lines = verdict(today, run, ctx).map(verdictText);
    // Today: Ann and Cy are over in Jan and Cy from Nov... today's peak: Ann 0.9 (Jan), Cy 0.9 (all) -> 2 in Jan. The run's worst month is Dec: all three.
    expect(lines.at(-1)).toBe("At the worst month, 3 people are over their line (2 on today's path).");
    expect(verdictText(verdict(today, { ...today, people: [person("a", "A", [0.9, 0.5, 0.5])] }, ctx).at(-1)!)).toBe("At the worst month, 1 person is over their line (2 on today's path).");
  });
});
