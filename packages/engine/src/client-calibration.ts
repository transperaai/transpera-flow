// Calibration of churn and servicing checks from a clients file and a servicing
// log (docs/PRD.md §6.6; issue #41, part 2).
//
// Part 1 (calibration.ts) reads a step log for one process. This reads two
// workspace-wide files and proposes or shows:
//
//   churn     each client group's normal churn, back-solved so that today's
//             simulated churn (normal churn x today's driver pressure) matches
//             the churn measured in the clients file. Measured churn is
//             leavers / client-months over the last 52 weeks before the
//             "counted up to" date: the constant monthly rate that the engine's
//             weekly tick (monthly / 4.33 per client-week) reproduces.
//   checks    the share of servicing work done late or missed, the response
//             time to ad-hoc requests and the onboarding speed, to show beside
//             the simulated values. They are checks only and are never applied.
//
// Back-solving: a client's weekly chance of leaving is base x a x b / 4.33 with
// a = 1 + sum of weight x pressure over the switched-on drivers other than the
// market. With the market taken out (b = 1) and no clamping, 1 / the service's
// "normal" share of blame is exactly the base-weighted mean of a over its
// client-weeks: today's driver pressure multiplier M, so base x M is the churn
// the run gives. The proposal is measured / M, found in at most three more runs
// because M moves a little with the base (fewer clients, less load).
//
// Client ids are used only to count and to join the two files, and never leave
// this module (D27): results carry counts, service names and numbers.
//
// Pure and deterministic: only `backSolveChurn` runs a simulation, and that is
// deterministic too. No clock, no randomness, no logs or exponentials (det-math.ts if ever needed).

import { CALIBRATION_MIN_SAMPLE, type CalibrationProposal, type CalibrationValueSource } from "./calibration";
import { LOAD_WEEKS_PER_MONTH } from "./clients";
import type { EngineChurnDriver } from "./churn-drivers";
import type { EngineModel, SimulationResult } from "./model";
import { simulate } from "./simulate";
import { ENGINE_VERSION } from "./version";

/** Churn is measured over the last 52 weeks before the counted-up-to date ... */
export const CHURN_WINDOW_WEEKS = 52;
/** ... and needs at least 13 weeks of it ... */
export const CHURN_MIN_WEEKS = 13;
/** ... and at least 3 leavers. Fewer clients, tasks, requests or new clients than `CALIBRATION_MIN_SAMPLE` are flagged too. */
export const CHURN_MIN_LEAVERS = 3;
export const CHURN_BACKSOLVE_SEED = 1;
export const CHURN_BACKSOLVE_REPS = 30;
/** Runs after run 0 (today's model). */
export const CHURN_BACKSOLVE_MAX_RUNS = 3;
/** Absolute, on a monthly share. */
export const CHURN_BACKSOLVE_TOLERANCE = 0.0005;

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;

/** One row of the clients file: a client's time on a service. `ended` null: still a client. Times are epoch milliseconds. */
export interface ClientRow {
  client: string;
  service: string;
  started: number;
  ended: number | null;
}

/** One row of the servicing log. `due` is a deadline; `done` null: not done; `requested` null: not logged. */
export interface ServicingRow {
  task: string;
  client: string;
  due: number;
  done: number | null;
  requested: number | null;
}

/** A service as the estimators see it. */
export interface ChurnServiceInput {
  serviceId: string;
  name: string;
  pricingModel: "retainer" | "one_off" | "hourly";
  /** Its client group, if it has one. */
  group: { id: string; churnMonthly: number; count: number; source: CalibrationValueSource } | null;
}

/** A servicing process linked to a service. */
export interface ServicingLinkInput {
  serviceId: string;
  processId: string;
  processName: string;
  slaHours: number;
  /** Comes in as requests (a Poisson recurrence) rather than on a schedule. */
  adhoc: boolean;
}

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

const round = (x: number, dp: number) => {
  const f = 10 ** dp;
  return Math.round(x * f) / f;
};

const fmt = (x: number, dp = 1) => (Number.isInteger(round(x, dp)) ? String(round(x, dp)) : round(x, dp).toFixed(dp));
const pct = (x: number, dp = 1) => `${fmt(x * 100, dp)}%`;

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const dateText = (t: number) => {
  const d = new Date(t);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
};

const tooFew = (n: number, min: number) => `Too few to measure: ${n} of the ${min} needed.`;

