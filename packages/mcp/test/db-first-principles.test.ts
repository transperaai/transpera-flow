import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateApiToken, type McpHandlerOptions } from "../src";
import { call, connect, startTestDb, type McpTestDb } from "./helpers";

// End to end for the first-principles tools (issue #119, A54), as in production: MCP client → handleMcpRequest →
// token lookup in app code → Kysely under the token owner's claims → Postgres with every migration and RLS. Runs on a
// throwaway database (test/helpers.ts), in a workspace of its own.


let env: McpTestDb;
let admin: pg.Client;
let options: McpHandlerOptions;
let workspaceId: string;
let editorId: string;
let editorToken: string;
let viewerToken: string;
let strangerToken: string;
let sarahId: string;


async function createUser(email: string) {
  const id = randomUUID();
  await admin.query("insert into auth.users (id, email) values ($1, $2)", [id, email]);
  return id;
}

async function issueToken(userId: string) {
  const { token, hash } = generateApiToken();
  await admin.query("insert into api_tokens (user_id, token_hash, label) values ($1, $2, 'e2e')", [userId, hash]);
  return token;
}

interface FpData {
  changed: string[];
  warnings: string[];
  draft: { revision_id: string; number: number };
  first_principles: {
    job: { who: string };
    requirements: { text: string; owner_person_id: string | null; owner_text: string; step_id: string | null; verdict: string }[];
    deletes: { step_id: string }[];
    measures: { id: string; kpi: string | null; target: number | null }[];
    why: { root: string };
  };
  steps_filled: number;
  flag_count: number;
  flags: Record<string, { code: string; text: string }[]>;
}

