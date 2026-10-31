// Client servicing in the stored model (docs/PRD.md §5 `processes.kind`,
// `service_servicing`, §6.3.5; issue #19): the recurrence's stored shape, and
// moving between the processes of a workspace (a run of a servicing process
// needs the pipeline it runs beside, and a run of the pipeline its servicing
// processes). Pure, shared by the app, the MCP server and the seed.

import type { Recurrence } from "@transpera-flow/engine";
import type { ProcessBundle, ProcessPart, RecurrenceDriver, RecurrenceJson } from "./types";

/** Most tasks a week or month a fixed recurrence may ask for (the database checks the same). */
export const MAX_RECURRENCE_TIMES = 100;
/** Most ad-hoc requests a month (the database checks the same). */
export const MAX_POISSON_PER_MONTH = 1000;
/** Most tasks a month a driver recurrence may ask for per unit of the driver (the database checks the same). */
export const MAX_DRIVER_PER_MONTH = 1000;
/** Largest `per` of a driver recurrence (the database checks the same). */
export const MAX_DRIVER_PER = 1000000;
/** What a driver recurrence may follow (the database checks the same). */
export const RECURRENCE_DRIVERS: readonly RecurrenceDriver[] = ["words", "links", "techHours", "meetings", "builds", "creativeSets", "channels", "adhoc"];
/** Longest SLA, in working hours (the database checks the same). */
export const MAX_SLA_HOURS = 10000;

const positive = (v: unknown, max: number): v is number => typeof v === "number" && Number.isFinite(v) && v > 0 && v <= max;

/**
 * A stored recurrence, if well formed: exactly `{every: "week"|"month",
 * times}`, `{poisson_per_month}` or `{perMonth, driver, per?}` (follows a
 * tier deliverable). Mirrors the database's `private.is_recurrence` check.
 */
export function parseRecurrence(v: unknown): RecurrenceJson | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const r = v as Record<string, unknown>;
  const keys = Object.keys(r).sort().join(",");
  if (keys === "every,times" && (r.every === "week" || r.every === "month") && positive(r.times, MAX_RECURRENCE_TIMES)) {
    return { every: r.every, times: r.times };
  }
  if (keys === "poisson_per_month" && positive(r.poisson_per_month, MAX_POISSON_PER_MONTH)) {
    return { poisson_per_month: r.poisson_per_month };
  }
  if ((keys === "driver,perMonth" || keys === "driver,per,perMonth") && RECURRENCE_DRIVERS.includes(r.driver as RecurrenceDriver) && positive(r.perMonth, MAX_DRIVER_PER_MONTH)) {
    if (!("per" in r)) return { perMonth: r.perMonth, driver: r.driver as RecurrenceDriver };
    if (positive(r.per, MAX_DRIVER_PER)) return { perMonth: r.perMonth, driver: r.driver as RecurrenceDriver, per: r.per };
  }
  return null;
}

/** The engine's recurrence for a stored one (numbers may arrive as strings from `pg`). */
export function engineRecurrence(v: unknown): Recurrence | null {
  const numeric = (x: unknown) => (typeof x === "string" && x.trim() !== "" ? Number(x) : x);
  const raw = v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  if (!raw) return null;
  const r = parseRecurrence(
    "times" in raw
      ? { ...raw, times: numeric(raw.times) }
      : "poisson_per_month" in raw
        ? { ...raw, poisson_per_month: numeric(raw.poisson_per_month) }
        : "perMonth" in raw
          ? { ...raw, perMonth: numeric(raw.perMonth), ..."per" in raw ? { per: numeric(raw.per) } : {} }
          : raw,
  );
  if (!r) return null;
  if ("perMonth" in r) return r.per === undefined ? { perMonth: r.perMonth, driver: r.driver } : { perMonth: r.perMonth, driver: r.driver, per: r.per };
  return "poisson_per_month" in r ? { poissonPerMonth: r.poisson_per_month } : { every: r.every, times: r.times };
}

/** A bundle's own process as a part (its revision's steps and edges). */
export function partOf(bundle: ProcessBundle): ProcessPart {
  return { process: bundle.process, revision: bundle.revision, steps: bundle.steps, edges: bundle.edges };
}

/**
 * The same workspace's run seen from another of its processes: the bundle
 * for `processId` (one of `bundle.otherProcesses`), whose other processes are
 * this bundle's own and the rest. Null if the workspace has no such process
 * in the bundle. Used by the demo, where every process comes from one bundle.
 */
export function bundleForProcess(bundle: ProcessBundle, processId: string): ProcessBundle | null {
  if (bundle.process.id === processId) return bundle;
  const others = bundle.otherProcesses ?? [];
  const part = others.find((p) => p.process.id === processId);
  if (!part) return null;
  return {
    ...bundle,
    process: part.process,
    revision: part.revision,
    steps: part.steps,
    edges: part.edges,
    retired: [],
    otherProcesses: [partOf(bundle), ...others.filter((p) => p !== part)],
  };
}

/** The workspace's processes a bundle knows of (its own first, then the others in their order). */
export function processesOf(bundle: ProcessBundle): ProcessPart["process"][] {
  return [bundle.process, ...(bundle.otherProcesses ?? []).map((p) => p.process)];
}