/** Names a set of rows by norm: a name two entries share matches none. */
function uniqueByName<T>(items: readonly T[], nameOf: (t: T) => string): Map<string, T | null> {
  const out = new Map<string, T | null>();
  for (const it of items) {
    const k = norm(nameOf(it));
    out.set(k, out.has(k) ? null : it);
  }
  return out;
}

function countUnmatched(names: Iterable<string>): { name: string; rows: number }[] {
  const by = new Map<string, { name: string; rows: number }>();
  for (const name of names) {
    const k = norm(name);
    const u = by.get(k) ?? { name: name.trim(), rows: 0 };
    u.rows++;
    by.set(k, u);
  }
  return [...by.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([, v]) => v);
}

// ---------------------------------------------------------------------------
// Churn measured from the clients file
// ---------------------------------------------------------------------------

export interface MeasuredChurn {
  serviceId: string;
  name: string;
  /** Distinct clients with exposure in the window. */
  clients: number;
  /** Spells that ended inside the window. */
  leavers: number;
  /** Exposure, in client-months. */
  clientMonths: number;
  /** Distinct clients with a spell covering the counted-up-to date (shown beside the group's count). */
  activeAtAsOf: number;
  /** Leavers / client-months; null when blocked. */
  monthly: number | null;
  enough: boolean;
  blocked: string | null;
  note: string;
}

export interface MeasureChurnResult {
  services: MeasuredChurn[];
  window: { from: number; to: number; weeks: number } | null;
  /** Service names in the file that match no active service, with how many rows each. */
  unmatchedServices: { name: string; rows: number }[];
  /** Rows dropped because the client started after the counted-up-to date. */
  startsAfterAsOf: number;
  rows: number;
  /** Distinct clients in the file. */
  clients: number;
}

interface Spell {
  started: number;
  ended: number | null;
}

/** Overlapping or touching spells merged; a gap keeps two. */
function mergeSpells(spells: Spell[]): Spell[] {
  const sorted = [...spells].sort((a, b) => a.started - b.started || (a.ended ?? Infinity) - (b.ended ?? Infinity));
  const out: Spell[] = [];
  for (const s of sorted) {
    const last = out[out.length - 1];
    if (last && (last.ended === null || s.started <= last.ended)) {
      last.ended = last.ended === null || s.ended === null ? null : Math.max(last.ended, s.ended);
    } else out.push({ ...s });
  }
  return out;
}

/** Spells per (client, key), after the asOf clamp, from rows that started on or before it. */
function spellsBy(rows: readonly { client: string; key: string; started: number; ended: number | null }[], asOf: number): Map<string, Map<string, Spell[]>> {
  const out = new Map<string, Map<string, Spell[]>>();
  for (const r of rows) {
    const byClient = out.get(r.key) ?? new Map<string, Spell[]>();
    const list = byClient.get(r.client) ?? [];
    list.push({ started: r.started, ended: r.ended !== null && r.ended > asOf ? null : r.ended });
    byClient.set(r.client, list);
    out.set(r.key, byClient);
  }
  for (const byClient of out.values()) for (const [c, list] of byClient) byClient.set(c, mergeSpells(list));
  return out;
}

/**
 * Normal-churn evidence per service from a clients file: leavers over client-months in the last 52 weeks before
 * `asOf`. Services are matched by name (case and spacing ignored; a name two services share matches neither).
 */