describe("MCP first-principles tools (drafts only, as the user)", () => {
  beforeAll(async () => {
    env = await startTestDb();
    admin = env.t.client;

    workspaceId = (await admin.query("insert into workspaces (name, slug) values ('First Principles Co', 'fp-co') returning id")).rows[0].id;
    sarahId = (await admin.query("insert into people (workspace_id, name, fte) values ($1, 'Sarah Lee', 1) returning id", [workspaceId])).rows[0].id;
    editorId = await createUser("fp-editor@example.com");
    const viewerId = await createUser("fp-viewer@example.com");
    const strangerId = await createUser("fp-stranger@example.com");
    await admin.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, 'owner'), ($1, $3, 'viewer')", [workspaceId, editorId, viewerId]);
    const otherId = (await admin.query("insert into workspaces (name, slug) values ('Elsewhere FP', 'elsewhere-fp') returning id")).rows[0].id;
    await admin.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, 'owner')", [otherId, strangerId]);
    editorToken = await issueToken(editorId);
    viewerToken = await issueToken(viewerId);
    strangerToken = await issueToken(strangerId);

    options = env.options;

  });

  afterAll(async () => {
    await env?.close();
  });

  const processRow = async () =>
    (await admin.query("select id, live_revision_id, draft_revision_id from processes where workspace_id = $1 and name = 'FP pipeline'", [workspaceId])).rows[0] as {
      id: string;
      live_revision_id: string | null;
      draft_revision_id: string | null;
    };

  it("writes first principles into the draft only, resolves names, and flags what the rules flag", async () => {
    const editor = await connect(editorToken, options);
    expect(await call(editor, "create_process", { name: "FP pipeline" })).toMatchObject({ ok: true });
    expect(await call(editor, "add_step", { process: "FP pipeline", name: "Qualify lead", work_hours: 1, after: "Start", before: "Won" })).toMatchObject({ ok: true });
    expect(await call(editor, "add_step", { process: "FP pipeline", name: "Audit review", work_hours: 2, after: "Qualify lead", before: "Won" })).toMatchObject({ ok: true });
    expect(await call(editor, "publish_process", { process: "FP pipeline", accept_estimates: true })).toMatchObject({ ok: true });
    const live = (await processRow()).live_revision_id!;
    expect(live).toBeTruthy();

    // Nothing yet.
    const empty = await call<{ started: boolean; steps_filled: number }>(editor, "get_first_principles", { process: "FP pipeline" });
    expect(empty).toMatchObject({ ok: true, data: { started: false, steps_filled: 0 } });
    expect(empty.assumptions).toContain("revision defaulted to live.");

    const r = await call<FpData>(editor, "update_first_principles", {
      process: "FP pipeline",
      job: { who: "Founders", progress: "More enquiries they can trust" },
      requirements: [
        { text: "Finance checks credit", owner: "Finance", why: "We've always done it", step: "Qualify lead" },
        { text: "Sarah reviews every audit", owner: "Sarah Lee", why: "A pricing error in 2024", verdict: "keep", step: "Audit review" },
      ],
      deletes: [{ step: "Qualify lead", agreed_by: "Sarah" }, { step: "Contract signing" }],
      improvements: [{ stage: "automate", text: "Auto-qualify leads", step: "Qualify lead" }],
      why: { problem: "Audits are late", root: "Sarah is slow" },
      measures: [{ text: "Win rate over 30%", kpi: "winRate", target: 30 }, { text: "Clients feel looked after" }],
    });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(r.assumptions).toContain("mode defaulted to merge: new items are added and matching ones updated; nothing is removed.");
    expect(r.data.changed).toEqual(["job", "reqs", "del", "saa", "why", "measures"]);
    // A step that isn't in the process comes back as a warning, not an error.
    expect(r.data.warnings).toEqual(["Delete candidate: no single step matches 'Contract signing'."]);
    expect(r.data.first_principles.requirements[0]).toMatchObject({ owner_person_id: null, owner_text: "Finance" });
    expect(r.data.first_principles.requirements[1]).toMatchObject({ owner_person_id: sarahId });
    expect(r.data.first_principles.measures[0]).toMatchObject({ kpi: "winRate" });
    expect(r.data.first_principles.measures[0]!.target).toBeCloseTo(0.3);
    expect(r.data.flags.reqs!.map((f) => f.code)).toContain("owner_team");
    expect(r.data.flags.saa!.map((f) => f.code)).toEqual(["order"]);
    expect(r.data.flags.why!.map((f) => f.code)).toEqual(["root_person"]);
    expect(r.data.flags.measures!.map((f) => f.code)).toEqual(["measure_unmapped"]);

    // It went into the draft the tool opened: live has no row, and the audit log says who.
    const proc = await processRow();
    expect(proc.draft_revision_id).toBe(r.data.draft.revision_id);
    expect((await admin.query("select 1 from first_principles where revision_id = $1", [live])).rowCount).toBe(0);
    const row = (await admin.query("select job_who, root_cause, jsonb_array_length(requirements) as reqs from first_principles where revision_id = $1", [proc.draft_revision_id])).rows;
    expect(row).toEqual([{ job_who: "Founders", root_cause: "Sarah is slow", reqs: 2 }]);
    const audit = await admin.query("select actor_id, actor_kind, action from audit_log where target_table = 'first_principles' and workspace_id = $1", [workspaceId]);
    expect(audit.rows).toEqual([{ actor_id: editorId, actor_kind: "mcp", action: "insert" }]);

    // get_first_principles reads the draft by default, and live on request (still empty).
    const got = await call<{ revision: { which: string }; started: boolean; steps_filled: number }>(editor, "get_first_principles", { process: "FP pipeline" });
    expect(got).toMatchObject({ ok: true, data: { revision: { which: "draft" }, started: true } });
    expect(got.data.steps_filled).toBe(r.data.steps_filled);
    expect(await call(editor, "get_first_principles", { process: "FP pipeline", revision: "live" })).toMatchObject({ ok: true, data: { started: false } });
    await editor.close();
  });

  it("merges a second call into the draft's answers and changes only what it names", async () => {
    const editor = await connect(editorToken, options);
    const r = await call<FpData>(editor, "update_first_principles", {
      process: "FP pipeline",
      requirements: [{ text: "finance checks credit", owner: "Sarah Lee" }],
      measures: [{ text: "Win rate over 30%", horizon: "6 months" }],
    });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(r.data.changed).toEqual(["reqs", "measures"]);
    expect(r.data.first_principles.requirements).toHaveLength(2);
    expect(r.data.first_principles.requirements[0]).toMatchObject({ owner_person_id: sarahId, owner_text: "", step_id: expect.any(String) });
    expect(r.data.first_principles.job.who).toBe("Founders");
    // The owner is a person now: the team flag is gone.
    expect((r.data.flags.reqs ?? []).map((f) => f.code)).not.toContain("owner_team");
    const audit = await admin.query("select action from audit_log where target_table = 'first_principles' and workspace_id = $1 order by created_at", [workspaceId]);
    expect(audit.rows.map((x) => x.action)).toEqual(["insert", "update"]);

    // Nothing to change: no write, no audit entry.
    const same = await call<FpData>(editor, "update_first_principles", { process: "FP pipeline", job: { who: "Founders" } });
    expect(same.data.changed).toEqual([]);
    expect((await admin.query("select 1 from audit_log where target_table = 'first_principles' and workspace_id = $1", [workspaceId])).rowCount).toBe(2);

    // Replace swaps the list and keeps the id of the measure whose text matches.
    const replaced = await call<FpData>(editor, "update_first_principles", {
      process: "FP pipeline",
      mode: "replace",
      measures: [{ text: "Win rate over 30%", kpi: "winRate", target: 35 }],
    });
    expect(replaced.data.first_principles.measures).toHaveLength(1);
    expect(replaced.data.first_principles.measures[0]).toMatchObject({ id: "m1", kpi: "winRate" });
    expect(replaced.data.first_principles.requirements).toHaveLength(2);
    await editor.close();
  });

  it("refuses an empty call, a viewer's write and a stranger's, and lets a viewer read", async () => {
    const editor = await connect(editorToken, options);
    expect(await call(editor, "update_first_principles", { process: "FP pipeline" })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    await editor.close();

    const viewer = await connect(viewerToken, options);
    expect(await call(viewer, "update_first_principles", { process: "FP pipeline", job: { who: "Vandals" } })).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(await call(viewer, "get_first_principles", { process: "FP pipeline", revision: "live" })).toMatchObject({ ok: true });
    await viewer.close();

    const stranger = await connect(strangerToken, options);
    expect(await call(stranger, "update_first_principles", { workspace: "fp-co", process: "FP pipeline", job: { who: "Vandals" } })).toMatchObject({ ok: false });
    await stranger.close();
    const proc = await processRow();
    expect((await admin.query("select job_who from first_principles where revision_id = $1", [proc.draft_revision_id])).rows).toEqual([{ job_who: "Founders" }]);
  });

  it("starts a new draft from the answers before it once the first one is published", async () => {
    const editor = await connect(editorToken, options);
    expect(await call(editor, "publish_process", { process: "FP pipeline", accept_estimates: true })).toMatchObject({ ok: true });
    const published = await processRow();
    expect(published.draft_revision_id).toBeNull();
    // Live now has the answers of the draft that was published, and a new draft inherits them.
    expect(await call(editor, "get_first_principles", { process: "FP pipeline" })).toMatchObject({ ok: true, data: { revision: { which: "live" }, started: true } });
    const r = await call<FpData>(editor, "update_first_principles", { process: "FP pipeline", job: { situation: "After a referral" } });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(r.data.first_principles.job.who).toBe("Founders");
    expect(r.data.first_principles.requirements).toHaveLength(2);
    const rows = await admin.query("select revision_id, job_situation from first_principles where process_id = $1 order by created_at", [published.id]);
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows[0]!.revision_id).toBe(published.live_revision_id);
    expect(rows.rows[0]!.job_situation).toBe("");
    expect(rows.rows[1]!.job_situation).toBe("After a referral");
    await editor.close();
  });
});
