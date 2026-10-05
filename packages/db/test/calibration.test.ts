import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { calibrate, type CalibrationResult } from "@transpera-flow/engine";
import {
  calibrationInput,
  NORTHBEAM_PROCESS_ID,
  NORTHBEAM_REVISION_ID,
  NORTHBEAM_WORKSPACE_ID,
  northbeamLeadSourceIds,
  northbeamStepIds,
  parseStepLog,
  type EdgeRow,
  type LeadSourceRow,
  type StepRow,
} from "../src";
import { createTestDb, createUser, type TestDb } from "./harness";

// Calibration from historical data (issue #41, migration 20261202000000): an editor stores a dataset record and a
// calibration, then applies the proposals they pick with `apply_calibration`. Step values and branch odds go into the
// process's draft, never live; lead volumes change live; every value written is `measured`, citing the dataset and the
// calibration, and keeps the evidence it had. A value changed since the calibration is skipped, not overwritten. Viewers,
// strangers and API tokens apply nothing; what was proposed never changes. Made with Supabase's default privileges.

let db: TestDb;
let editor: { id: string; claims: Record<string, unknown> };
let viewer: { id: string; claims: Record<string, unknown> };
let stranger: { id: string; claims: Record<string, unknown> };

const ws = NORTHBEAM_WORKSPACE_ID;
const proc = NORTHBEAM_PROCESS_ID;
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

type Applied = { status: string; draft: { revision_id: string; number: number; created: boolean } | null; results: { key: string; status: string }[] };
const apply = (c: pg.Client, calibration: string, keys: string[]) =>
  c.query("select public.apply_calibration($1, $2) as r", [calibration, keys]).then((r) => r.rows[0].r as Applied);

const D = (day: number, hour = 9) => {
  const t = new Date(Date.UTC(2026, 2, 2 + day, hour));
  return t.toISOString().slice(0, 16).replace("T", " ");
};

/**
 * Thirty leads over twelve weeks through Northbeam's pipeline. 20 qualify (10 lost), 14 of those get an audit (6 lost),
 * 2 audits are redone straight away, clients take 3 calendar days to decide, and 5 of 14 sign. Website and referrals.
 */
function northbeamLog(): string {
  const lines = ["item,step,started,finished,hours,source"];
  for (let i = 0; i < 30; i++) {
    const day = Math.floor(i * 2.8);
    const item = `L${i}`;
    lines.push(`${item},Qualify lead,${D(day)},${D(day, 10)},${0.5 + (i % 3) * 0.25},${i % 2 ? "Client referrals" : "Website enquiries"}`);
    if (i >= 20) {
      lines.push(`${item},Lost,${D(day + 1)},${D(day + 1)},,`);
      continue;
    }
    lines.push(`${item},Discovery call,${D(day + 1)},${D(day + 1, 11)},${1 + (i % 2)},`);
    if (i >= 14) {
      lines.push(`${item},Lost,${D(day + 2)},,,`);
      continue;
    }
    lines.push(`${item},Audit & proposal,${D(day + 2)},${D(day + 2, 15)},6,`);
    if (i < 2) lines.push(`${item},Audit & proposal,${D(day + 3)},${D(day + 3, 12)},3,`);
    lines.push(`${item},Client decision,${D(day + 4)},${D(day + 7)},,`);
    lines.push(`${item},${i < 5 ? "Contract & onboarding" : "Lost"},${D(day + 8)},,,`);
  }
  return lines.join("\n");
}

async function computeCalibration(): Promise<CalibrationResult> {
  const steps = (await q("select * from steps where revision_id = $1", [NORTHBEAM_REVISION_ID])) as StepRow[];
  const edges = (await q("select * from edges where revision_id = $1", [NORTHBEAM_REVISION_ID])) as EdgeRow[];
  const leadSources = (await q("select * from lead_sources where workspace_id = $1", [ws])) as LeadSourceRow[];
  const services = await q("select active, entry_process_id from services where workspace_id = $1", [ws]);
  const [process] = await q("select id, kind, parent_process_id, is_company from processes where id = $1", [proc]);
  const log = parseStepLog(northbeamLog());
  expect(log.errors).toEqual([]);
  return calibrate(
    calibrationInput({ process, steps, edges, services: services as never, leadSources, seasonality: [], hoursPerWeek: 40 }, log.rows),
  );
}

