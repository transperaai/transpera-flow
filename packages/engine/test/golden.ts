// Golden models (docs/PRD.md §6.9 layer 3; issue #22; docs/engine-versioning.md):
// which models are snapshotted, at which seed, which outputs, and how the
// baselines in packages/engine/golden/ are read, compared and written.

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { MARKET_PRESETS, absenceTest, detectIssues, larkspurModel, northbeamModel, northbeamWithChurnDrivers, northbeamWithClientGroups, northbeamWithServicing, simulate, withMarketCondition, type EngineModel, type SimulationResult, type Stat } from "../src";

export const GOLDEN_DIR = new URL("../golden/", import.meta.url);
export const VERSION_FILE = new URL("../src/version.ts", import.meta.url);
export const LEDGER_FILE = new URL("versions.json", GOLDEN_DIR);

/** A golden model: the same model, seed and replications every time. */
export interface GoldenModel {
  name: string;
  description: string;
  model: () => EngineModel;
  seed: number;
  reps: number;
}

/**
 * The golden models. The app's defaults (30 replications, seed 1), so the
 * baselines are the numbers someone opening the model would see.
 */
export const GOLDEN_MODELS: GoldenModel[] = [
  {
    name: "northbeam",
    description: "Northbeam Digital, the prototype's model re-baselined after the §6.8 fixes: pooled head-counts, one implicit retainer, automatic warm-up.",
    model: northbeamModel,
    seed: 1,
    reps: 30,
  },
  {
    name: "northbeam-seeded",
    description: "Northbeam with its 26 named clients: SEO and PPC services, named people, the roster with assignments, 10% overtime cap and two servicing processes. The seed now counts clients per service (northbeam-groups); this stays the reference for named rosters.",
    model: northbeamWithServicing,
    seed: 1,
    reps: 30,
  },
  {
    name: "northbeam-downturn",
    description: "Northbeam as seeded under the Downturn market for the whole run: fewer enquiries that sign less, slower decisions, lower prices, more churn (market.ts).",
    model: () => withMarketCondition(northbeamWithServicing(), MARKET_PRESETS.downturn.factors),
    seed: 1,
    reps: 30,
  },
  {
    name: "northbeam-groups",
    description: "Northbeam as the seed loads it since client groups: its clients counted per service (17 SEO clients at health 83, 12 PPC clients at health 52) and simulated as unnamed clients, with the same servicing: a healthy group and one at risk.",
    model: northbeamWithClientGroups,
    seed: 1,
    reps: 30,
  },
  {
    name: "northbeam-drivers",
    description: "Northbeam as seeded with all ten churn drivers on at the prototype's weights, and one of its own (churn-drivers.ts): who the churn is blamed on, and what each cause measured.",
    model: northbeamWithChurnDrivers,
    seed: 1,
    reps: 30,
  },
  {
    name: "larkspur",
    description: "Larkspur Creative, the messier agency: overloaded designers, a copywriter on overtime, an 18-client roster with health-driven churn, starting from WIP.",
    model: larkspurModel,
    seed: 1,
    reps: 30,
  },
];

const stat = (s: Stat) => ({ mean: s.mean, p10: s.p10, p90: s.p90 });

/**
 * The outputs a baseline locks (issue #22's list and a little more):
 * throughput, cycle time, revenue, utilisation per role and person, overtime,
 * clients at risk and churned, touchpoints, per-step flow, per-client health,
 * the rating of every detected issue and the bottleneck. Numbers are kept exactly: the engine is deterministic
 * (Node and a browser agree byte for byte), so no tolerance is needed.
 */
