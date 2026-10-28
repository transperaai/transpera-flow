// "Why did that get worse?" for the Sandbox's "With this scenario" summary. A scenario that fills a role or a person (to 100% busy)
// can lose clients and wins, which looks like the scenario is bad rather than that someone is full. This says so in plain words,
// from numbers a scenario's run already has (its month-by-month busy shares, clients lost and wins, and the same for the live
// forecast): no run is added. Pure: no React.

import type { MonthlyResult, MonthBusy } from "@transpera-flow/engine";

/** A role or person counts as full at this share of busy or more (the engine tops out just under 100% with overtime). */
export const FULL_SHARE = 0.98;

export interface FullExplanation {
  /** The whole sentence. */
  text: string;
  /** The role to offer a hire for: the role itself, or the first role of the person who is full. */
  hireRoleId: string | null;
  /** The index of the month it first is full in, for the hire to start from. */
  month: number;
}

export interface ExplainInput {
  live: Pick<MonthlyResult, "roles" | "people" | "clientsLost" | "sales">;
  scenario: Pick<MonthlyResult, "roles" | "people" | "clientsLost" | "sales">;
  /** The months' names, "March 2027", as the scenario's run has them. */
  monthNames: readonly string[];
  roles: Readonly<Record<string, { name: string }>>;
  /** The people the reader may see by name (a Viewer's own row only), with their roles. */
  people: Readonly<Record<string, { name: string; roles: readonly string[] }>>;
  /** At most this many sentences (default 2). */
  limit?: number;
}

const firstFull = (series: readonly (MonthBusy | null)[] | undefined): number => (series ? series.findIndex((m) => m !== null && m.mean >= FULL_SHARE) : -1);
const total = (stats: readonly { mean: number }[]) => stats.reduce((sum, s) => sum + s.mean, 0);
const lowerFirst = (s: string) => (s.length > 1 && s[1] === s[1]!.toUpperCase() && s[1] !== s[1]!.toLowerCase() ? s : s.charAt(0).toLowerCase() + s.slice(1));

/** What got worse: "more clients leave (38 against 26 with no changes)" and/or "fewer deals are won (41 against 52 with no changes)"; empty when neither did. */
export function worsePhrases(live: ExplainInput["live"], scenario: ExplainInput["scenario"]): string[] {
  const lostS = total(scenario.clientsLost);
  const lostL = total(live.clientsLost);
  const wonS = total(scenario.sales.won);
  const wonL = total(live.sales.won);
  const phrases: string[] = [];
  // Worse by at least one when rounded, and by a twentieth or more, so a wobble between runs is not read as an effect.
  if (Math.round(lostS) - Math.round(lostL) >= 1 && lostS - lostL >= 0.05 * lostL) phrases.push(`more clients leave (${Math.round(lostS)} against ${Math.round(lostL)} with no changes)`);
  if (Math.round(wonL) - Math.round(wonS) >= 1 && wonL - wonS >= 0.05 * wonL) phrases.push(`fewer deals are won (${Math.round(wonS)} against ${Math.round(wonL)} with no changes)`);
  return phrases;
}

/**
 * One sentence per role or person the scenario fills (or fills sooner than the live forecast does) when clients leave more or wins
 * fall: "The strategist role is full from March 2027, so new work waits and more clients leave (38 against 26 with no changes)."
 * Roles first, earliest month first; a person is left out when their role is already named. Empty when nothing got worse.
 */
export function explainFull(input: ExplainInput): FullExplanation[] {
  const worse = worsePhrases(input.live, input.scenario);
  if (!worse.length) return [];
  const limit = input.limit ?? 2;
  const found: (FullExplanation & { subject: string; at: number; person: boolean })[] = [];
  const sooner = (live: readonly (MonthBusy | null)[] | undefined, scenario: readonly (MonthBusy | null)[] | undefined) => {
    const f = firstFull(scenario);
    if (f < 0) return -1;
    const l = firstFull(live);
    return l >= 0 && l <= f ? -1 : f;
  };
  const named = new Set<string>();
  for (const [id, role] of Object.entries(input.roles)) {
    const f = sooner(input.live.roles[id], input.scenario.roles[id]);
    if (f < 0) continue;
    named.add(id);
    found.push({ subject: `The ${lowerFirst(role.name)} role`, hireRoleId: id, month: f, at: f, person: false, text: "" });
  }
  for (const [id, person] of Object.entries(input.people)) {
    const f = sooner(input.live.people[id], input.scenario.people[id]);
    if (f < 0 || person.roles.some((r) => named.has(r))) continue;
    found.push({ subject: person.name, hireRoleId: person.roles[0] ?? null, month: f, at: f, person: true, text: "" });
  }
  found.sort((a, b) => a.at - b.at || Number(a.person) - Number(b.person));
  return found.slice(0, limit).map(({ subject, hireRoleId, month }) => ({
    text: `${subject} is full from ${input.monthNames[month] ?? "a later month"}, so new work waits and ${worse.join(" and ")}.`,
    hireRoleId,
    month,
  }));
}