/** As the page does: the dataset record, then the calibration. Returns the calibration's id. */
async function store(results: CalibrationResult): Promise<{ dataset: string; calibration: string }> {
  return commitAs(editor.claims, async (c) => {
    const [d] = (
      await c.query(
        "insert into datasets (workspace_id, kind, process_id, file_name, column_map, row_count) values ($1, 'step_log', $2, 'pipeline-2026.csv', $3, $4) returning id",
        [ws, proc, { item: "item", step: "step", started: "started" }, results.rows],
      )
    ).rows;
    const [cal] = (
      await c.query("insert into calibrations (workspace_id, dataset_id, process_id, results) values ($1, $2, $3, $4) returning id", [ws, d.id, proc, results])
    ).rows;
    return { dataset: d.id as string, calibration: cal.id as string };
  });
}

const liveSnapshot = async () => ({
  steps: await q("select * from steps where revision_id = $1 order by id", [NORTHBEAM_REVISION_ID]),
  edges: await q("select * from edges where revision_id = $1 order by id", [NORTHBEAM_REVISION_ID]),
});

const proposal = (r: CalibrationResult, key: string) => r.proposals.find((p) => p.key === key)!;

beforeAll(async () => {
  db = await createTestDb({ supabaseDefaultPrivileges: true });
  editor = await createUser(db, "cal-editor@example.com");
  viewer = await createUser(db, "cal-viewer@example.com");
  stranger = await createUser(db, "cal-stranger@example.com");
  await q("insert into memberships (workspace_id, user_id, role) values ($1, $2, 'editor'), ($1, $3, 'viewer')", [ws, editor.id, viewer.id]);
});

afterAll(async () => {
  await db?.close();
});