export function keyOutputs(model: EngineModel, r: SimulationResult) {
  const k = r.kpi;
  // The absence test (absence.ts) at its defaults: 10 replications at the baseline's seed, 2 weeks away.
  const absence = absenceTest(model, { seed: r.seed });
  return {
    initialState: r.initialState,
    throughput: { won: stat(k.won), lost: stat(k.lost), done: stat(k.done), wonPerWeek: k.won.mean / model.horizonWeeks },
    cycleHours: { mean: k.cycle.mean, p50: k.cycle.p50, p90: k.cycle.p90 },
    revenue: { newMrr: stat(k.mrrAdded), billed: stat(k.billed), ltvAdded: stat(k.ltvAdded), lostRevenue: stat(k.lostRevenue) },
    labour: stat(k.labour),
    overtime: { hours: stat(k.overtimeHours), cost: stat(k.overtimeCost!) },
    clients: k.clientsAtRisk && k.clientsChurned ? { atRisk: stat(k.clientsAtRisk), churned: stat(k.clientsChurned) } : null,
    touchpoints: k.touchpoints ? { onTime: stat(k.touchpoints.onTime), late: stat(k.touchpoints.late), missed: stat(k.touchpoints.missed) } : null,
    bottleneck: { role: r.bnRole, step: r.bnStep, person: r.bnPerson },
    roles: Object.fromEntries(
      Object.entries(k.roles).map(([id, v]) => [
        id,
        { util: stat(v.util), pipeline: v.pipeline.mean, ongoing: v.ongoing.mean, servicing: v.servicing.mean, overtime: v.overtime.mean },
      ]),
    ),
    people: Object.fromEntries(Object.entries(k.people).map(([id, v]) => [id, { util: v.util.mean, overtime: v.overtime.mean }])),
    steps: Object.fromEntries(
      Object.entries(r.steps).map(([id, s]) => [
        id,
        { arrivals: s.arrivals, departures: s.departures, avgQueue: s.avgQueue, avgWait: s.avgWait, wip: s.wip, slaBreaches: s.slaBreaches, lostHere: s.lostHere ?? 0 },
      ]),
    ),
    // Who the absence test covers, and what it found (work lost, weeks to recover, missed client tasks).
    absence: Object.fromEntries(
      absence.people.map((f) => [f.personId, { steps: f.stepIds, workLost: f.workLost, itemsLost: f.itemsLost, recoveryWeeks: f.recoveryWeeks, recovered: f.recovered, extraMissed: f.extraMissed }]),
    ),
    // The rating of every detected issue and how it was reached (ratings.ts), so a moved cut-off or escalator shows here.
    // The cost per month of each (cost.ts), without the shadow-price run the busy rule's money cost needs.
    ratings: Object.fromEntries(
      detectIssues(model, r, {}, { absence }).map((i) => [
        i.key,
        {
          rating: i.rating,
          base: i.escalation.base,
          badMonth: i.escalation.badMonth,
          bottleneck: i.escalation.bottleneck,
          costPerMonth: i.cost.perMonth,
          hoursPerMonth: i.cost.hoursPerMonth,
        },
      ]),
    ),
    // Who the churn is blamed on (churn-drivers.ts): each cause's share of the clients lost, its average pressure and what was measured.
    churnCauses: r.churnCauses
      ? {
          clients: r.churnCauses.clients,
          normalShare: r.churnCauses.normal.share,
          causes: Object.fromEntries(r.churnCauses.causes.map((c) => [c.id, { share: c.share, mrr: c.mrr, pressure: c.pressure, value: c.value }])),
          byService: r.churnCauses.byService,
        }
      : null,
    rosterClients: r.clients
      ? Object.fromEntries(Object.entries(r.clients).map(([id, c]) => [id, { health: c.health.mean, churned: c.churned, atRisk: c.atRisk }]))
      : null,
  };
}

export type KeyOutputs = ReturnType<typeof keyOutputs>;

/** One golden model's baseline file (golden/<name>.json). */
export interface Baseline {
  model: string;
  description: string;
  /** The engine version the outputs were produced with. */
  engineVersion: string;
  seed: number;
  reps: number;
  outputs: KeyOutputs;
}

