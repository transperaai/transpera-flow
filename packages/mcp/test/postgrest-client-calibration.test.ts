import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { backSolveChurn, churnProposals, measureChurn, simulate, STABLE_MARKET, type BackSolvedChurn, type CalibrationProposal, type ClientRow } from "@transpera-flow/engine";
import { clientCalibrationServices, loadProcessBundle, toEngineModel, type Database, type ProcessRow } from "@transpera-flow/db";
import { signJwt } from "./helpers";

// Calibration from a clients file (issue #41 part 2, migration 20261208000000) as the web app does it: over PostgREST, signed in,
// with Supabase's default privileges and RLS. The live model is loaded, normal churn is measured from a clients file and
// back-solved through today's churn drivers, and an editor records the file and applies the proposal in one call. Reloading the
// model gives the client group the proposed churn, `measured`, citing the dataset; the market's Stable level is then the
// calibrated churn. A viewer and an anonymous caller record and apply nothing. Runs in its own workspace.
// Skipped unless POSTGREST_URL is set (see postgrest-db.ts).

const POSTGREST_URL = process.env.POSTGREST_URL;
const JWT_SECRET = process.env.POSTGREST_JWT_SECRET ?? "";
const ADMIN_URL = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/postgres";
const DATABASE_NAME = process.env.POSTGREST_DATABASE ?? "transpera_flow_postgrest";

let admin: pg.Client;
type Row = Record<string, unknown>;
const one = async (sql: string, params: unknown[] = []) => (await admin.query(sql, params)).rows[0] as Row;

const ids = { ws: "", proc: "", rev: "", role: "", service: "", group: "", start: "", qualify: "", won: "" };
let editor: SupabaseClient<Database>;
let viewer: SupabaseClient<Database>;
let anon: SupabaseClient<Database>;

function client(token: string): SupabaseClient<Database> {
  return createClient<Database>("http://postgrest.invalid", token, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      headers: { authorization: `Bearer ${token}` },
      fetch: (input, init) => fetch(String(input instanceof Request ? input.url : input).replace("http://postgrest.invalid/rest/v1", POSTGREST_URL!), init),
    },
  });
}

const SETTINGS = { hours_per_week: 40, currency: "AUD", horizon_weeks: 13, leads_per_week: 2, active_clients: 0, churn_monthly: 0, retainer: 1000 };
const DAY = 86_400_000;
const WEEK = 7 * DAY;
const ASOF = Date.UTC(2026, 11, 28);

/** 24 clients of "Retainer" in the year to 28 Dec 2026: 19 stay, 5 left between 3 and 8 months in. */
function clientsFile(): ClientRow[] {
  const rows: ClientRow[] = [];
  for (let i = 0; i < 24; i++) rows.push({ client: `C${i}`, service: "Retainer", started: ASOF - 70 * WEEK, ended: i < 5 ? ASOF - (45 - i * 4) * WEEK : null });
  return rows;
}

async function bundle(revisionId: string) {
  const { data: ws } = await editor.from("workspaces").select("id, name, slug, settings").eq("id", ids.ws).single();
  const { data: proc } = await editor.from("processes").select("*").eq("id", ids.proc).single();
  return loadProcessBundle(editor, ws!, proc as unknown as ProcessRow, revisionId);
}