describe("apply_calibration", () => {
  let result: CalibrationResult;
  let ids: { dataset: string; calibration: string };
  const audit = northbeamStepIds.audit;

  it("computes proposals from the log against the stored model", async () => {
    result = await computeCalibration();
    expect(proposal(result, `work:${audit}`)).toMatchObject({ n: 16, enough: true, current: 6 });
    expect(proposal(result, `rework:${audit}`)).toMatchObject({ n: 16, proposed: 0.125 });
    expect(proposal(result, `wait:${northbeamStepIds.decision}`)).toMatchObject({ n: 14, proposed: Math.round((3 / 7) * 40 * 100) / 100 });
    expect(proposal(result, `routing:${northbeamStepIds.qualify}`).branches!.map((b) => b.proposed).sort()).toEqual([0.333, 0.667]);
    expect(proposal(result, `arrivals:${northbeamLeadSourceIds.website}`)).toMatchObject({ n: 15, enough: true });
    // Kickoff never appears: nothing to propose. Onboarding has 5 visits and no hours: too few for a redo rate.
    expect(proposal(result, `rework:${northbeamStepIds.onboard}`)).toMatchObject({ n: 5, enough: false, set: null });
  });

  it("stores the dataset and the calibration for an editor; a viewer reads them and can't add one", async () => {
    ids = await store(result);
    const seen = await db.as(viewer.claims, async (c) => (await c.query("select id, applied from calibrations")).rows);
    expect(seen).toEqual([{ id: ids.calibration, applied: false }]);
    await expect(
      db.as(viewer.claims, (c) => c.query("insert into datasets (workspace_id, kind, file_name, row_count) values ($1, 'step_log', 'x.csv', 1)", [ws])),
    ).rejects.toThrow(/row-level security/);
    expect(await db.as(stranger.claims, async (c) => (await c.query("select id from calibrations")).rows)).toEqual([]);
  });

  it("applies the chosen proposals: steps into a draft (live untouched), lead volumes live, all measured", async () => {
    const before = await liveSnapshot();
    const keys = [`work:${audit}`, `rework:${audit}`, `wait:${northbeamStepIds.decision}`, `routing:${northbeamStepIds.qualify}`, `arrivals:${northbeamLeadSourceIds.website}`];
    const out = await commitAs(editor.claims, (c) => apply(c, ids.calibration, [...keys, `rework:${northbeamStepIds.onboard}`, "work:nonsense"]));
    expect(out.status).toBe("ok");
    expect(out.draft?.created).toBe(true);
    expect(Object.fromEntries(out.results.map((r) => [r.key, r.status]))).toEqual({
      ...Object.fromEntries(keys.map((k) => [k, "applied"])),
      [`rework:${northbeamStepIds.onboard}`]: "not_proposed",
      "work:nonsense": "not_proposed",
    });
    expect(await liveSnapshot()).toEqual(before);

    const draft = out.draft!.revision_id;
    const [a] = await q("select work_hours::float8 w, work_dist, work_params, rework_rate::float8 r, provenance from steps where revision_id = $1 and id = $2", [draft, audit]);
    const work = proposal(result, `work:${audit}`);
    expect(a.w).toBe(work.proposed);
    expect(a.work_dist).toBe("lognormal");
    expect(a.work_params.cv).toBe(work.proposedCv);
    expect(a.r).toBe(0.125);
    expect(a.provenance.work_hours).toMatchObject({ source: "measured", dataset_id: ids.dataset, calibration_id: ids.calibration, by: editor.id, n: 16 });
    // The interview quote it cited is kept.
    expect(a.provenance.work_hours.evidence[0].speaker).toBe("Maya Collins");
    expect(a.provenance.rework_rate).toMatchObject({ source: "measured", n: 16 });

    const [dec] = await q("select wait_hours::float8 w, provenance from steps where revision_id = $1 and id = $2", [draft, northbeamStepIds.decision]);
    expect(dec.w).toBe(17.14);
    expect(dec.provenance.wait_hours.source).toBe("measured");

    const odds = await q("select to_step_id, probability::float8 p from edges where revision_id = $1 and from_step_id = $2 order by p", [draft, northbeamStepIds.qualify]);
    expect(odds.map((o) => o.p)).toEqual([0.333, 0.667]);
    const [qual] = await q("select provenance from steps where revision_id = $1 and id = $2", [draft, northbeamStepIds.qualify]);
    expect(qual.provenance.routing).toMatchObject({ source: "measured", calibration_id: ids.calibration });

    const [web] = await q("select volume_week::float8 v, provenance from lead_sources where id = $1", [northbeamLeadSourceIds.website]);
    expect(web.v).toBe(proposal(result, `arrivals:${northbeamLeadSourceIds.website}`).proposed);
    expect(web.provenance.volume_week).toMatchObject({ source: "measured", dataset_id: ids.dataset, n: 15 });

    const [cal] = await q("select applied, applied_keys, applied_by from calibrations where id = $1", [ids.calibration]);
    expect(cal.applied).toBe(true);
    expect([...cal.applied_keys].sort()).toEqual([...keys].sort());
    expect(cal.applied_by).toBe(editor.id);
  });

  it("applies a key once, and skips a value changed since the calibration instead of overwriting it", async () => {
    const again = await commitAs(editor.claims, (c) => apply(c, ids.calibration, [`work:${audit}`]));
    expect(again.results).toEqual([{ key: `work:${audit}`, status: "already_applied" }]);

    // Someone edits the discovery call's hands-on time in the draft after the calibration was computed.
    const [{ draft_revision_id: draft }] = await q("select draft_revision_id from processes where id = $1", [proc]);
    await q("update steps set work_hours = 2.5 where revision_id = $1 and id = $2", [draft, northbeamStepIds.discovery]);
    const out = await commitAs(editor.claims, (c) => apply(c, ids.calibration, [`work:${northbeamStepIds.discovery}`]));
    expect(out.results).toEqual([{ key: `work:${northbeamStepIds.discovery}`, status: "changed" }]);
    expect(out.draft?.created).toBe(false);
    const [d] = await q("select work_hours::float8 w from steps where revision_id = $1 and id = $2", [draft, northbeamStepIds.discovery]);
    expect(d.w).toBe(2.5);
  });

  it("settles an assumption and a conflict it measures, as typing the value does", async () => {
    const fresh = await computeCalibration();
    const [{ draft_revision_id: draft }] = await q("select draft_revision_id from processes where id = $1", [proc]);
    // Kickoff isn't in the log; use the discovery call: put it back, and give it an open conflict and an assumption.
    await q(
      `update steps set work_hours = 1.5, assumption = true, conflict = true,
         provenance = provenance || jsonb_build_object('work_hours', jsonb_build_object('source', 'estimated', 'assumption', true,
           'conflict', jsonb_build_object('values', jsonb_build_array(jsonb_build_object('value', 1), jsonb_build_object('value', 3)))))
       where revision_id = $1 and id = $2`,
      [draft, northbeamStepIds.discovery],
    );
    const ids2 = await store(fresh);
    const out = await commitAs(editor.claims, (c) => apply(c, ids2.calibration, [`work:${northbeamStepIds.discovery}`]));
    expect(out.results[0]!.status).toBe("applied");
    const [d] = await q("select assumption, conflict, provenance from steps where revision_id = $1 and id = $2", [draft, northbeamStepIds.discovery]);
    expect(d.assumption).toBe(false);
    expect(d.conflict).toBe(false);
    expect(d.provenance.work_hours.source).toBe("measured");
    expect(d.provenance.work_hours.conflict.resolved.choice).toBe("measured");
  });

  it("applies nothing for a viewer, a stranger or an API token", async () => {
    const fresh = await store(await computeCalibration());
    const key = [`rework:${northbeamStepIds.qualify}`];
    expect((await commitAs(viewer.claims, (c) => apply(c, fresh.calibration, key))).status).toBe("not_found");
    expect((await commitAs(stranger.claims, (c) => apply(c, fresh.calibration, key))).status).toBe("not_found");
    await expect(commitAs({ ...editor.claims, api_token_id: "t1" }, (c) => apply(c, fresh.calibration, key))).rejects.toThrow(/by a person in the app/);
    const [cal] = await q("select applied from calibrations where id = $1", [fresh.calibration]);
    expect(cal.applied).toBe(false);
  });

  it("never changes what was proposed, and nobody deletes a dataset or a calibration", async () => {
    await expect(
      db.as(editor.claims, (c) => c.query("update calibrations set results = '{\"proposals\": []}' where id = $1", [ids.calibration])),
    ).rejects.toThrow(/permission denied/);
    await expect(db.as(editor.claims, (c) => c.query("update datasets set row_count = 1 where id = $1", [ids.dataset]))).rejects.toThrow(/permission denied/);
    await expect(db.as(editor.claims, (c) => c.query("delete from calibrations where id = $1", [ids.calibration]))).rejects.toThrow(/permission denied/);
    await expect(db.as(editor.claims, (c) => c.query("delete from datasets where id = $1", [ids.dataset]))).rejects.toThrow(/permission denied/);
    // Even the table owner's direct update of the proposals is refused by the trigger.
    await expect(q("update calibrations set results = '{\"proposals\": []}' where id = $1", [ids.calibration])).rejects.toThrow(/never change/);
    // A new calibration starts unapplied whatever the insert says.
    const [d] = await q("select id from datasets where id = $1", [ids.dataset]);
    const made = await commitAs(editor.claims, async (c) =>
      (await c.query("insert into calibrations (workspace_id, dataset_id, process_id, results, applied, applied_at, applied_keys) values ($1, $2, $3, $4, true, now(), '{x}') returning applied, applied_keys", [ws, d.id, proc, { proposals: [] }])).rows[0],
    );
    expect(made).toEqual({ applied: false, applied_keys: [] });
  });

  it("publishes as any draft does: the measured values go live", async () => {
    const res = await commitAs(editor.claims, async (c) => (await c.query("select public.publish_process($1, true) as r", [proc])).rows[0].r);
    expect(res.status).toBe("published");
    const [{ live_revision_id: live }] = await q("select live_revision_id from processes where id = $1", [proc]);
    const [a] = await q("select provenance from steps where revision_id = $1 and id = $2", [live, audit]);
    expect(a.provenance.work_hours.source).toBe("measured");
  });
});