/** One approved engine version (golden/versions.json). */
export interface LedgerEntry {
  version: string;
  /** ISO date it was approved. */
  date: string;
  /** Why the numbers moved (or, for the first, what the version is). */
  note: string;
  /** sha256 of every baseline's outputs at this version (see `baselineDigest`). */
  digest: string;
}

export function runGolden(g: GoldenModel): KeyOutputs {
  const model = g.model();
  // Through JSON, as the baselines are stored: drops undefined, keeps every double exactly.
  return JSON.parse(JSON.stringify(keyOutputs(model, simulate(model, g.reps, g.seed)))) as KeyOutputs;
}

const baselineUrl = (name: string) => new URL(`${name}.json`, GOLDEN_DIR);

export function readBaseline(name: string): Baseline | null {
  const url = baselineUrl(name);
  return existsSync(url) ? (JSON.parse(readFileSync(url, "utf8")) as Baseline) : null;
}

/** Baseline files on disk, by model name. */
export function baselineNames(): string[] {
  return readdirSync(GOLDEN_DIR)
    .filter((f) => f.endsWith(".json") && f !== "versions.json")
    .map((f) => f.replace(/\.json$/, ""))
    .sort();
}

/**
 * JSON for review: two-space indents, with objects of plain values (a
 * mean/p10/p90, a step's flow) on one line, so a diff shows each metric once.
 */
export function stringifyForReview(value: unknown, indent = ""): string {
  if (!value || typeof value !== "object") return JSON.stringify(value);
  const isArray = Array.isArray(value);
  const entries: [string, unknown][] = isArray ? value.map((v, i) => [String(i), v]) : Object.entries(value);
  const [open, close] = isArray ? ["[", "]"] : ["{", "}"];
  if (!entries.length) return `${open}${close}`;
  const inner = `${indent}  `;
  const item = ([k, v]: [string, unknown]) => (isArray ? "" : `${JSON.stringify(k)}: `) + stringifyForReview(v, inner);
  if (entries.every(([, v]) => !v || typeof v !== "object")) return `${open} ${entries.map(item).join(", ")} ${close}`;
  return `${open}\n${entries.map((e) => `${inner}${item(e)}`).join(",\n")}\n${indent}${close}`;
}

export function writeBaseline(b: Baseline): void {
  writeFileSync(baselineUrl(b.model), `${stringifyForReview(b)}\n`);
}

export function readLedger(): LedgerEntry[] {
  return existsSync(LEDGER_FILE) ? (JSON.parse(readFileSync(LEDGER_FILE, "utf8")) as LedgerEntry[]) : [];
}

export function writeLedger(entries: LedgerEntry[]): void {
  writeFileSync(LEDGER_FILE, `${JSON.stringify(entries, null, 2)}\n`);
}

/**
 * sha256 of the golden models' outputs, in model-name order. It changes
 * exactly when a snapshotted number does, so the ledger ties each version to
 * the numbers it was approved with.
 */
export function baselineDigest(outputs: Record<string, KeyOutputs>): string {
  const names = Object.keys(outputs).sort();
  const text = JSON.stringify(names.map((n) => [n, outputs[n]]));
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

export function parseVersion(v: string): [number, number, number] | null {
  const m = SEMVER.exec(v);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a)!;
  const y = parseVersion(b)!;
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
}

/** The next minor version: 1.0.0 → 1.1.0. */
export function nextMinor(v: string): string {
  const [major, minor] = parseVersion(v)!;
  return `${major}.${minor + 1}.0`;
}

/** Rewrite src/version.ts with a new version (its only assignment). */
export function writeEngineVersion(version: string): void {
  const src = readFileSync(VERSION_FILE, "utf8");
  const next = src.replace(/export const ENGINE_VERSION = "[^"]*";/, `export const ENGINE_VERSION = "${version}";`);
  if (next === src && !src.includes(`"${version}"`)) throw new Error("Couldn't find ENGINE_VERSION in src/version.ts");
  writeFileSync(VERSION_FILE, next);
}

export const goldenPath = (name: string) => fileURLToPath(baselineUrl(name));