export function measureChurn(input: {
  rows: readonly ClientRow[];
  services: readonly ChurnServiceInput[];
  asOf: number;
  minSample?: number;
}): MeasureChurnResult {
  const minSample = Math.max(1, Math.floor(input.minSample ?? CALIBRATION_MIN_SAMPLE));
  const { asOf } = input;
  const byName = uniqueByName(input.services, (s) => s.name);
  const clientIds = new Set(input.rows.map((r) => r.client));

  const kept = input.rows.filter((r) => r.started <= asOf);
  const startsAfterAsOf = input.rows.length - kept.length;
  const matched: { client: string; key: string; started: number; ended: number | null }[] = [];
  const unmatched: string[] = [];
  for (const r of kept) {
    const sv = byName.get(norm(r.service));
    if (!sv) unmatched.push(r.service);
    else matched.push({ client: r.client, key: sv.serviceId, started: r.started, ended: r.ended });
  }

  const W1 = asOf;
  let earliest = Infinity;
  for (const r of matched) earliest = Math.min(earliest, r.started);
  const W0 = Number.isFinite(earliest) ? Math.max(asOf - CHURN_WINDOW_WEEKS * WEEK_MS, earliest) : null;
  const weeks = W0 === null ? 0 : (W1 - W0) / WEEK_MS;
  const window = W0 === null ? null : { from: W0, to: W1, weeks };
  const spells = spellsBy(matched, asOf);

  const services = input.services.map((sv): MeasuredChurn => {
    const byClient = spells.get(sv.serviceId) ?? new Map<string, Spell[]>();
    let exposureWeeks = 0;
    let leavers = 0;
    let active = 0;
    const exposed = new Set<string>();
    for (const [client, list] of byClient) {
      for (const sp of list) {
        const left = sp.ended !== null && W0 !== null && sp.ended > W0 && sp.ended <= W1;
        const exp = W0 === null ? 0 : Math.max(0, (Math.min(sp.ended ?? W1, W1) - Math.max(sp.started, W0)) / WEEK_MS);
        exposureWeeks += exp;
        if (exp > 0 || left) exposed.add(client);
        if (left) leavers++;
        if (sp.ended === null) active++;
      }
    }
    const clients = exposed.size;
    const clientMonths = exposureWeeks / LOAD_WEEKS_PER_MONTH;
    const rate = clientMonths > 0 ? leavers / clientMonths : null;
    let blocked: string | null = null;
    if (sv.pricingModel === "one_off") blocked = "One-off work ends by design, so churn isn't measured for it.";
    else if (weeks < CHURN_MIN_WEEKS) blocked = `The file covers ${fmt(weeks, 0)} weeks; at least ${CHURN_MIN_WEEKS} are needed.`;
    else if (clients < minSample) blocked = `Too few to measure: ${clients} of the ${minSample} clients needed.`;
    else if (leavers < CHURN_MIN_LEAVERS) {
      blocked = `Only ${leavers} client${leavers === 1 ? "" : "s"} left in the period; at least ${CHURN_MIN_LEAVERS} are needed. A file of current clients only can't show churn: include the clients who left, with the date they left.`;
    } else if (rate === null || rate > 1) blocked = "More than every client leaving each month: check the dates.";
    const monthly = blocked === null ? rate : null;
    const note =
      `${leavers} of ${clients} clients left over ${fmt(weeks, 0)} weeks (${rate === null ? "0%" : pct(rate)} a month). ` +
      `${active} are clients on ${dateText(asOf)}${sv.group ? `, and Client groups counts ${sv.group.count}` : ""}.`;
    return {
      serviceId: sv.serviceId,
      name: sv.name,
      clients,
      leavers,
      clientMonths,
      activeAtAsOf: active,
      monthly,
      enough: blocked === null,
      blocked,
      note,
    };
  });

  return { services, window, unmatchedServices: countUnmatched(unmatched), startsAfterAsOf, rows: input.rows.length, clients: clientIds.size };
}

// ---------------------------------------------------------------------------
// Servicing checks from the servicing log
// ---------------------------------------------------------------------------

export type ServicingCheckId = "late" | "resp" | "onb";

export interface ServicingCheck {
  id: ServicingCheckId;
  n: number;
  /** A share 0-1 (late), working hours (resp) or working days (onb); null when blocked. */
  value: number | null;
  enough: boolean;
  blocked: string | null;
  note: string;
}

export interface ServicingChecksResult {
  checks: ServicingCheck[];
  /** Task names in the log that match no servicing process, with how many rows each. They still count for `late`. */
  unmatchedTasks: { name: string; rows: number }[];
  tasks: number;
  window: { from: number; to: number; weeks: number } | null;
}

/**
 * The three checks from a servicing log (and, for onboarding, the clients file). Calendar time becomes working time
 * as part 1 does: `ms / WEEK_MS x hoursPerWeek` hours; working days are weeks x 5, as the engine's
 * `hours / (hoursPerWeek / 5)`.
 */
