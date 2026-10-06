import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { churnProposals, measureChurn, type BackSolvedChurn, type CalibrationProposal, type ClientRow } from "@transpera-flow/engine";
import { LARKSPUR_WORKSPACE_ID, NORTHBEAM_WORKSPACE_ID, clientCalibrationServices, northbeamBundle, northbeamServiceIds, type ClientCalibrationRows } from "../src";
import { createTestDb, createUser, type TestDb } from "./harness";

// Calibration from a clients file and a servicing log (issue #41 part 2, migration 20261208000000): an editor records the
// files and applies the churn proposals they pick, which change a client group's normal churn live, `measured`, citing the
// dataset and the calibration. Viewers, strangers and API tokens record and apply nothing; what was proposed never changes.
// Made with Supabase's default privileges.

let db: TestDb;
let editor: { id: string; claims: Record<string, unknown> };
let viewer: { id: string; claims: Record<string, unknown> };
let stranger: { id: string; claims: Record<string, unknown> };

const ws = NORTHBEAM_WORKSPACE_ID;
const q = async (sql: string, params: unknown[] = []) => (await db.client.query(sql, params)).rows;

async function commitAs<T>(claims: Record<string, unknown>, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  await db.client.query("begin");
  try {
    await db.client.query("set local role authenticated");
    await db.client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
    const out = await fn(db.client);
    await db.client.query("commit");
    return out;
  } catch (err) {
    await db.client.query("rollback");
    throw err;
  }
}

type Recorded = {
  status: string;
  draft: unknown;
  results: { key: string; status: string; reason?: string }[];
  calibration_id: string;
  datasets: { clients: string | null; servicing_log: string | null };
};

const FILE = { file_name: "clients-2026.csv", column_map: { client: "Customer", service: "Plan", started: "Signed" }, row_count: 40 };
const LOG = { file_name: "servicing-2026.csv", column_map: { task: "Task", client: "Customer", due: "Due" }, row_count: 120 };

const record = (c: pg.Client, results: unknown, keys: string[] | null, files: { clients?: unknown; log?: unknown } = { clients: FILE, log: LOG }, workspace = ws) =>
  c
    .query("select public.record_client_calibration($1, $2, $3, $4, $5) as r", [workspace, files.clients ?? null, files.log ?? null, results, keys])
    .then((r) => r.rows[0].r as Recorded);

const DAY = 86_400_000;
const WEEK = 7 * DAY;
const ASOF = Date.UTC(2026, 11, 28);
const W0 = ASOF - 52 * WEEK;

/** 20 SEO clients (4 left) and 20 PPC clients (6 left) over the year to 28 Dec 2026. */
function clientsFile(): ClientRow[] {
  const rows: ClientRow[] = [];
  for (const [service, leavers] of [["SEO retainer", 4], ["PPC management", 6]] as const) {
    for (let i = 0; i < 20; i++) rows.push({ client: `${service}-${i}`, service, started: W0 - 20 * WEEK, ended: i < leavers ? W0 + (10 + i) * WEEK : null });
  }
  return rows;
}

const stored = (): ClientCalibrationRows => {
  const b = northbeamBundle();
  return { services: b.services, clientGroups: b.clientGroups ?? [], servicing: [], processes: [], hoursPerWeek: 40 };
};

/** The proposals as the page would compute them (the back-solve is stood in for by fixed bases and multipliers). */
function results(
  bases: Record<string, number> = { [northbeamServiceIds.seo]: 0.0141, [northbeamServiceIds.ppc]: 0.0152 },
  multipliers: Record<string, number> = { [northbeamServiceIds.seo]: 1.35, [northbeamServiceIds.ppc]: 2.1 },
) {
  const services = clientCalibrationServices(stored());
  const measured = measureChurn({ rows: clientsFile(), services, asOf: ASOF });
  const solved: BackSolvedChurn = { bases, multipliers, why: {}, runs: 2, converged: true, simulated: { late: 0.12, resp: null, onb: 5.4 }, engineVersion: "1.7.0", seed: 1, reps: 30, horizonWeeks: 13 };
  const { proposals } = churnProposals(services, measured.services, solved);
  return { kind: "clients", asOf: ASOF, proposals, checks: [{ id: "late", n: 100, value: 0.15, simulated: 0.12, enough: true, blocked: null, note: "x" }] };
}

