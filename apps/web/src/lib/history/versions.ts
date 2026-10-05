// Process history (issue #105, A40): the pure parts. A version is a published revision; its row on the History
// screen says when it went live, who published it, what changed, and (once simulated) its headline numbers.
// No React, no database.

import type { EngineModel, SimulationResult } from "@transpera-flow/engine";

/** How many versions are simulated without being asked, newest first; older ones wait for a click on Run. */
export const AUTO_RUN_VERSIONS = 10;
/** Replications per version: enough for a steady average and a range, quick enough to do ten in a few seconds. */
export const HISTORY_REPS = 20;
/** The same seed for every version, so a change between versions is the process changing, not the dice. */
export const HISTORY_SEED = 1;

const WEEKS_PER_MONTH = 52 / 12;
const WORKING_DAYS_PER_WEEK = 5;

/** What changed since the version before: how many steps and connections were added, removed and changed (moving a step on the canvas is not a change). */
export interface RevisionChanges {
  steps: { added: number; removed: number; changed: number };
  edges: { added: number; removed: number; changed: number };
}

export type AuthorKind = "user" | "mcp" | "system";

/** One published version, as the History table lists it. */
export interface VersionMeta {
  revisionId: string;
  number: number;
  /** The version people are using now. */
  live: boolean;
  publishedAt: string | null;
  authorKind: AuthorKind | null;
  /** A person's name, when the workspace knows it. */
  authorName: string | null;
  changes: RevisionChanges | null;
  /** What a system-made version did, in words ("Added Sales"): only the company map's versions made by sync have one. */
  note?: string | null;
}

/** "Claude (MCP)" for a publish through MCP, else the person's name. */
export function authorLabel(v: Pick<VersionMeta, "authorKind" | "authorName">): string {
  if (v.authorKind === "mcp") return "Claude (MCP)";
  if (v.authorKind === "system") return "System";
  if (v.authorName) return v.authorName;
  // A signed-in person the workspace has no name for, or a version that was there before anyone kept track.
  return v.authorKind === "user" ? "A team member" : "Imported";
}

const noun = (n: number, one: string, many: string) => (n === 1 ? one : many);

/**
 * What changed in a version, in plain words: "3 steps changed, 1 step added, 2 connections removed". `first` is the
 * oldest version, which has nothing to be compared with.
 */