export function servicingChecks(input: {
  log: readonly ServicingRow[];
  clients: readonly ClientRow[] | null;
  links: readonly ServicingLinkInput[];
  services: readonly ChurnServiceInput[];
  hoursPerWeek: number;
  asOf: number;
  minSample?: number;
}): ServicingChecksResult {
  const minSample = Math.max(1, Math.floor(input.minSample ?? CALIBRATION_MIN_SAMPLE));
  const { log, asOf } = input;
  const hours = (ms: number) => (ms / WEEK_MS) * input.hoursPerWeek;
  const days = (ms: number) => (ms / WEEK_MS) * 5;
  const finish = (id: ServicingCheckId, n: number, value: number | null, note: string, blocked: string | null = null): ServicingCheck => {
    if (blocked === null && n < minSample) return { id, n, value: null, enough: false, blocked: tooFew(n, minSample), note };
    return { id, n, value: blocked === null ? value : null, enough: blocked === null, blocked, note };
  };

  // Late or missed: tasks that were due by the date, done after their due date or not at all.
  const due = log.filter((r) => r.due <= asOf);
  const bad = due.filter((r) => r.done === null || r.done > r.due).length;
  const late = finish(
    "late",
    due.length,
    due.length ? bad / due.length : null,
    `${bad} of ${due.length} tasks due by ${dateText(asOf)} were done after their due date or not at all${due.length ? ` (${pct(bad / due.length, 0)})` : ""}.`,
  );

  // Which services a client takes, from the clients file.
  const serviceByName = uniqueByName(input.services, (s) => s.name);
  const takes = new Map<string, Set<string>>();
  if (input.clients) {
    for (const r of input.clients) {
      const sv = serviceByName.get(norm(r.service));
      if (!sv) continue;
      const set = takes.get(r.client) ?? new Set<string>();
      set.add(sv.serviceId);
      takes.set(r.client, set);
    }
  }

  // Response time to ad-hoc requests.
  const adhocLinks = input.links.filter((l) => l.adhoc);
  let resp: ServicingCheck;
  let slaVaries = false;
  if (!adhocLinks.length) {
    resp = finish("resp", 0, null, "No servicing work is set to come in as ad-hoc requests.", "No servicing work is set to come in as ad-hoc requests.");
  } else {
    const responses: number[] = [];
    const slas = new Set<number>();
    for (const r of log) {
      if (r.done === null) continue;
      const mine = takes.get(r.client);
      const matching = adhocLinks.filter((l) => norm(l.processName) === norm(r.task) && (!mine || mine.has(l.serviceId)));
      if (!matching.length) continue;
      const sla = Math.min(...matching.map((l) => l.slaHours));
      if (new Set(matching.map((l) => l.slaHours)).size > 1) slaVaries = true;
      slas.add(sla);
      responses.push(r.requested !== null ? hours(r.done - r.requested) : Math.max(0, hours(r.done - r.due) + sla));
    }
    const n = responses.length;
    const mean = n ? responses.reduce((a, b) => a + b, 0) / n : null;
    const how = log.some((r) => r.requested !== null)
      ? "from when each was requested"
      : "taking each request as coming in one SLA before it was due, as the simulation does";
    resp = finish(
      "resp",
      n,
      mean,
      `${n} ad-hoc request${n === 1 ? "" : "s"} done${mean === null ? "" : `, ${fmt(mean)} working hours on average`} ${how}.` +
        (slaVaries ? " Their processes have different SLAs, so the smallest was used." : ""),
    );
  }

  // Onboarding speed: new clients' first delivery.
  let onb: ServicingCheck;
  if (!input.clients) onb = finish("onb", 0, null, "Needs the clients file too.", "Needs the clients file too.");
  else {
    let L0 = Infinity;
    for (const r of log) L0 = Math.min(L0, r.requested ?? r.due);
    const rowsByClient = new Map<string, ServicingRow[]>();
    for (const r of log) {
      const list = rowsByClient.get(r.client) ?? [];
      list.push(r);
      rowsByClient.set(r.client, list);
    }
    const spells = spellsBy(
      input.clients.filter((r) => r.started <= asOf).map((r) => ({ client: r.client, key: norm(r.service), started: r.started, ended: r.ended })),
      asOf,
    );
    const speeds: number[] = [];
    let waiting = 0;
    for (const byClient of spells.values()) {
      for (const [client, list] of byClient) {
        for (const sp of list) {
          if (!(sp.started >= L0)) continue;
          let first = Infinity;
          for (const r of rowsByClient.get(client) ?? []) if (r.done !== null && r.done >= sp.started) first = Math.min(first, r.done);
          if (Number.isFinite(first)) speeds.push(days(first - sp.started));
          else waiting++;
        }
      }
    }
    const n = speeds.length;
    const mean = n ? speeds.reduce((a, b) => a + b, 0) / n : null;
    onb = finish(
      "onb",
      n,
      mean,
      `${n} new client${n === 1 ? "" : "s"} had a first delivery${mean === null ? "" : `, ${fmt(mean)} working days after they started on average`}` +
        `${waiting ? `; ${waiting} with nothing done yet left out` : ""}.`,
    );
  }

  const processNames = new Set(input.links.map((l) => norm(l.processName)));
  const unmatchedTasks = countUnmatched(log.filter((r) => !processNames.has(norm(r.task))).map((r) => r.task));
  let from = Infinity;
  for (const r of log) from = Math.min(from, r.requested ?? r.due);
  const window = Number.isFinite(from) ? { from, to: asOf, weeks: Math.max(0, (asOf - from) / WEEK_MS) } : null;
  return { checks: [late, resp, onb], unmatchedTasks, tasks: log.length, window };
}

