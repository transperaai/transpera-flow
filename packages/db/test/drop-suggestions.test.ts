import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations } from "../src/migrations";
import { NORTHBEAM_WORKSPACE_ID, northbeamLeadSourceIds } from "../src";
import { createTestDb, createUser, type TestDb } from "./harness";

// Suggestions were removed (docs/plans/cut-list.md item 2, migration 20270102000000_drop_suggestions.sql): MCP is read-only, a
// share-link visitor can no longer send an idea, and the two tables that held the review queue are gone. The migration runs on a
// database full of real rows: it is built as production had it (every migration up to 20261231000000, the row the cutover imports
// at), given suggestions, visitor ideas and their audit entries, and then migrated.

const BASE = "20261231000000";
const ws = NORTHBEAM_WORKSPACE_ID;
let db: TestDb;
let editor: { id: string; claims: Record<string, unknown> };
let auditBefore = 0;
const REWRITTEN = `(p.pronamespace::regnamespace::text, p.proname) in (('public', 'import_process_bundle'), ('public', 'import_workspace_bundle'), ('private', 'audit_company_write'), ('private', 'company_needs_review'))`;
const settingsOf = async () =>
  (
    await db.client.query(
      `select p.proname, p.prosecdef, p.proconfig, has_function_privilege('anon', p.oid, 'execute') as anon, has_function_privilege('authenticated', p.oid, 'execute') as auth
         from pg_proc p where ${REWRITTEN} order by 1`,
    )
  ).rows;
let settingsBefore: Awaited<ReturnType<typeof settingsOf>> = [];

beforeAll(async () => {
  db = await createTestDb({ upTo: BASE });
  editor = await createUser(db, "drop-suggestions-editor@example.com");
  await db.client.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, 'editor')", [ws, editor.id]);
  // Real rows in both tables, made the ways they were made: a suggestion by an editor's API token (which the audit log records),
  // another by hand, a proposal, and a visitor's idea from a play link (with the visitor's email and held text).
  await db.client.query("select set_config('request.jwt.claims', $1, false)", [JSON.stringify({ ...editor.claims, api_token_id: "00000000-0000-4000-8000-0000000000aa" })]);
  await db.client.query("insert into suggestions (workspace_id, target_table, target_id, patch, evidence, note) values ($1, 'lead_sources', $2, $3, '[]', 'x')", [
    ws,
    northbeamLeadSourceIds.ads,
    JSON.stringify({ set: { volume_week: 15 } }),
  ]);
  await db.client.query("select set_config('request.jwt.claims', '', false)");
  await db.client.query("insert into suggestions (workspace_id, target_table, target_id, patch) values ($1, 'workspaces', $1, '{\"set\": {\"hours_per_week\": 35}}')", [ws]);
  await db.client.query("insert into suggestion_proposals (workspace_id, kind, title, detail) values ($1, 'issue', 'Proposed issue', 'Looks slow')", [ws]);
  await db.client.query(
    "insert into suggestion_proposals (workspace_id, kind, title, payload, issue_id, proposer_email, visitor_text) select $1, 'solution_idea', 'A visitor''s idea', '{\"steps\": []}', i.id, 'v@example.com', '{\"note\": \"held\"}' from issues i where i.workspace_id = $1 limit 1",
    [ws],
  ).catch(() => undefined);
  expect(Number((await db.client.query("select count(*) n from suggestions")).rows[0].n)).toBe(2);
  expect(Number((await db.client.query("select count(*) n from suggestion_proposals")).rows[0].n)).toBeGreaterThanOrEqual(1);
  auditBefore = Number((await db.client.query("select count(*) n from audit_log where target_table = 'suggestions'")).rows[0].n);
  settingsBefore = await settingsOf();
  const applied = await applyMigrations(db.client, {});
  expect(applied.files).toContain("20270102000000_drop_suggestions.sql");
}, 120_000);

afterAll(async () => {
  await db?.close();
});

const names = async (sql: string) => (await db.client.query(sql)).rows.map((r) => r.n as string);