const groupOf = async (service: "seo" | "ppc") =>
  (await q("select g.id, g.churn_monthly::float8 churn, g.provenance from client_groups g join services s on s.id = g.service_id where g.workspace_id = $1 and s.name = $2", [
    ws,
    service === "seo" ? "SEO retainer" : "PPC management",
  ]))[0];

const proposalOf = (r: { proposals: CalibrationProposal[] }, name: string) => r.proposals.find((p) => p.subject === name)!;

const counts = async () => (await q("select (select count(*) from datasets)::int d, (select count(*) from calibrations)::int c"))[0] as { d: number; c: number };

beforeAll(async () => {
  db = await createTestDb({ supabaseDefaultPrivileges: true });
  editor = await createUser(db, "cc-editor@example.com");
  viewer = await createUser(db, "cc-viewer@example.com");
  stranger = await createUser(db, "cc-stranger@example.com");
  await q("insert into memberships (workspace_id, user_id, role) values ($1, $2, 'editor'), ($1, $3, 'viewer')", [ws, editor.id, viewer.id]);
});

afterAll(async () => {
  await db?.close();
});

describe("the proposals the page would make", () => {
  it("have the shape the migration reads", () => {
    const r = results();
    const seo = proposalOf(r, "SEO retainer");
    expect(seo).toMatchObject({ kind: "churn", target: { table: "client_groups" }, enough: true, proposed: 0.0141, current: 0.03, changed: true, set: { churn_monthly: 0.0141 }, before: { churn_monthly: 0.03 } });
    expect(seo.key).toMatch(/^churn:[0-9a-f-]{36}$/);
    expect(proposalOf(r, "PPC management")).toMatchObject({ enough: true, proposed: 0.0152, before: { churn_monthly: 0.04 } });
  });
});