// ---------------------------------------------------------------------------
// Back-solving normal churn through today's drivers
// ---------------------------------------------------------------------------

/** Today's driver pressure on each service's churn: 1 / its normal share, from a run of a model with no market. */
export function churnMultipliers(result: SimulationResult): Record<string, number> {
  const out: Record<string, number> = {};
  const by = result.churnCauses?.byService ?? {};
  for (const sid of Object.keys(by).sort()) {
    const row = by[sid]!;
    const normal = row.shares.normal ?? 0;
    if (row.clients > 0 && normal > 0) out[sid] = 1 / normal;
  }
  return out;
}

export interface BackSolvedChurn {
  /** Proposed normal churn per service id (rounded to 4 places). Absent: couldn't be solved (see `why`). */
  bases: Record<string, number>;
  /** The multiplier the proposal was divided by (from the last run). */
  multipliers: Record<string, number>;
  why: Record<string, string>;
  /** Simulations run, including run 0. */
  runs: number;
  converged: boolean;
  /** Today's simulated values of the three checks, from run 0 (null: the run measures none). */
  simulated: { late: number | null; resp: number | null; onb: number | null };
  engineVersion: string;
  seed: number;
  reps: number;
  horizonWeeks: number;
}

/**
 * Normal churn per service such that normal churn x today's driver pressure gives the measured churn. Today is the
 * model without its market (the history is today's market: Stable is 100%, A57) and without a planned price rise (it
 * hasn't happened); every other driver stays as set. Services are solved together because they share people.
 */