describe("what the migration drops", () => {
  it("the two tables, with their rows, triggers and policies", async () => {
    expect(await names("select tablename n from pg_tables where schemaname = 'public' and tablename in ('suggestions', 'suggestion_proposals')")).toEqual([]);
    expect(await names("select policyname n from pg_policies where tablename in ('suggestions', 'suggestion_proposals')")).toEqual([]);
    expect(await names("select tgname n from pg_trigger where not tgisinternal and tgrelid::regclass::text in ('suggestions', 'suggestion_proposals')")).toEqual([]);
    expect(await names("select typname n from pg_type where typname in ('suggestions', 'suggestion_proposals')")).toEqual([]);
  });

  it("every function that took, made or reviewed a suggestion, a proposal or a visitor's idea", async () => {
    const gone = [
      "public.review_suggestions", "private.apply_suggestion", "public.review_proposals", "public.build_proposal", "public.submit_play_proposal",
      "public.play_proposal_contacts", "private.play_patch_problem", "private.suggestions_before_write", "private.suggestion_proposals_before_write",
    ];
    for (const f of gone) {
      const [schema, name] = f.split(".");
      expect(await names(`select p.oid::regprocedure::text n from pg_proc p where p.pronamespace = '${schema}'::regnamespace and p.proname = '${name}'`), f).toEqual([]);
    }
  });

  it("nothing left refers to either table, and no function reads the settings that carried a suggestion", async () => {
    expect(
      await names(
        `select p.oid::regprocedure::text n from pg_proc p join pg_namespace s on s.oid = p.pronamespace
          where s.nspname in ('public', 'private') and (p.prosrc ~ 'public\\.suggestions|public\\.suggestion_proposals' or p.prosrc ~ 'transpera\\.(suggestion_id|reviewing|reviewing_proposals|play_submitting)')`,
      ),
    ).toEqual([]);
  });

  it("the audit entries about suggestions stay as history", async () => {
    const after = Number((await db.client.query("select count(*) n from audit_log where target_table = 'suggestions'")).rows[0].n);
    expect(after).toBe(auditBefore);
    expect(auditBefore).toBeGreaterThan(0);
  });
});

describe("what it keeps and rewrites", () => {
  it("keeps capacity_factor_proposals: in-app calibration writes it, and it still refuses an API token", async () => {
    expect(await names("select tablename n from pg_tables where schemaname = 'public' and tablename = 'capacity_factor_proposals'")).toEqual(["capacity_factor_proposals"]);
    expect(await names("select tgname n from pg_trigger where not tgisinternal and tgrelid = 'public.capacity_factor_proposals'::regclass order by 1")).toContain("needs_review");
  });

  it("the audit log is written as before for the company model, and carries no suggestion_id even if the old setting is still around", async () => {
    await db.as(editor.claims, async (c) => {
      await c.query("select set_config('transpera.suggestion_id', '5a5a5a5a-5a5a-4a5a-8a5a-5a5a5a5a5a5a', true)");
      await c.query("update lead_sources set volume_week = 21 where id = $1", [northbeamLeadSourceIds.ads]);
      await c.query("reset role");
      const row = (await c.query("select diff, actor_kind from audit_log where target_table = 'lead_sources' and created_at = now()")).rows[0];
      expect(row.actor_kind).toBe("user");
      expect(row.diff).toMatchObject({ old: expect.any(Object), new: expect.objectContaining({ volume_week: 21 }) });
      expect(row.diff).not.toHaveProperty("suggestion_id");
    });
  });

  it("the function is called by 17 enabled triggers (18 before: the suggestions table's went with it)", async () => {
    const rows = (await db.client.query("select t.tgenabled::text as enabled from pg_trigger t where t.tgfoid = 'private.audit_company_write()'::regprocedure and not t.tgisinternal")).rows;
    expect(rows).toHaveLength(17);
    expect(new Set(rows.map((r) => r.enabled))).toEqual(new Set(["O"]));
  });

  it("an API token still can't write the company model, and says so without naming the suggestion tools", async () => {
    await expect(
      db.as({ ...editor.claims, api_token_id: "00000000-0000-4000-8000-0000000000bb" }, (c) => c.query("update lead_sources set volume_week = 22 where id = $1", [northbeamLeadSourceIds.ads])),
    ).rejects.toThrow(/can't be changed through an API token: make the change in the app/);
  });

  it("the rewritten functions keep their settings and who may call them (create or replace changes neither)", async () => {
    const after = await settingsOf();
    expect(after).toEqual(settingsBefore);
    expect(after.map((r) => [r.proname, r.prosecdef, r.proconfig])).toEqual([
      ["audit_company_write", true, ['search_path=""']],
      ["company_needs_review", false, ['search_path=""']],
      ["import_process_bundle", false, ['search_path=""']],
      ["import_workspace_bundle", false, ['search_path=""', "statement_timeout=40s"]],
    ]);
    // The two a signed-in user calls are callable by authenticated only; the audit function is the trigger's alone.
    expect(after.filter((r) => r.proname.endsWith("_bundle")).map((r) => [r.anon, r.auth])).toEqual([[false, true], [false, true]]);
    expect(after.find((r) => r.proname === "audit_company_write")).toMatchObject({ anon: false, auth: false });
  });

  it("play links stay: lever_kind_ids and open_share_link are still there, and the mode column still takes 'play'", async () => {
    expect(await names("select proname n from pg_proc where pronamespace = 'private'::regnamespace and proname = 'lever_kind_ids'")).toEqual(["lever_kind_ids"]);
    expect(await names("select proname n from pg_proc where pronamespace = 'public'::regnamespace and proname = 'open_share_link'")).toEqual(["open_share_link"]);
    expect(await names("select pg_get_constraintdef(oid) n from pg_constraint where conrelid = 'public.share_links'::regclass and pg_get_constraintdef(oid) ilike '%play%'")).not.toEqual([]);
  });

  it("applies again without effect", async () => {
    expect((await applyMigrations(db.client, {})).files).toEqual([]);
  });
});
