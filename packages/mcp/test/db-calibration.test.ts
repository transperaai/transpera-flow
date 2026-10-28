import { randomUUID } from "node:crypto";
import type { Db } from "@transpera-flow/db";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { calibrate, estimatedParameters, provenanceFromRows, simulate, STABLE_MARKET, type CalibrationResult } from "@transpera-flow/engine";
import { rpc } from "@transpera-flow/db/client";
import { calibrationInput, loadProcessBundle, parseStepLog, toEngineModel, type ProcessRow } from "@transpera-flow/db";
import { errorOf, startTestDb, userClaims, type McpTestDb } from "./helpers";

// Calibration from historical data (issue #41, migration 20261202000000) as the web app does it: through Kysely, signed in,
// under RLS. An editor stores the dataset record and the calibration and applies the
// proposals they tick; the measured values reach the live model only when the draft is published. Then the model the engine
// runs has the measured lead volume (so the market's Stable level, 100% of today, is the measured one), and the robustness
// check no longer perturbs what was measured. A viewer and an anonymous caller apply nothing. Runs in its own workspace.
// Runs on a throwaway database (test/helpers.ts).


let env: McpTestDb;
let admin: pg.Client;
type Row = Record<string, unknown>;
const one = async (sql: string, params: unknown[] = []) => (await admin.query(sql, params)).rows[0] as Row;

const ids = { ws: "", proc: "", rev: "", role: "", source: "", qualify: "", decide: "", won: "", lost: "", start: "" };
let editor: Db;
let viewer: Db;
let anon: Db;

const SETTINGS = { hours_per_week: 40, currency: "AUD", horizon_weeks: 13, leads_per_week: 5, active_clients: 0, churn_monthly: 0, retainer: 1000 };

/** Twenty-four enquiries over twelve weeks: qualifying takes 1 or 2 hours, two thirds go on, clients decide in 2 days. */
function log(): string {
  const lines = ["item,step,started,finished,hours,source"];
  for (let i = 0; i < 24; i++) {
    const day = new Date(Date.UTC(2026, 3, 1) + i * 3.5 * 86_400_000);
    const at = (d: number, h: number) => new Date(day.getTime() + d * 86_400_000 + h * 3_600_000).toISOString();
    lines.push(`E${i},Qualify,${at(0, 9)},${at(0, 11)},${1 + (i % 2)},Website`);
    if (i % 3 === 2) {
      lines.push(`E${i},Lost,${at(1, 9)},,,`);
      continue;
    }
    lines.push(`E${i},Client decides,${at(1, 9)},${at(3, 9)},,`);
    lines.push(`E${i},${i % 2 ? "Won" : "Lost"},${at(3, 9)},,,`);
  }
  return lines.join("\n");
}

async function bundle(revisionId: string) {
  const ws = await editor.selectFrom("workspaces").select(["id", "name", "slug", "settings"]).where("id", "=", ids.ws).executeTakeFirstOrThrow();
  const proc = await editor.selectFrom("processes").selectAll().where("id", "=", ids.proc).executeTakeFirstOrThrow();
  return loadProcessBundle(editor, ws, proc as unknown as ProcessRow, revisionId);
}

