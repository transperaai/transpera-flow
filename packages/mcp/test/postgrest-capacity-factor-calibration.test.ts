import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { calibrate, proposePersonTimes, type CalibrationResult } from "@transpera-flow/engine";
import { calibrationInput, loadProcessBundle, splitCsv, type Database, type ProcessRow } from "@transpera-flow/db";
import { applyNameMapEntries, importDetails, personValues, readImport, suggestMapping, suggestNameMap, timeLogPersonVisits } from "@transpera-flow/db/csv-import";
import { signJwt } from "./helpers";

// Per-person times measured from a time log that names people (issue #227, migration 20261227000000), as the web app does it:
// over PostgREST, signed in, with Supabase's default privileges and RLS. An editor with Per-person times switched on reads a time
// log, matches the people, computes proposals with `proposePersonTimes`, records the import and applies one. A member reads the
// calibration and finds no person in it, and no rows in `capacity_factor_proposals`. Runs in its own workspace.
// Skipped unless POSTGREST_URL is set (see postgrest-db.ts).

const POSTGREST_URL = process.env.POSTGREST_URL;
const JWT_SECRET = process.env.POSTGREST_JWT_SECRET ?? "";
const ADMIN_URL = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/postgres";
const DATABASE_NAME = process.env.POSTGREST_DATABASE ?? "transpera_flow_postgrest";

let admin: pg.Client;
type Row = Record<string, unknown>;
const one = async (sql: string, params: unknown[] = []) => (await admin.query(sql, params)).rows[0] as Row;

const ids = { ws: "", proc: "", rev: "", role: "", qualify: "", won: "", lost: "", start: "", sam: "", jo: "" };
let editor: SupabaseClient<Database>;
let member: SupabaseClient<Database>;
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

const SETTINGS = { hours_per_week: 40, currency: "AUD", horizon_weeks: 13, leads_per_week: 5, active_clients: 0, churn_monthly: 0, retainer: 1000, capacity_factor_enabled: true };

/** A time log: 12 jobs by Sam at 2 hours and 12 by Jo at 3 hours on "Qualify", so Sam is 0.8 and Jo 1.2 of the step's normal 2.5. */
function timeLogFile(): string {
  const lines = ["Job,Task,Date,Hours,Person"];
  for (let i = 0; i < 24; i++) {
    const day = new Date(Date.UTC(2026, 3, 1) + i * 86_400_000).toISOString().slice(0, 10);
    lines.push(`J${i},qualify,${day},${i % 2 ? 3 : 2},${i % 2 ? "Jo L." : "SAM LEE"}`);
  }
  return lines.join("\n");
}

async function bundle(revisionId: string) {
  const { data: ws } = await editor.from("workspaces").select("id, name, slug, settings").eq("id", ids.ws).single();
  const { data: proc } = await editor.from("processes").select("*").eq("id", ids.proc).single();
  return loadProcessBundle(editor, ws!, proc as unknown as ProcessRow, revisionId);
}