describe("record_client_calibration", () => {
  const res = results();
  const seo = proposalOf(res, "SEO retainer");
  const ppc = proposalOf(res, "PPC management");
  let first: Recorded;

  it("records both files and applies a ticked churn key: live, measured, citing the dataset and the calibration", async () => {
    const before = await groupOf("seo");
    expect(before.churn).toBe(0.03);
    first = await commitAs(editor.claims, (c) => record(c, res, [seo.key]));
    expect(first.status).toBe("ok");
    expect(first.draft).toBeNull();
    expect(first.results).toEqual([{ key: seo.key, status: "applied" }]);
    expect(first.datasets.clients).toBeTruthy();
    expect(first.datasets.servicing_log).toBeTruthy();

    const datasets = await q("select id, kind, process_id, file_name, row_count, column_map from datasets order by kind");
    expect(datasets.map((d) => d.kind)).toEqual(["clients", "servicing_log"]);
    expect(datasets.every((d) => d.process_id === null)).toBe(true);
    expect(datasets.find((d) => d.kind === "clients")).toMatchObject({ id: first.datasets.clients, file_name: FILE.file_name, row_count: 40, column_map: FILE.column_map });
    expect(datasets.find((d) => d.kind === "servicing_log")).toMatchObject({ id: first.datasets.servicing_log, row_count: 120 });

    const [cal] = await q("select dataset_id, process_id, results, applied, applied_keys, applied_by from calibrations where id = $1", [first.calibration_id]);
    expect(cal.dataset_id).toBe(first.datasets.clients);
    expect(cal.process_id).toBeNull();
    expect(cal.results.datasets).toEqual({ clients: first.datasets.clients, servicing_log: first.datasets.servicing_log });
    expect(cal.results.proposals).toHaveLength(2);
    expect(cal.applied).toBe(true);
    expect(cal.applied_keys).toEqual([seo.key]);
    expect(cal.applied_by).toBe(editor.id);

    const g = await groupOf("seo");
    expect(g.churn).toBe(0.0141);
    // measured, not turned `entered` by stamp_provenance
    expect(g.provenance.churn_monthly).toMatchObject({
      source: "measured",
      dataset_id: first.datasets.clients,
      calibration_id: first.calibration_id,
      by: editor.id,
      n: seo.n,
      leavers: seo.leavers,
      measured: seo.measured,
      multiplier: 1.35,
    });
    // the other group and the other columns are untouched
    expect((await groupOf("ppc")).churn).toBe(0.04);
    expect(g.provenance.fee.source).toBe("estimated");

    const audit = await q("select actor_id, actor_kind, action, diff from audit_log where target_table = 'client_groups' and target_id = $1", [g.id]);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actor_id: editor.id, actor_kind: "user", action: "update" });
    expect(Number(audit[0].diff.new.churn_monthly)).toBe(0.0141);
  });

  it("records the checks alone when no key is ticked", async () => {
    const start = await counts();
    const out = await commitAs(editor.claims, (c) => record(c, res, null, { log: LOG }));
    expect(out).toMatchObject({ status: "ok", draft: null, results: [] });
    expect(out.datasets).toEqual({ clients: null, servicing_log: expect.any(String) });
    expect(await counts()).toEqual({ d: start.d + 1, c: start.c + 1 });
    const [cal] = await q("select dataset_id, applied, applied_keys from calibrations where id = $1", [out.calibration_id]);
    expect(cal).toEqual({ dataset_id: out.datasets.servicing_log, applied: false, applied_keys: [] });
    const empty = await commitAs(editor.claims, (c) => record(c, res, [], { clients: FILE }));
    expect(empty.results).toEqual([]);
    expect((await groupOf("ppc")).churn).toBe(0.04);
  });

  it("refuses a call with neither file", async () => {
    const start = await counts();
    await expect(commitAs(editor.claims, (c) => record(c, res, [ppc.key], {}))).rejects.toMatchObject({ code: "22023", message: expect.stringMatching(/clients file or a servicing log/) });
    expect(await counts()).toEqual(start);
  });

  it("applies nothing and records nothing for a viewer, a stranger or an API token, with or without keys", async () => {
    const start = await counts();
    const g = await groupOf("ppc");
    for (const keys of [[ppc.key], null]) {
      await expect(commitAs(viewer.claims, (c) => record(c, res, keys))).rejects.toThrow(/row-level security/);
      await expect(commitAs(stranger.claims, (c) => record(c, res, keys))).rejects.toThrow(/row-level security/);
      await expect(commitAs({ ...editor.claims, api_token_id: "t1" }, (c) => record(c, res, keys))).rejects.toMatchObject({
        code: "42501",
        message: expect.stringMatching(/by a person in the app/),
      });
    }
    expect(await counts()).toEqual(start);
    expect(await groupOf("ppc")).toEqual(g);
  });

  it("applies a key once, and skips a group whose churn changed since the proposal", async () => {
    const again = await commitAs(editor.claims, (c) => c.query("select public.apply_calibration($1, $2) as r", [first.calibration_id, [seo.key]]).then((r) => r.rows[0].r));
    expect(again.results).toEqual([{ key: seo.key, status: "already_applied" }]);

    // Someone sets PPC's churn after the calibration was computed (a person's edit: entered).
    await commitAs(editor.claims, (c) => c.query("update client_groups set churn_monthly = 0.05 where id = $1", [ppc.target.id]));
    const out = await commitAs(editor.claims, (c) => record(c, res, [ppc.key]));
    expect(out.results).toEqual([{ key: ppc.key, status: "changed" }]);
    const g = await groupOf("ppc");
    expect(g.churn).toBe(0.05);
    expect(g.provenance.churn_monthly.source).toBe("entered");
    const [cal] = await q("select applied, applied_keys from calibrations where id = $1", [out.calibration_id]);
    expect(cal).toEqual({ applied: false, applied_keys: [] });
    // Put it back for what follows.
    await commitAs(editor.claims, (c) => c.query("update client_groups set churn_monthly = 0.04 where id = $1", [ppc.target.id]));
  });

  it("does not find another workspace's group, and writes nothing of theirs", async () => {
    await q(
      `insert into client_groups (workspace_id, service_id, client_count, churn_monthly)
       select workspace_id, id, 5, 0.02 from services where workspace_id = $1 order by id limit 1 on conflict do nothing`,
      [LARKSPUR_WORKSPACE_ID],
    );
    const [theirs] = await q("select id, churn_monthly::float8 churn, provenance from client_groups where workspace_id = $1 order by id limit 1", [LARKSPUR_WORKSPACE_ID]);
    const aimed = { ...res, proposals: [{ ...seo, key: `churn:${theirs.id}`, target: { table: "client_groups", id: theirs.id }, before: { churn_monthly: theirs.churn }, set: { churn_monthly: 0.01 } }] };
    const out = await commitAs(editor.claims, (c) => record(c, aimed, [`churn:${theirs.id}`]));
    expect(out.results).toEqual([{ key: `churn:${theirs.id}`, status: "not_found" }]);
    expect((await q("select churn_monthly::float8 churn, provenance from client_groups where id = $1", [theirs.id]))[0]).toEqual({ churn: theirs.churn, provenance: theirs.provenance });
  });

  it("skips values that aren't a share from 0 to 1, with why, and writes nothing", async () => {
    const before = await groupOf("ppc");
    const spoil = (set: unknown, beforev: unknown) => ({ ...res, proposals: [{ ...ppc, set, before: beforev }] });
    for (const [set, beforev, reason] of [
      [{ churn_monthly: 1.5 }, { churn_monthly: 0.04 }, /churn_monthly is not a share/],
      [{ churn_monthly: "0.01" }, { churn_monthly: 0.04 }, /churn_monthly is not a share/],
      [{ churn_monthly: -0.1 }, { churn_monthly: 0.04 }, /churn_monthly is not a share/],
      [{ churn_monthly: 0.01 }, { churn_monthly: "0.04" }, /earlier churn_monthly is not a number/],
    ] as const) {
      const out = await commitAs(editor.claims, (c) => record(c, spoil(set, beforev), [ppc.key]));
      expect(out.results[0]).toMatchObject({ key: ppc.key, status: "invalid", reason: expect.stringMatching(reason) });
    }
    expect(await groupOf("ppc")).toEqual(before);
  });

  it("skips a key that isn't proposed, and one aimed at another table", async () => {
    const out = await commitAs(editor.claims, (c) => record(c, { ...res, proposals: [{ ...ppc, target: { table: "steps", id: ppc.target.id } }] }, ["churn:nonsense", ppc.key]));
    expect(Object.fromEntries(out.results.map((r) => [r.key, r.status]))).toEqual({ "churn:nonsense": "not_proposed", [ppc.key]: "not_proposed" });
  });

  it("never changes what was proposed, and nobody deletes a dataset or a calibration", async () => {
    await expect(db.as(editor.claims, (c) => c.query("update calibrations set results = '{\"proposals\": []}' where id = $1", [first.calibration_id]))).rejects.toThrow(/permission denied/);
    await expect(db.as(editor.claims, (c) => c.query("delete from datasets where id = $1", [first.datasets.clients]))).rejects.toThrow(/permission denied/);
    await expect(q("update calibrations set results = '{\"proposals\": []}' where id = $1", [first.calibration_id])).rejects.toThrow(/never change/);
  });

  it("lets a viewer and a member read the records", async () => {
    const seen = await db.as(viewer.claims, async (c) => (await c.query("select kind from datasets where kind in ('clients', 'servicing_log') order by kind")).rows);
    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(await db.as(stranger.claims, async (c) => (await c.query("select id from datasets")).rows)).toEqual([]);
  });
});

describe("datasets_kind", () => {
  it("accepts clients and servicing_log, keeps the old kinds, and still refuses others", async () => {
    for (const kind of ["clients", "servicing_log", "step_log", "invoices"]) {
      await q("insert into datasets (workspace_id, kind, file_name, row_count) values ($1, $2, 'x.csv', 1)", [ws, kind]);
    }
    await expect(q("insert into datasets (workspace_id, kind, file_name, row_count) values ($1, 'other', 'x.csv', 1)", [ws])).rejects.toThrow(/datasets_kind/);
  });
});