export function backSolveChurn(
  model: EngineModel,
  measured: Readonly<Record<string, number>>,
  options: { reps?: number; seed?: number; onRun?: (run: number) => void } = {},
): BackSolvedChurn {
  const reps = options.reps ?? CHURN_BACKSOLVE_REPS;
  const seed = options.seed ?? CHURN_BACKSOLVE_SEED;
  const ids = Object.keys(measured).sort();
  for (const sid of ids) {
    const m = measured[sid]!;
    if (!(m > 0) || m > 1) throw new RangeError(`Measured churn must be above 0 and at most 1 (got ${m} for ${sid}).`);
  }
  // A new drivers array: resolveChurnDrivers caches per model object, and the input is never mutated.
  const given: EngineChurnDriver[] = model.churnDrivers ?? [];
  const drivers: EngineChurnDriver[] = given.some((d) => d.id === "price")
    ? given.map((d) => (d.id === "price" ? { ...d, enabled: false } : { ...d }))
    : [...given.map((d) => ({ ...d })), { id: "price", weight: 1, enabled: false }];
  const today: EngineModel = { ...model, market: undefined, churnDrivers: drivers };

  const why: Record<string, string> = {};
  const solved = new Set<string>();
  for (const sid of ids) {
    const g = today.clientGroups?.[sid];
    if (g && today.services?.[sid] && Math.round(g.count) >= 1) solved.add(sid);
    else why[sid] = "No clients of this service are simulated here. Count them in Settings → Client groups first.";
  }

  const withBases = (bases: Record<string, number>): EngineModel => ({
    ...today,
    clientGroups: Object.fromEntries(Object.entries(today.clientGroups ?? {}).map(([sid, g]) => [sid, sid in bases ? { ...g, churnMonthly: bases[sid]! } : g])),
  });
  const valueOf = (r: SimulationResult, id: string) => r.churnCauses?.causes.find((c) => c.id === id)?.value ?? null;

  let runs = 0;
  options.onRun?.(0);
  const run0 = simulate(today, reps, seed);
  runs++;
  const simulated = { late: valueOf(run0, "late"), resp: valueOf(run0, "resp"), onb: valueOf(run0, "onb") };
  let M = churnMultipliers(run0);
  const b: Record<string, number> = {};
  for (const sid of solved) b[sid] = M[sid] !== undefined ? measured[sid]! / M[sid]! : measured[sid]!;

  let converged = false;
  const lastM: Record<string, number> = {};
  for (let r = 1; r <= CHURN_BACKSOLVE_MAX_RUNS && Object.keys(b).length; r++) {
    options.onRun?.(r);
    M = churnMultipliers(simulate(withBases(b), reps, seed));
    runs++;
    let move = 0;
    const next: Record<string, number> = {};
    for (const sid of Object.keys(b)) {
      if (M[sid] === undefined) {
        why[sid] = "Its clients couldn't leave in the simulation.";
        continue;
      }
      lastM[sid] = M[sid]!;
      next[sid] = measured[sid]! / M[sid]!;
      move = Math.max(move, Math.abs(next[sid]! - b[sid]!));
    }
    for (const sid of Object.keys(b)) delete b[sid];
    Object.assign(b, next);
    if (move < CHURN_BACKSOLVE_TOLERANCE) {
      converged = true;
      break;
    }
  }
  if (!Object.keys(b).length) converged = false;

  const bases: Record<string, number> = {};
  const multipliers: Record<string, number> = {};
  for (const sid of Object.keys(b).sort()) {
    bases[sid] = round(b[sid]!, 4);
    multipliers[sid] = lastM[sid] ?? M[sid] ?? 1;
  }
  return {
    bases,
    multipliers,
    why,
    runs,
    converged,
    simulated,
    engineVersion: ENGINE_VERSION,
    seed,
    reps,
    horizonWeeks: today.horizonWeeks ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Proposals
// ---------------------------------------------------------------------------

/**
 * One churn proposal per active, non-one-off service that has a client group or appears in the file. A service with
 * no client group has nothing to write to: it is listed by name in `noGroup` instead (the page says to add one).
 */
export function churnProposals(
  services: readonly ChurnServiceInput[],
  measured: readonly MeasuredChurn[],
  solved: BackSolvedChurn | null,
): { proposals: CalibrationProposal[]; noGroup: string[] } {
  const proposals: CalibrationProposal[] = [];
  const noGroup: string[] = [];
  for (const sv of services) {
    if (sv.pricingModel === "one_off") continue;
    const m = measured.find((x) => x.serviceId === sv.serviceId);
    if (!sv.group) {
      if (m && m.clients > 0) noGroup.push(sv.name);
      continue;
    }
    const g = sv.group;
    const proposed = m?.enough && solved ? (solved.bases[sv.serviceId] ?? null) : null;
    const multiplier = solved?.multipliers[sv.serviceId] ?? null;
    const enough = Boolean(m?.enough) && proposed !== null;
    const blocked = enough
      ? null
      : (m?.blocked ?? (m ? (solved?.why[sv.serviceId] ?? "Today's driver pressure hasn't been measured yet.") : "Not in the clients file."));
    const changed = proposed !== null && proposed !== round(g.churnMonthly, 4);
    let note = m?.note ?? "";
    if (proposed !== null && multiplier !== null && m?.monthly !== null && m) {
      if (Math.abs(multiplier - 1) < 0.0005) note += " No driver adds churn today, so normal churn is the measured churn.";
      else
        note += ` Today's drivers add ${pct(multiplier - 1, 0)} to it, so normal churn is ${pct(proposed)}: ${pct(proposed)} × ${fmt(multiplier, 2)} gives the ${pct(m.monthly!)} measured.`;
      if (multiplier > 2) note += " Today's drivers more than double this service's churn, so normal churn is under half of what was measured. Check the driver weights.";
      if (solved && !solved.converged) note += " Approximate: the simulation moved a little between runs.";
    }
    proposals.push({
      key: `churn:${g.id}`,
      kind: "churn",
      target: { table: "client_groups", id: g.id },
      subject: sv.name,
      n: m?.clients ?? 0,
      leavers: m?.leavers ?? 0,
      enough,
      currentSource: g.source,
      current: g.churnMonthly,
      measured: m?.monthly ?? null,
      multiplier: proposed !== null ? multiplier : null,
      proposed,
      changed,
      blocked,
      note: note.trim(),
      set: proposed !== null ? { churn_monthly: proposed } : null,
      before: proposed !== null ? { churn_monthly: g.churnMonthly } : null,
    });
  }
  return { proposals, noGroup };
}
