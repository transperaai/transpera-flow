// "What happens": the free-play Sandbox's plain-English verdict (capacity build P7, docs/plans/capacity/p7-sandbox-brief.md section 4;
// the prototype's `verdict`, docs/prototypes/client-capacity-app.PROTOTYPE.html).
//
// Pure functions over two `PlaySeries`, today's path and the changed path, each read from an engine run by `playSeries`
// (./sandbox-play-series.ts), which uses P5's `dler`, `busyShares` and `hiringAdvice`: nothing about DLER, busy share or when a team goes over
// its line is worked out again here. Each line comes back as segments (bold, flag, ok), never HTML.
//
// Lines, in order:
//   1. By the last month: clients, retainers a month and DLER, each against today's path.
//   2. Teams that go over their line sooner than on today's path (up to three), when, and when to start hiring.
//   3. Teams no longer over their line.
//   4. People who go over their line sooner (up to five), and 5. people relieved of it.
//   6. At the worst month, how many people are over their line.

import type { HiringAdvice } from "./capacity-figures";

/** One person's busy share by month, against their own line. */
export interface PlayPersonSeries {
  id: string;
  name: string;
  line: number;
  /** Mean busy share per month; null when they aren't there that month. */
  busy: (number | null)[];
}

/** What the verdict needs of one run. All arrays are one entry per month. */
export interface PlaySeries {
  /** Clients with any service, all departments added up. */
  clients: number[];
  /** Retainers a month, all departments. */
  retainers: number[];
  /** All retainers ÷ all salaries (D24); null when pay is hidden or there are no salaries. */
  dler: (number | null)[];
  /** P5's `hiringAdvice` on this run (per role: the first month over its line, and when to hire by). */
  advice: HiringAdvice[];
  people: PlayPersonSeries[];
}

export interface VerdictSegment {
  text: string;
  bold?: true;
  tone?: "flag" | "ok";
}
export type VerdictLine = VerdictSegment[];

export interface VerdictContext {
  /** Short month names, one per month ("Nov"). */
  monthNames: string[];
  /** How a retainer total reads ("$142.5K"). */
  money: (v: number) => string;
}

const b = (text: string): VerdictSegment => ({ text, bold: true });
const t = (text: string): VerdictSegment => ({ text });
const flag = (text: string): VerdictSegment => ({ text, tone: "flag" });
const ok = (text: string): VerdictSegment => ({ text, tone: "ok" });

const signed = (v: number): string => (v >= 0 ? "+" : "−") + Math.abs(v);
const one = (v: number): string => (Math.round(v * 10) / 10).toFixed(1);
const count = (n: number): string => String(n);

/** The first month a person's busy share reaches their line, or null. */
function firstOver(p: PlayPersonSeries): number | null {
  const i = p.busy.findIndex((v) => v !== null && v >= p.line);
  return i < 0 ? null : i;
}

/** The most people over their line in any one month. */
export function peakOver(people: readonly PlayPersonSeries[]): number {
  const months = Math.max(0, ...people.map((p) => p.busy.length));
  let peak = 0;
  for (let m = 0; m < months; m++) peak = Math.max(peak, people.filter((p) => p.busy[m] != null && p.busy[m]! >= p.line).length);
  return peak;
}

/** The verdict lines: `base` is today's path, `run` the changed one. */
export function verdict(base: PlaySeries, run: PlaySeries, ctx: VerdictContext): VerdictLine[] {
  const last = Math.max(0, Math.min(base.clients.length, run.clients.length) - 1);
  const month = (i: number) => ctx.monthNames[i] ?? `month ${i + 1}`;
  const lines: VerdictLine[] = [];

  // 1. By the last month.
  const dClients = Math.round(run.clients[last]! - base.clients[last]!);
  const dMoney = run.retainers[last]! - base.retainers[last]!;
  const dlerNow = run.dler[last];
  const dlerThen = base.dler[last];
  const first: VerdictLine = [t("By "), b(month(last)), t(": "), b(`${count(Math.round(run.clients[last]!))} clients`), t(` (${signed(dClients)} against today's path), retainers `), b(ctx.money(run.retainers[last]!)), t(` a month (${dMoney >= 0 ? "+" : "−"}${ctx.money(Math.abs(dMoney))})`)];
  if (dlerNow != null) {
    first.push(t(", DLER "), b(one(dlerNow)));
    if (dlerThen != null) first.push(t(` (${one(dlerThen)} on today's path)`));
  }
  first.push(t("."));
  lines.push(first);

  // 2. and 3. Teams over their line.
  const was = new Map(base.advice.map((a) => [a.roleId, a]));
  const now = run.advice.filter((a) => a.overFrom !== null).sort((x, y) => x.overFrom! - y.overFrom! || x.name.localeCompare(y.name));
  const sooner = now.filter((a) => {
    const w = was.get(a.roleId);
    return !w || w.overFrom === null || a.overFrom! < w.overFrom;
  });
  for (const a of sooner.slice(0, 3)) {
    const w = was.get(a.roleId);
    const line: VerdictLine = [flag(`${a.name}: over the line ${a.overFrom === 0 ? "straight away" : "from " + month(a.overFrom!)}`)];
    if (w && w.overFrom !== null) line.push(t(` (${month(w.overFrom)} on today's path)`));
    line.push(t(". " + (a.hireBy! <= 0 ? "Start hiring now." : `Start hiring by ${month(a.hireBy!)}.`)));
    lines.push(line);
  }
  const runOver = new Map(run.advice.map((a) => [a.roleId, a.overFrom]));
  const fixed = base.advice.filter((a) => a.overFrom !== null && (runOver.get(a.roleId) ?? null) === null);
  if (fixed.length) lines.push([ok(`${fixed.map((a) => a.name).join(", ")}: no longer over the line`), t(` (over from ${fixed.map((a) => month(a.overFrom!)).join(", ")} on today's path).`)]);

  // 4. and 5. People.
  const baseOver = new Map(base.people.map((p) => [p.id, firstOver(p)]));
  const runPeople = run.people.map((p) => ({ p, at: firstOver(p) }));
  const newOver = runPeople.filter((x) => {
    const was = baseOver.get(x.p.id) ?? null;
    return x.at !== null && (was === null || x.at < was);
  });
  if (newOver.length) {
    const named = newOver.slice(0, 5).map((x) => `${x.p.name} (${month(x.at!)})`).join(", ");
    lines.push([flag(named + (newOver.length > 5 ? ` and ${newOver.length - 5} more` : "")), t(" go over their line sooner than on today's path.")]);
  }
  const stillOver = new Set(runPeople.filter((x) => x.at !== null).map((x) => x.p.id));
  const relieved = base.people.filter((p) => firstOver(p) !== null && !stillOver.has(p.id));
  if (relieved.length) lines.push([ok(relieved.slice(0, 5).map((p) => p.name).join(", ")), t(" no longer go over their line.")]);

  // 6. The worst month.
  const peakRun = peakOver(run.people);
  const peakBase = peakOver(base.people);
  lines.push([t("At the worst month, "), b(count(peakRun)), t(` ${peakRun === 1 ? "person is" : "people are"} over their line (${peakBase} on today's path).`)]);
  return lines;
}

/** A verdict line as plain text (for the export and for tests). */
export const verdictText = (line: VerdictLine): string => line.map((s) => s.text).join("");