export function describeChanges(changes: RevisionChanges | null, first: boolean): string {
  if (first) return "First version";
  if (!changes) return "Changes weren't recorded";
  const parts: string[] = [];
  const groups = [
    [changes.steps, "step", "steps"],
    [changes.edges, "connection", "connections"],
  ] as const;
  for (const [c, one, many] of groups) {
    for (const [n, verb] of [[c.changed, "changed"], [c.added, "added"], [c.removed, "removed"]] as const) {
      if (n > 0) parts.push(`${n} ${noun(n, one, many)} ${verb}`);
    }
  }
  if (parts.length === 0) return "Nothing changed (published again as it was)";
  const text = parts.join(", ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Reads the counts `revision_history` returns, or null if it isn't that shape. */
export function parseChanges(value: unknown): RevisionChanges | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, Record<string, unknown>>;
  const n = (x: unknown) => (typeof x === "number" && Number.isFinite(x) && x > 0 ? Math.floor(x) : 0);
  const one = (k: "steps" | "edges") => ({ added: n(v[k]?.added), removed: n(v[k]?.removed), changed: n(v[k]?.changed) });
  return { steps: one("steps"), edges: one("edges") };
}

/** A measure with its range: the average and the 10th to 90th percentile band. */
export interface Measure {
  mean: number;
  lo: number;
  hi: number;
}

export type ProcessKind = "pipeline" | "servicing";

/**
 * The two headline numbers of a simulated version, which depend on what the process is. A sales pipeline: wins per
 * month and working days from lead to win. A servicing process: the share of touchpoints done on time, and the
 * share late or missed (null when the workspace has no client roster, so nothing is scheduled).
 */
export interface Headline {
  a: Measure | null;
  b: Measure | null;
}

/** How a kind's two measures are named and explained on the screen. */
export interface MeasureInfo {
  /** The chart's title. */
  title: string;
  /** Column heading in the table. */
  column: string;
  /** What the axis counts, for the screen-reader summary. */
  unit: string;
  /** Written after a number in the table. */
  suffix: string;
  help: { description: string; example: string };
}

export const MEASURES: Record<ProcessKind, [MeasureInfo, MeasureInfo]> = {
  pipeline: [
    {
      title: "New clients won per month, by version",
      column: "Wins / mo",
      unit: "wins per month",
      suffix: "",
      help: {
        description:
          "New clients won per month when this version's process is simulated, the same way the map does it. The line is the average and the band is the range across the simulated runs.",
        example: "4.2 with a band of 3.1 to 5.6 means about four new clients a month, and a good or bad stretch could give anywhere from three to nearly six.",
      },
    },
    {
      title: "Lead to win, days, by version",
      column: "Lead to win",
      unit: "days",
      suffix: " d",
      help: {
        description: "Working days from a lead arriving to the deal being won. The line is the average; the band runs from a typical lead to a slow one.",
        example: "19 days with a band of 14 to 31 means most deals close in about two to three weeks, and the slow ones take over a month.",
      },
    },
  ],
  servicing: [
    {
      title: "Client work done on time, %, by version",
      column: "On time",
      unit: "percent on time",
      suffix: "%",
      help: {
        description:
          "Of the client touchpoints scheduled in the projection (reports, check-ins), the share done within their target time. The line is the average and the band is the range across the simulated runs. It needs clients entered in your settings.",
        example: "92% with a band of 85 to 97 means about nine in ten touchpoints are on time, and a bad stretch could drop it to 85.",
      },
    },
    {
      title: "Late or missed, %, by version",
      column: "Late or missed",
      unit: "percent late or missed",
      suffix: "%",
      help: {
        description: "The share of touchpoints that were done late or not done at all: the other side of on time.",
        example: "8% means roughly one touchpoint in twelve slipped.",
      },
    },
  ],
};

/** Reads a run into the kind's two measures. Wins are scaled from the run's horizon to a month; cycle hours to working days. */
export function headlineOf(result: SimulationResult, model: Pick<EngineModel, "horizonWeeks" | "hoursPerWeek">, kind: ProcessKind = "pipeline"): Headline {
  if (kind === "servicing") {
    const t = result.kpi.touchpoints;
    const total = t ? t.onTime.mean + t.late.mean + t.missed.mean : 0;
    if (!t || total <= 0) return { a: null, b: null };
    const pct = (v: number) => Math.min(100, Math.max(0, (v / total) * 100));
    const on = { mean: pct(t.onTime.mean), lo: pct(t.onTime.p10), hi: pct(t.onTime.p90) };
    return { a: on, b: { mean: 100 - on.mean, lo: 100 - on.hi, hi: 100 - on.lo } };
  }
  const perMonth = WEEKS_PER_MONTH / model.horizonWeeks;
  const won = result.kpi.won;
  const day = model.hoursPerWeek / WORKING_DAYS_PER_WEEK;
  const c = result.kpi.cycle;
  return {
    a: { mean: won.mean * perMonth, lo: won.p10 * perMonth, hi: won.p90 * perMonth },
    // The cycle's spread is reported as the median and the 90th percentile: the band runs from a typical lead to a slow one.
    b: { mean: c.mean / day, lo: Math.min(c.mean, c.p50) / day, hi: Math.max(c.mean, c.p90) / day },
  };
}

/** The versions to simulate without being asked: the newest `cap`, newest first. */
export function autoRunIds(versions: readonly Pick<VersionMeta, "revisionId" | "number">[], cap = AUTO_RUN_VERSIONS): string[] {
  return [...versions].sort((a, b) => b.number - a.number).slice(0, cap).map((v) => v.revisionId);
}

/** How a version's numbers stand. */
export type RunEntry = { status: "running" } | { status: "done"; headline: Headline } | { status: "error"; message: string };

/** The version names for a chart's axis, oldest first: v1, v2, ... */
export const versionLabel = (n: number) => `v${n}`;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "29 Sep 2026", in UTC so the server and the browser print the same day (and the same month name, whatever the locale data). */
export function formatPublished(iso: string | null): string {
  if (!iso) return "–";
  const d = new Date(iso);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}
