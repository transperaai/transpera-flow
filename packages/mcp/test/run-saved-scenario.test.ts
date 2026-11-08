import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NORTHBEAM_HIRE_MARCH_ID, NORTHBEAM_WORKSPACE_ID, northbeamBundle, northbeamPersonIds, northbeamSandboxScenarios } from "@transpera-flow/db";
import { effectiveChanges, prepareScenario, simulateScenario } from "@transpera-flow/db/sandbox";
import { call, connect, createUser, issueToken, startTestDb, type McpTestDb } from "./helpers";

// run_scenario with `scenario` (sandbox phase 5a, docs/plans/sandbox-p5-brief.md §4.2): a saved Sandbox scenario run the way the page runs
// it, month by month, on the same inputs and the same runner. Seeded Northbeam, the Owner's token and a Viewer's.

type Stat = { mean: number; p10: number; p90: number };
interface Run {
  workspace: { id: string; name: string };
  scenario: { id: string | null; name: string; parent: { id: string; name: string } | null };
  start_date: string;
  months: number;
  engine_version: string;
  reps: number;
  seed: number;
  segments: number;
  spliced: boolean;
  changes: { id: string; lever: string; note: string | null; inherited_from: unknown }[];
  problems: unknown[];
  later: string[];
  month_starts: string[];
  series: Record<string, Stat[] | null>;
  roles: Record<string, { name: string; busy: (Stat | null)[]; uncovered: (number | null)[] }>;
  people?: Record<string, { name: string; busy: (Stat | null)[] }>;
  time: { categories: { key: string; name: string }[]; team: Record<string, { hours: number[]; run_hours: number }>; roles: Record<string, unknown> };
  totals: { revenue: number; profit: number | null; clients_lost: number; too_busy_months: number };
  price_rise: { total: { net: { mean: number } } } | null;
  baseline: { series: Record<string, Stat[] | null>; roles: unknown; totals: { revenue: number } } | null;
  diff: { totals: { revenue: number; profit: number | null } } | null;
  duration_ms: number;
}

const START = "2026-10-05";
let env: McpTestDb;
let admin: pg.Client;
let ownerToken: string;
let viewerToken: string;
const RISE = "5c000000-0000-4000-8000-0000000000c1";
const RISE_CHANGE = "5c000000-0000-4000-8000-0000000000d1";

beforeAll(async () => {
  env = await startTestDb();
  admin = env.t.client;
  const owner = await createUser(admin, "run-owner@example.com");
  const viewer = await createUser(admin, "run-viewer@example.com");
  await admin.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, 'owner'), ($1, $3, 'viewer')", [NORTHBEAM_WORKSPACE_ID, owner, viewer]);
  ownerToken = await issueToken(admin, owner);
  viewerToken = await issueToken(admin, viewer);
  const march = northbeamSandboxScenarios().find((s) => s.id === NORTHBEAM_HIRE_MARCH_ID)!;
  await admin.query("update sandbox_scenarios set changes = $2::jsonb where id = $1", [NORTHBEAM_HIRE_MARCH_ID, JSON.stringify(march.changes.map((c) => ({ ...c, note: "Assumes a PPC specialist can start on the 1st." })))]);
  // A price rise from March: a pair (the same scenario without the rise) and a trade-off.
  await admin.query("insert into sandbox_scenarios (id, workspace_id, name, changes) values ($1, $2, 'Raise prices', $3::jsonb)", [
    RISE,
    NORTHBEAM_WORKSPACE_ID,
    JSON.stringify([{ id: RISE_CHANGE, lever: "B5", target: null, op: "set", value: 0.08, from: "2027-03", note: "Assumes clients accept 8%." }]),
  ]);
}, 120_000);

afterAll(async () => {
  await env?.close();
});

async function run(token: string, args: Record<string, unknown>) {
  const client = await connect(token, env.options);
  try {
    return await call<Run>(client, "run_scenario", { workspace: "northbeam", start_date: START, months: 12, ...args });
  } finally {
    await client.close();
  }
}

/** What the Sandbox page runs for the seeded workspace: the fixture's bundle and saved scenarios through the shared runner. */
function expected(id: string | null, months = 12) {
  const rows = northbeamSandboxScenarios();
  const bundle = northbeamBundle();
  const chain = id ? effectiveChanges(rows.find((r) => r.id === id)!, rows) : { ok: true as const, changes: [] };
  if (!chain.ok) throw new Error(chain.error);
  const prepared = prepareScenario(bundle, chain.changes, [], months, START);
  return { prepared, ...simulateScenario(prepared) };
}