describe.skipIf(!POSTGREST_URL)("per-person times from a time log over PostgREST", () => {
  let results: CalibrationResult;
  let factors: ReturnType<typeof proposePersonTimes>["proposals"] = [];
  let details: unknown;

  beforeAll(async () => {
    const url = new URL(ADMIN_URL);
    url.pathname = `/${DATABASE_NAME}`;
    admin = new pg.Client({ connectionString: url.toString() });
    await admin.connect();
    const tag = randomUUID().slice(0, 8);
    ids.ws = (await one("insert into workspaces (name, slug, settings) values ('Person Times Co', $1, $2) returning id", [`ptimes-${tag}`, SETTINGS])).id as string;
    ids.role = (await one("insert into roles (workspace_id, name) values ($1, 'Sales') returning id", [ids.ws])).id as string;
    ids.sam = (await one("insert into people (workspace_id, name, fte) values ($1, 'Sam Lee', 1) returning id", [ids.ws])).id as string;
    ids.jo = (await one("insert into people (workspace_id, name, fte) values ($1, 'Jo Long', 1) returning id", [ids.ws])).id as string;
    await admin.query("insert into person_roles (person_id, role_id, workspace_id) select id, $2, $1 from people where workspace_id = $1", [ids.ws, ids.role]);
    ids.proc = (await one("insert into processes (workspace_id, name, kind, entity_name) values ($1, 'Enquiry to signed', 'pipeline', 'enquiry') returning id", [ids.ws])).id as string;
    ids.rev = (await one("insert into process_revisions (workspace_id, process_id, number, status) values ($1, $2, 1, 'published') returning id", [ids.ws, ids.proc])).id as string;
    await admin.query("update processes set live_revision_id = $2 where id = $1", [ids.proc, ids.rev]);
    for (const k of ["start", "qualify", "won", "lost"] as const) ids[k] = randomUUID();
    const step = (id: string, name: string, kind: string, role: string | null, work: number, outcome: string | null) =>
      admin.query(
        "insert into steps (id, revision_id, workspace_id, process_id, name, kind, role_id, work_hours, wait_hours, outcome) values ($1, $2, $3, $4, $5, $6, $7, $8, 0, $9)",
        [id, ids.rev, ids.ws, ids.proc, name, kind, role, work, outcome],
      );
    await step(ids.start, "Enquiry arrives", "start", null, 0, null);
    await step(ids.qualify, "Qualify", "task", ids.role, 0.5, null);
    await step(ids.won, "Won", "end", null, 0, "won");
    await step(ids.lost, "Lost", "end", null, 0, "lost");
    const edge = (from: string, to: string, p: number) =>
      admin.query("insert into edges (revision_id, workspace_id, process_id, from_step_id, to_step_id, probability) values ($1, $2, $3, $4, $5, $6)", [ids.rev, ids.ws, ids.proc, from, to, p]);
    await edge(ids.start, ids.qualify, 1);
    await edge(ids.qualify, ids.won, 0.5);
    await edge(ids.qualify, ids.lost, 0.5);

    const [ed, mb] = [randomUUID(), randomUUID()];
    await admin.query("insert into auth.users (id, email) values ($1, $2), ($3, $4)", [ed, `pt-editor-${tag}@example.com`, mb, `pt-member-${tag}@example.com`]);
    await admin.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, 'editor'), ($1, $3, 'member')", [ids.ws, ed, mb]);
    const token = (sub: string) => signJwt({ sub, role: "authenticated", aud: "authenticated", app_metadata: {} }, JWT_SECRET);
    editor = client(token(ed));
    member = client(token(mb));
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

  it("reads the log, matches the people and computes a time for each", async () => {
    const live = await bundle(ids.rev);
    const table = splitCsv(timeLogFile());
    const mapping = suggestMapping(table[0]!, "time_logs");
    const read = readImport(table, "time_logs", mapping.index);
    expect(read.errors).toEqual([]);
    const targets = live.steps.map((s) => s.name);
    const stepMap = suggestNameMap(read.names, targets);
    expect(stepMap).toEqual({ qualify: "Qualify" });
    // "SAM LEE" matches Sam Lee once normalised; "Jo L." is matched by hand.
    const people = (live.people ?? []).map((p) => p.name);
    const personMap = { ...suggestNameMap(personValues(read), people), "Jo L.": "Jo Long" };
    expect(personMap).toEqual({ "Jo L.": "Jo Long", "SAM LEE": "Sam Lee" });
    const byName = new Map((live.people ?? []).map((p) => [p.name, p.id]));
    const entries = applyNameMapEntries(read, stepMap)!.map((e) => ({ ...e, person: e.person ? (byName.get(personMap[e.person as keyof typeof personMap] as string) ?? null) : null }));
    const rows = timeLogPersonVisits(entries);
    expect(rows).toHaveLength(24);
    const input = calibrationInput(
      { process: live.process, steps: live.steps, edges: live.edges, services: live.services, leadSources: live.leadSources ?? [], seasonality: live.seasonality ?? [], hoursPerWeek: 40 },
      rows.map(({ person: _p, ...r }) => r) as never,
    );
    results = calibrate(input);
    details = importDetails(read, { delimiter: ",", encoding: "utf-8", headerRow: 1, nameMatches: { matched: 24, leftOut: 0 }, rows: rows.map(({ person: _p, ...r }) => r) as never });
    const out = proposePersonTimes({
      steps: input.steps,
      rows,
      people: [ids.sam, ids.jo].map((id) => ({ id, canDo: [ids.qualify], every: null, steps: {} })),
    });
    factors = out.proposals;
    expect(factors.map((f) => [f.personId, f.proposed, f.n, f.stepN])).toEqual([
      [ids.sam, 0.8, 12, 24],
      [ids.jo, 1.2, 12, 24],
    ]);
    // Nothing about a person is in what `calibrate` proposes or in the stored details.
    expect(JSON.stringify([results, details])).not.toMatch(new RegExp(`${ids.sam}|${ids.jo}|Sam Lee|SAM LEE|Jo L`));
  });

  const args = (keys: string[], f = factors) => ({
    p_workspace: ids.ws,
    p_process: ids.proc,
    p_kind: "time_logs",
    p_file_name: "timesheets.csv",
    p_column_map: { job: "Column 1", task: "Task", date: "Date", hours: "Hours", person: "Column 5" },
    p_row_count: 24,
    p_details: details as never,
    p_results: { ...results, capacity_factors: f } as never,
    p_keys: keys,
  });

  it("refuses a member and anon, and records nothing", async () => {
    const before = Number((await one("select count(*)::int n from datasets where workspace_id = $1", [ids.ws])).n);
    for (const who of [member, anon]) expect((await who.rpc("record_calibration_import", args([factors[0]!.key]))).error).not.toBeNull();
    expect(Number((await one("select count(*)::int n from datasets where workspace_id = $1", [ids.ws])).n)).toBe(before);
  });

  it("records as an editor and applies the ticked time, measured and linked to the dataset", async () => {
    const out = await editor.rpc("record_calibration_import", args([factors[0]!.key]));
    expect(out.error).toBeNull();
    const data = out.data as { status: string; dataset_id: string; calibration_id: string; results: { key: string; status: string }[] };
    expect(data).toMatchObject({ status: "ok", results: [{ key: factors[0]!.key, status: "applied" }] });
    const live = await bundle(ids.rev);
    const mine = (live.personCapacityFactors ?? []).filter((f) => f.person_id === ids.sam);
    expect(mine).toHaveLength(1);
    expect(Number(mine[0]!.factor)).toBe(0.8);
    const stored = await one("select factor::float8 as factor, provenance from person_capacity_factors where person_id = $1 and step_id = $2", [ids.sam, ids.qualify]);
    expect(stored.factor).toBe(0.8);
    expect((stored.provenance as Record<string, Record<string, unknown>>).factor).toMatchObject({ source: "measured", dataset_id: data.dataset_id, calibration_id: data.calibration_id, n: 12 });
    // Both proposals are kept, where the editor reads them.
    const kept = await editor.from("capacity_factor_proposals").select("person_id, step_id").eq("calibration_id", data.calibration_id);
    expect(kept.data).toHaveLength(2);
  });

  it("lets a member read the calibration and finds no person in it, and none of the proposals", async () => {
    const cals = await member.from("calibrations").select("*").eq("workspace_id", ids.ws);
    expect(cals.error).toBeNull();
    expect(cals.data!.length).toBeGreaterThan(0);
    const text = JSON.stringify(cals.data);
    for (const needle of [ids.sam, ids.jo, "Sam Lee", "SAM LEE", "Jo L", "Jo Long", "capacity_factors"]) expect(text, needle).not.toContain(needle);
    const hidden = await member.from("capacity_factor_proposals").select("*").eq("workspace_id", ids.ws);
    expect(hidden.error).toBeNull();
    expect(hidden.data).toEqual([]);
    expect((await anon.from("capacity_factor_proposals").select("*")).data ?? []).toEqual([]);
    expect((await editor.from("capacity_factor_proposals").update({ step_id: ids.qualify }).eq("workspace_id", ids.ws)).error).not.toBeNull();
  });
});