describe("calibration", () => {
  let result: CalibrationResult;
  let calibrationId = "";
  let datasetId = "";

  beforeAll(async () => {
    env = await startTestDb();
    admin = env.t.client;
    const tag = randomUUID().slice(0, 8);
    ids.ws = (await one("insert into workspaces (name, slug, settings) values ('Calibrate Co', $1, $2) returning id", [`calibrate-${tag}`, SETTINGS])).id as string;
    ids.role = (await one("insert into roles (workspace_id, name) values ($1, 'Sales') returning id", [ids.ws])).id as string;
    await admin.query("insert into people (workspace_id, name, fte) values ($1, 'Sam Lee', 1)", [ids.ws]);
    await admin.query("insert into person_roles (person_id, role_id, workspace_id) select id, $2, $1 from people where workspace_id = $1", [ids.ws, ids.role]);
    ids.source = (await one("insert into lead_sources (workspace_id, name, volume_week, conversion_to_qualified) values ($1, 'Website', 3, 0.5) returning id", [ids.ws])).id as string;
    ids.proc = (await one("insert into processes (workspace_id, name, kind, entity_name) values ($1, 'Enquiry to signed', 'pipeline', 'enquiry') returning id", [ids.ws])).id as string;
    ids.rev = (await one("insert into process_revisions (workspace_id, process_id, number, status) values ($1, $2, 1, 'published') returning id", [ids.ws, ids.proc])).id as string;
    await admin.query("update processes set live_revision_id = $2 where id = $1", [ids.proc, ids.rev]);
    for (const k of ["start", "qualify", "decide", "won", "lost"] as const) ids[k] = randomUUID();
    const step = (id: string, name: string, kind: string, role: string | null, work: number, wait: number, outcome: string | null) =>
      admin.query(
        "insert into steps (id, revision_id, workspace_id, process_id, name, kind, role_id, work_hours, wait_hours, outcome) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)",
        [id, ids.rev, ids.ws, ids.proc, name, kind, role, work, wait, outcome],
      );
    await step(ids.start, "Enquiry arrives", "start", null, 0, 0, null);
    await step(ids.qualify, "Qualify", "task", ids.role, 0.5, 0, null);
    await step(ids.decide, "Client decides", "task", null, 0, 40, null);
    await step(ids.won, "Won", "end", null, 0, 0, "won");
    await step(ids.lost, "Lost", "end", null, 0, 0, "lost");
    const edge = (from: string, to: string, p: number) =>
      admin.query("insert into edges (revision_id, workspace_id, process_id, from_step_id, to_step_id, probability) values ($1, $2, $3, $4, $5, $6)", [ids.rev, ids.ws, ids.proc, from, to, p]);
    await edge(ids.start, ids.qualify, 1);
    await edge(ids.qualify, ids.decide, 0.5);
    await edge(ids.qualify, ids.lost, 0.5);
    await edge(ids.decide, ids.won, 0.5);
    await edge(ids.decide, ids.lost, 0.5);

    const [ed, vw] = [randomUUID(), randomUUID()];
    await admin.query("insert into auth.users (id, email) values ($1, $2), ($3, $4)", [ed, `cal-editor-${tag}@example.com`, vw, `cal-viewer-${tag}@example.com`]);
    await admin.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, 'owner'), ($1, $3, 'viewer')", [ids.ws, ed, vw]);
    editor = env.dbAs(userClaims(ed));
    viewer = env.dbAs(userClaims(vw));
    anon = env.dbAs(null);
  });

  afterAll(async () => {
    await env?.close();
  });

  it("computes the proposals from the live model as loaded", async () => {
    const live = await bundle(ids.rev);
    const parsed = parseStepLog(log());
    expect(parsed.errors).toEqual([]);
    result = calibrate(
      calibrationInput(
        {
          process: live.process,
          steps: live.steps,
          edges: live.edges,
          services: live.services,
          leadSources: live.leadSources ?? [],
          seasonality: live.seasonality ?? [],
          hoursPerWeek: 40,
        },
        parsed.rows,
      ),
    );
    expect(result.proposals.find((p) => p.key === `work:${ids.qualify}`)).toMatchObject({ n: 24, proposed: 1.5 });
    expect(result.proposals.find((p) => p.key === `wait:${ids.decide}`)).toMatchObject({ n: 16, proposed: 11.43 });
    expect(result.proposals.find((p) => p.key === `arrivals:${ids.source}`)).toMatchObject({ n: 24, enough: true });
  });

  it("stores the dataset and the calibration as an editor; the viewer and anon can't", async () => {
    const d = await editor.insertInto("datasets").values({ workspace_id: ids.ws, kind: "step_log", process_id: ids.proc, file_name: "enquiries.csv", column_map: parseStepLog(log()).columns as never, row_count: result.rows }).returning("id").executeTakeFirstOrThrow();
    datasetId = d.id;
    const c = await editor.insertInto("calibrations").values({ workspace_id: ids.ws, dataset_id: datasetId, process_id: ids.proc, results: result as never }).returning(["id", "applied"]).executeTakeFirstOrThrow();
    expect(c.applied).toBe(false);
    calibrationId = c.id;
    expect(await errorOf(() => viewer.insertInto("datasets").values({ workspace_id: ids.ws, kind: "step_log", file_name: "x.csv", row_count: 1 }).execute())).not.toBeNull();
    // Anon has no access to the table at all: the database refuses the read, so it sees nothing either way.
    expect(await anon.selectFrom("calibrations").select("id").execute().catch(() => [])).toEqual([]);
    expect(await viewer.selectFrom("calibrations").select("id").execute()).toEqual([{ id: calibrationId }]);
  });

  it("applies nothing for a viewer or anon", async () => {
    const keys = [`work:${ids.qualify}`];
    const v = await rpc(viewer, "apply_calibration", { p_calibration: calibrationId, p_keys: keys });
    expect(v).toEqual({ status: "not_found" });
    const a = await errorOf(() => rpc(anon, "apply_calibration", { p_calibration: calibrationId, p_keys: keys }));
    expect(a).not.toBeNull();
    expect((await one("select draft_revision_id from processes where id = $1", [ids.proc])).draft_revision_id).toBeNull();
  });

  it("records and applies in one call as the page does; a viewer's call leaves no record", async () => {
    const before = Number((await one("select count(*)::int n from datasets where workspace_id = $1", [ids.ws])).n);
    const args = { p_workspace: ids.ws, p_process: ids.proc, p_file_name: "again.csv", p_column_map: {}, p_row_count: result.rows, p_results: result as never, p_keys: [`rework:${ids.qualify}`] };
    expect(await errorOf(() => rpc(viewer, "record_calibration", args))).not.toBeNull();
    expect((await one("select count(*)::int n from datasets where workspace_id = $1", [ids.ws])).n).toBe(before);
    const out = await rpc(editor, "record_calibration", args);
    expect(out).toMatchObject({ status: "ok", results: [{ key: `rework:${ids.qualify}`, status: "applied" }] });
    expect((await one("select count(*)::int n from datasets where workspace_id = $1", [ids.ws])).n).toBe(before + 1);
  });

  it("applies the ticked proposals into a draft; publishing makes the measured model live, with the Stable market at the measured level", async () => {
    const keys = result.proposals.filter((p) => p.set && p.changed).map((p) => p.key);
    // Half the clients signed, as the model already said: that one is not a change, so not offered.
    expect(keys.sort()).toEqual([`arrivals:${ids.source}`, `routing:${ids.qualify}`, `wait:${ids.decide}`, `work:${ids.qualify}`].sort());
    const out = await rpc(editor, "apply_calibration", { p_calibration: calibrationId, p_keys: keys });
    const applied = out as { results: { key: string; status: string }[]; draft: { revision_id: string } };
    expect(applied.results.every((r) => r.status === "applied")).toBe(true);
    // Live is untouched until publish (the lead volume is a company fact: it changed live).
    const before = toEngineModel(await bundle(ids.rev));
    expect(before.steps.find((s) => s.id === ids.qualify)!.work).toBe(0.5);

    await rpc(editor, "publish_process", { target_process: ids.proc, accept_estimates: true });
    const live = await bundle(applied.draft.revision_id);
    const model = toEngineModel(live);
    expect(model.steps.find((s) => s.id === ids.qualify)!.work).toBe(1.5);
    expect(model.steps.find((s) => s.id === ids.decide)!.wait).toBe(11.43);
    const arrivals = result.proposals.find((p) => p.key === `arrivals:${ids.source}`)!;
    // Qualified leads a week: the measured leads a week times the share that qualify (the measured qualified rate).
    expect(model.leadsPerWeek).toBeCloseTo(arrivals.proposed! * 0.5, 6);
    // One enquiry every 3.5 days: 2 qualified a week, so 4 leads a week at the 50% that qualify.
    expect(arrivals.proposed).toBe(4);
    expect(model.leadsPerWeek).toBeCloseTo(2, 6);

    // The market's Stable level is 100% of today: a run with Stable in every month is the run on the measured numbers.
    const stable = { ...model, horizonWeeks: 8, market: { months: Array.from({ length: 24 }, () => ({ ...STABLE_MARKET })) } };
    const plain = { ...model, horizonWeeks: 8 };
    expect(simulate(stable, 3, 7).won).toEqual(simulate(plain, 3, 7).won);

    // The robustness check perturbs estimates only: the measured values drop out.
    const paths = estimatedParameters(model, {
      provenance: provenanceFromRows({ steps: live.steps, services: live.services, workspace: live.workspace.provenance, leadSources: live.leadSources ?? [] }),
    }).map((p) => p.path);
    expect(paths).not.toContain(`steps.${ids.qualify}.work_hours`);
    expect(paths).not.toContain(`steps.${ids.decide}.wait_hours`);
    expect(paths).not.toContain("demand.leads_per_week");
    // Qualify's redo rate was measured as 0 and so not proposed as a change: still an estimate, but at 0 nothing is perturbed.
    expect(paths.every((p) => !p.startsWith(`steps.${ids.qualify}.`))).toBe(true);
  });
});