describe("run_scenario with a saved scenario", () => {
  it("runs 'Hire in March' by name and by id, the same", async () => {
    const byName = await run(ownerToken, { scenario: "Hire in March" });
    expect(byName.ok, JSON.stringify(byName.error)).toBe(true);
    const byId = await run(ownerToken, { scenario: NORTHBEAM_HIRE_MARCH_ID });
    expect(byId.data.scenario).toEqual({ id: NORTHBEAM_HIRE_MARCH_ID, name: "Hire in March", parent: null });
    expect(byId.data.series).toEqual(byName.data.series);
    expect(byName.data).toMatchObject({ months: 12, start_date: START, reps: 30, seed: 1, problems: [], later: [] });
    expect(byName.data.engine_version).toMatch(/^\d+\.\d+\.\d+/);
    expect(byName.data.month_starts).toHaveLength(12);
    expect(byName.data.month_starts[0]).toBe(START);
    expect(byName.data.changes.map((c) => [c.lever, c.note])).toEqual([["D1", expect.stringMatching(/PPC specialist/)]]);
    expect(byName.assumptions.join(" ")).toMatch(/pinned warm-up/);
  }, 120_000);

  it("gives the numbers the Sandbox shows: equal to the shared runner on the same inputs", async () => {
    const r = await run(ownerToken, { scenario: "Hire in March" });
    const want = expected(NORTHBEAM_HIRE_MARCH_ID);
    const monthly = want.run.result.monthly!;
    expect(r.data.segments).toBe(want.prepared.segments.length);
    expect(r.data.spliced).toBe(want.run.spliced);
    const strip = (list: Stat[]) => list.map((s) => ({ mean: s.mean, p10: s.p10, p90: s.p90 }));
    expect(r.data.series.revenue).toEqual(strip(monthly.revenue.total));
    expect(r.data.series.mrr).toEqual(strip(monthly.mrr));
    expect(r.data.series.won).toEqual(strip(monthly.sales.won));
    expect(r.data.series.profit).toEqual(strip(monthly.money!.profit));
    for (const [id, role] of Object.entries(r.data.roles)) expect(role.busy).toEqual(monthly.roles[id]!.map((m) => (m ? { mean: m.mean, p10: m.p10, p90: m.p90 } : null)));
    expect(r.data.totals.revenue).toBe(monthly.revenue.total.reduce((a, s) => a + s.mean, 0));
  }, 120_000);

  it("leaves the months before a timed change exactly as the No changes run", async () => {
    const r = await run(ownerToken, { scenario: "Hire in March" });
    expect(r.data.baseline).not.toBeNull();
    // The hire starts in March 2027: October to February (months 0 to 4) come before it.
    // Equal to the digit, except a money figure may differ in its last bits (a stay's fee is spread over its months by amount / length x
    // overlap): the same tolerance as the web's months-before test (apps/web/test/sandbox-months-before.test.ts).
    const MONEY = new Set(["revenue", "mrr", "profit", "labour"]);
    for (const key of ["revenue", "mrr", "opportunities", "won", "lost", "conversion", "clients_won", "clients_lost", "at_risk", "late_tasks", "overtime_hours", "profit", "labour"]) {
      const got = r.data.series[key]!.slice(0, 5);
      const want = r.data.baseline!.series[key]!.slice(0, 5);
      if (!MONEY.has(key)) expect(got, key).toEqual(want);
      else
        got.forEach((g, i) => {
          for (const k of ["mean", "p10", "p90"] as const) expect(Math.abs(g[k] - want[i]![k]), `${key}[${i}].${k}`).toBeLessThanOrEqual(1e-9 * Math.max(1, Math.abs(g[k]), Math.abs(want[i]![k])));
        });
    }
    expect(r.data.series.profit!.slice(5)).not.toEqual(r.data.baseline!.series.profit!.slice(5));
    expect(r.data.diff!.totals.profit).not.toBe(0);
  }, 120_000);

  it("returns the price-rise trade-off for a scenario with a B5 change", async () => {
    const r = await run(ownerToken, { scenario: "Raise prices" });
    expect(r.ok, JSON.stringify(r.error)).toBe(true);
    expect(r.data.price_rise).not.toBeNull();
    expect(typeof r.data.price_rise!.total.net.mean).toBe("number");
    expect(r.data.changes[0]!.note).toBe("Assumes clients accept 8%.");
    const plain = await run(ownerToken, { scenario: "Hire in March" });
    expect(plain.data.price_rise).toBeNull();
  }, 120_000);

  it("runs 'No changes' with no baseline beside it", async () => {
    const r = await run(ownerToken, { scenario: "No changes", months: 6 });
    expect(r.ok).toBe(true);
    expect(r.data).toMatchObject({ scenario: { id: null, name: "No changes" }, months: 6, spliced: false, baseline: null, diff: null, changes: [] });
    const want = expected(null, 6).run.result.monthly!;
    expect(r.data.series.revenue).toEqual(want.revenue.total.map((s) => ({ mean: s.mean, p10: s.p10, p90: s.p90 })));
  }, 120_000);

  it("takes months (default the scenario's horizon) and leaves the baseline out when asked", async () => {
    const r = await run(ownerToken, { scenario: "Hire in January", months: undefined, include_baseline: false });
    expect(r.data.months).toBe(12);
    expect(r.data.baseline).toBeNull();
    const short = await run(ownerToken, { scenario: "Hire in January", months: 3 });
    expect(short.data.series.revenue).toHaveLength(3);
  }, 120_000);

  it("reports the time split by category for the team and each role, never by person", async () => {
    const r = await run(ownerToken, { scenario: "Hire in March", include_people: true });
    expect(r.data.time.categories.map((c) => c.key)).toEqual(expect.arrayContaining(["client_upkeep", "fixing", "idle", "uncovered"]));
    expect(r.data.time.team.fixing!.hours).toHaveLength(12);
    expect(Object.keys(r.data.time.roles).length).toBeGreaterThan(0);
    expect(JSON.stringify(r.data.time)).not.toContain("Dan Okafor");
    expect(r.data.people![northbeamPersonIds["Dan Okafor"]!]!.name).toBe("Dan Okafor");
  }, 120_000);

  it("gives a Viewer's token no profit or labour, and people by their label", async () => {
    const r = await run(viewerToken, { scenario: "Hire in March", include_people: true });
    expect(r.ok, JSON.stringify(r.error)).toBe(true);
    expect(r.data.series.profit).toBeNull();
    expect(r.data.series.labour).toBeNull();
    expect(r.data.totals.profit).toBeNull();
    expect(r.data.diff!.totals.profit).toBeNull();
    expect(r.data.series.revenue).not.toBeNull();
    expect(JSON.stringify(r.data.people)).not.toContain("Dan Okafor");
    // As the Sandbox shows a Viewer: their own person's row only (this Viewer has none), never another person's busy share by label.
    expect(r.data.people).toEqual({});
    // The revenue side is the owner's, to the digit: only what depends on pay is hidden.
    const owner = await run(ownerToken, { scenario: "Hire in March" });
    expect(r.data.series.revenue).toEqual(owner.data.series.revenue);
  }, 120_000);

  it("refuses an ambiguous name, an unknown name and a scenario mixed with the whole-run arguments", async () => {
    const ambiguous = await run(ownerToken, { scenario: "Hire in" });
    expect(ambiguous).toMatchObject({ ok: false, error: { code: "ambiguous" } });
    const unknown = await run(ownerToken, { scenario: "Nope" });
    expect(unknown).toMatchObject({ ok: false, error: { code: "not_found" } });
    for (const extra of [{ overrides: [{ path: "demand.leads_per_week", op: "set", value: 9 }] }, { process: "Pipeline" }, { revision: "draft" }, { horizon_weeks: 20 }, { reps: 5 }, { seed: 3 }]) {
      const r = await run(ownerToken, { scenario: "Hire in March", ...extra });
      expect(r, JSON.stringify(extra)).toMatchObject({ ok: false, error: { code: "invalid_args", message: expect.stringContaining("the run is the Sandbox's") } });
    }
    const orphan = await run(ownerToken, { months: 3 });
    expect(orphan).toMatchObject({ ok: false, error: { code: "invalid_args" } });
  }, 120_000);

  it("refuses a start_date that isn't a calendar date, at once (the months are walked from it)", async () => {
    for (const start_date of ["2026-13-01", "2026-99-99", "2026-02-30", "2026-00-10", "1999-12-31", "2101-01-01"]) {
      const started = Date.now();
      const r = await run(ownerToken, { scenario: "Hire in March", start_date });
      expect(r, start_date).toMatchObject({ ok: false, error: { code: "invalid_args", message: expect.stringContaining("calendar date") } });
      expect(Date.now() - started, start_date).toBeLessThan(10_000);
    }
    const leap = await run(ownerToken, { scenario: "No changes", start_date: "2028-02-29", months: 1 });
    expect(leap.ok, JSON.stringify(leap.error)).toBe(true);
  }, 120_000);

  it("finds no scenario of another workspace, by id or by name, and gives an outsider's token nothing", async () => {
    const other = await admin.query("insert into workspaces (name, slug) values ('Elsewhere', 'elsewhere-run') returning id");
    const otherWs = other.rows[0].id as string;
    const SECRET = "5c000000-0000-4000-8000-0000000000e1";
    await admin.query("insert into sandbox_scenarios (id, workspace_id, name, changes) values ($1, $2, 'Secret plan', '[]'::jsonb)", [SECRET, otherWs]);
    for (const scenario of [SECRET, "Secret plan"]) {
      const r = await run(ownerToken, { scenario });
      expect(r, scenario).toMatchObject({ ok: false, error: { code: "not_found" } });
      // The message echoes what was asked; nothing else about the other workspace's scenario comes back.
      const rest = JSON.stringify(r).replaceAll(scenario, "");
      expect(rest).not.toContain("Secret plan");
      expect(rest).not.toContain(SECRET);
    }
    // Named by the other workspace itself: the Owner of Northbeam isn't a member there.
    const there = await run(ownerToken, { workspace: otherWs, scenario: SECRET });
    expect(there).toMatchObject({ ok: false, error: { code: "not_found" } });
    const outsider = await createUser(admin, "run-outsider@example.com");
    const outsiderToken = await issueToken(admin, outsider);
    for (const args of [{ scenario: "Hire in March" }, { workspace: NORTHBEAM_WORKSPACE_ID, scenario: NORTHBEAM_HIRE_MARCH_ID }]) {
      const r = await run(outsiderToken, args);
      expect(r, JSON.stringify(args)).toMatchObject({ ok: false, error: { code: "not_found" } });
      expect(JSON.stringify(r)).not.toContain("Hire in March");
    }
    const guest = await createUser(admin, "run-guest@example.com", { guest: true });
    const guestToken = await issueToken(admin, guest);
    expect(await run(guestToken, { workspace: NORTHBEAM_WORKSPACE_ID, scenario: NORTHBEAM_HIRE_MARCH_ID })).toMatchObject({ ok: false, error: { code: "not_found" } });
  }, 120_000);

  it("keeps a 24-month answer bounded: no per-person rows unless asked, and under 1 MB with them", async () => {
    const r = await run(ownerToken, { scenario: "Hire in March", months: 24 });
    expect(r.ok, JSON.stringify(r.error)).toBe(true);
    expect(r.data.people).toBeUndefined();
    const withPeople = await run(ownerToken, { scenario: "Hire in March", months: 24, include_people: true });
    expect(JSON.stringify(withPeople).length).toBeLessThan(1_000_000);
  }, 120_000);

  it("leaves run_scenario without `scenario` as it was: a whole-run overrides run", async () => {
    const client = await connect(ownerToken, env.options);
    const r = await call<{ kpi: unknown; overrides: unknown[]; series?: unknown }>(client, "run_scenario", { workspace: "northbeam", reps: 3, start_date: START, overrides: [{ path: "demand.leads_per_week", op: "set", value: 9 }] });
    await client.close();
    expect(r.ok).toBe(true);
    expect(r.data.kpi).toBeDefined();
    expect(r.data.series).toBeUndefined();
  }, 120_000);

  it("refuses a start_date that isn't a calendar date in the whole-run mode too (same check as saved mode)", async () => {
    const client = await connect(ownerToken, env.options);
    try {
      for (const start_date of ["2026-13-01", "2026-02-30", "1999-12-31", "2101-01-01"]) {
        const r = await call(client, "run_scenario", { workspace: "northbeam", reps: 3, start_date });
        expect(r, start_date).toMatchObject({ ok: false, error: { code: "invalid_args", message: expect.stringContaining("calendar date") } });
      }
      const ok = await call(client, "run_scenario", { workspace: "northbeam", reps: 3, start_date: "2028-02-29" });
      expect(ok.ok, JSON.stringify(ok.error)).toBe(true);
    } finally {
      await client.close();
    }
  }, 120_000);

  it("runs a two-run scenario at 12 months in under 3 s on the server (timing: alone, not under load)", async () => {
    const r = await run(ownerToken, { scenario: "Hire in March", months: 12, include_baseline: false });
    expect(r.ok, JSON.stringify(r.error)).toBe(true);
    const ms = (r.data as unknown as { duration_ms: number }).duration_ms;
    console.info(`run_scenario saved mode, Hire in March at 12 months: ${ms} ms (limit 3000)`);
    expect(ms).toBeLessThan(3000);
  }, 120_000);

  it("stays a read: nothing it runs is stored", async () => {
    const before = (await admin.query("select count(*)::int as n from sandbox_scenarios")).rows[0].n;
    await run(ownerToken, { scenario: "Hire in March" });
    expect((await admin.query("select count(*)::int as n from sandbox_scenarios")).rows[0].n).toBe(before);
  }, 120_000);

});