describe.skipIf(!POSTGREST_URL)("calibration from a clients file over PostgREST", () => {
  let proposal: CalibrationProposal;
  let results: Record<string, unknown>;
  let solved: BackSolvedChurn;
  let measuredMonthly = 0;

  beforeAll(async () => {
    const url = new URL(ADMIN_URL);
    url.pathname = `/${DATABASE_NAME}`;
    admin = new pg.Client({ connectionString: url.toString() });
    await admin.connect();
    const tag = randomUUID().slice(0, 8);
    ids.ws = (await one("insert into workspaces (name, slug, settings) values ('Clients Co', $1, $2) returning id", [`clients-${tag}`, SETTINGS])).id as string;
    ids.role = (await one("insert into roles (workspace_id, name) values ($1, 'Sales') returning id", [ids.ws])).id as string;
    await admin.query("insert into people (workspace_id, name, fte) values ($1, 'Sam Lee', 1)", [ids.ws]);
    await admin.query("insert into person_roles (person_id, role_id, workspace_id) select id, $2, $1 from people where workspace_id = $1", [ids.ws, ids.role]);
    await admin.query("insert into lead_sources (workspace_id, name, volume_week, conversion_to_qualified) values ($1, 'Website', 3, 0.5)", [ids.ws]);
    ids.service = (await one("insert into services (workspace_id, name, price, churn_monthly_base) values ($1, 'Retainer', 1000, 0.03) returning id", [ids.ws])).id as string;
    ids.group = (
      await one("insert into client_groups (workspace_id, service_id, client_count, fee, churn_monthly, stay_months, starting_health) values ($1, $2, 24, 1000, 0.03, 12, 70) returning id", [
        ids.ws,
        ids.service,
      ])
    ).id as string;
    ids.proc = (await one("insert into processes (workspace_id, name, kind, entity_name) values ($1, 'Enquiry to signed', 'pipeline', 'enquiry') returning id", [ids.ws])).id as string;
    ids.rev = (await one("insert into process_revisions (workspace_id, process_id, number, status) values ($1, $2, 1, 'published') returning id", [ids.ws, ids.proc])).id as string;
    await admin.query("update processes set live_revision_id = $2 where id = $1", [ids.proc, ids.rev]);
    for (const k of ["start", "qualify", "won"] as const) ids[k] = randomUUID();
    const step = (id: string, name: string, kind: string, role: string | null, work: number, outcome: string | null) =>
      admin.query(
        "insert into steps (id, revision_id, workspace_id, process_id, name, kind, role_id, work_hours, wait_hours, outcome) values ($1, $2, $3, $4, $5, $6, $7, $8, 0, $9)",
        [id, ids.rev, ids.ws, ids.proc, name, kind, role, work, outcome],
      );
    await step(ids.start, "Enquiry arrives", "start", null, 0, null);
    await step(ids.qualify, "Qualify", "task", ids.role, 0.5, null);
    await step(ids.won, "Won", "end", null, 0, "won");
    const edge = (from: string, to: string) =>
      admin.query("insert into edges (revision_id, workspace_id, process_id, from_step_id, to_step_id, probability) values ($1, $2, $3, $4, $5, 1)", [ids.rev, ids.ws, ids.proc, from, to]);
    await edge(ids.start, ids.qualify);
    await edge(ids.qualify, ids.won);

    const [ed, vw] = [randomUUID(), randomUUID()];
    await admin.query("insert into auth.users (id, email) values ($1, $2), ($3, $4)", [ed, `cc-editor-${tag}@example.com`, vw, `cc-viewer-${tag}@example.com`]);
    await admin.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, 'editor'), ($1, $3, 'viewer')", [ids.ws, ed, vw]);
    const token = (sub: string) => signJwt({ sub, role: "authenticated", aud: "authenticated", app_metadata: {} }, JWT_SECRET);
    editor = client(token(ed));
    viewer = client(token(vw));
    anon = client(signJwt({ role: "anon" }, JWT_SECRET));
    const deadline = Date.now() + 60_000;
    while ((await editor.from("processes").select("id").eq("id", ids.proc)).data?.length !== 1) {
      if (Date.now() > deadline) throw new Error("PostgREST never became ready");
      await new Promise((r) => setTimeout(r, 1000));
    }
  });

  afterAll(async () => {
    await admin?.end();
  });

  const datasets = async () => Number((await one("select count(*)::int n from datasets where workspace_id = $1", [ids.ws])).n);

  it("measures churn from the file and back-solves it against the live model as loaded over PostgREST", async () => {
    const live = await bundle(ids.rev);
    const services = clientCalibrationServices({ services: live.services, clientGroups: live.clientGroups ?? [] });
    expect(services).toHaveLength(1);
    expect(services[0]!.group).toMatchObject({ id: ids.group, churnMonthly: 0.03, count: 24, source: "estimated" });
    const measured = measureChurn({ rows: clientsFile(), services, asOf: ASOF });
    const m = measured.services[0]!;
    expect(m).toMatchObject({ clients: 24, leavers: 5, enough: true });
    measuredMonthly = m.monthly!;
    expect(measuredMonthly).toBeGreaterThan(0);

    solved = backSolveChurn(toEngineModel(live), { [ids.service]: measuredMonthly }, { reps: 8 });
    // The model's drivers (late work, at the group's starting health) add churn, so normal churn is below what was measured.
    expect(solved.bases[ids.service]).toBeLessThan(measuredMonthly);
    expect(solved.why).toEqual({});

    const out = churnProposals(services, measured.services, solved);
    expect(out.noGroup).toEqual([]);
    proposal = out.proposals[0]!;
    expect(proposal).toMatchObject({ key: `churn:${ids.group}`, kind: "churn", enough: true, changed: true, current: 0.03 });
    results = {
      kind: "clients",
      asOf: ASOF,
      window: measured.window,
      rows: measured.rows,
      clients: measured.clients,
      tasks: 0,
      startsAfterAsOf: 0,
      unmatchedServices: 0,
      unmatchedTasks: 0,
      noGroup: [],
      proposals: out.proposals,
      checks: [],
      run: { engineVersion: solved.engineVersion, seed: solved.seed, reps: solved.reps, horizonWeeks: solved.horizonWeeks, runs: solved.runs, converged: solved.converged, processIds: [ids.proc] },
    };
  });

  const args = (keys: string[]) => ({
    p_workspace: ids.ws,
    p_clients: { file_name: "clients.csv", column_map: { client: "Customer", service: "Plan", started: "Signed" }, row_count: 24 },
    p_log: null,
    p_results: results as never,
    p_keys: keys,
  });

  it("records nothing and applies nothing for a viewer or anon", async () => {
    const before = await datasets();
    const v = await viewer.rpc("record_client_calibration", args([proposal.key]));
    expect(v.error).not.toBeNull();
    const a = await anon.rpc("record_client_calibration", args([proposal.key]));
    expect(a.error).not.toBeNull();
    expect(await datasets()).toBe(before);
    expect(Number((await one("select churn_monthly::float8 c from client_groups where id = $1", [ids.group])).c)).toBe(0.03);
  });

  it("records and applies in one call as the page does", async () => {
    const out = await editor.rpc("record_client_calibration", args([proposal.key]));
    expect(out.error).toBeNull();
    const data = out.data as { status: string; calibration_id: string; datasets: { clients: string | null; servicing_log: string | null }; results: { key: string; status: string }[] };
    expect(data).toMatchObject({ status: "ok", results: [{ key: proposal.key, status: "applied" }], datasets: { servicing_log: null } });
    expect(data.datasets.clients).toBeTruthy();
    expect((await one("select kind from datasets where id = $1", [data.datasets.clients])).kind).toBe("clients");

    // Reloading the model: the group has the proposed churn, measured, citing the dataset and the calibration.
    const live = await bundle(ids.rev);
    const group = live.clientGroups!.find((g) => g.id === ids.group)!;
    expect(Number(group.churn_monthly)).toBe(proposal.proposed);
    expect(group.provenance.churn_monthly).toMatchObject({ source: "measured", dataset_id: data.datasets.clients, calibration_id: data.calibration_id, n: 24, leavers: 5 });
    expect(clientCalibrationServices({ services: live.services, clientGroups: live.clientGroups ?? [] })[0]!.group).toMatchObject({ churnMonthly: proposal.proposed, source: "measured" });

    // The same proposal again is a new calibration, but the group's churn has moved since it was computed: skipped, not overwritten.
    const again = await editor.rpc("record_client_calibration", args([proposal.key]));
    expect(again.data).toMatchObject({ results: [{ key: proposal.key, status: "changed" }] });
  });

  it("makes the calibrated churn the Stable market level: a run with Stable in every month is the run without a market", async () => {
    const model = toEngineModel(await bundle(ids.rev));
    expect(model.clientGroups![ids.service]!.churnMonthly).toBe(proposal.proposed);
    const stable = { ...model, horizonWeeks: 8, market: { months: Array.from({ length: 24 }, () => ({ ...STABLE_MARKET })) } };
    const plain = { ...model, horizonWeeks: 8 };
    const a = simulate(stable, 3, 7);
    const b = simulate(plain, 3, 7);
    expect(a.won).toEqual(b.won);
    expect(a.churnCauses?.clients).toEqual(b.churnCauses?.clients);
  });
});
