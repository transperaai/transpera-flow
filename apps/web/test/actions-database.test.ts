import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  NORTHBEAM_PROCESS_ID,
  NORTHBEAM_REVISION_ID,
  NORTHBEAM_WORKSPACE_ID,
  northbeamBundle,
  northbeamPersonIds,
  northbeamRoleIds,
  northbeamServiceIds,
  northbeamStepIds,
} from "@transpera-flow/db";
import { createTestDb, type TestDb } from "../../../packages/db/test/harness";
import { STEP_FIELDS } from "@/lib/editor/validate";
import { addMember, signInAs, type TestUser } from "./action-harness";

// Server Actions with no test of their own, run against a real database as an editor or an owner: what they write is read back
// from the tables. These guard the move off supabase-js: arrays and JSON in the right column types, the filters in the right
// places, the SQLSTATE checks still reached. Each action's messages are tested where it has a suite of its own.

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ refresh: vi.fn(), revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ origin: "https://flow.example" }), cookies: async () => ({ set: vi.fn() }) }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT ${url}`);
  },
}));
vi.mock("@/lib/auth/session", async () => (await import("./action-harness")).sessionMock);

const WS = NORTHBEAM_WORKSPACE_ID;
const SLUG = "northbeam";
const P = NORTHBEAM_PROCESS_ID;
const REV = NORTHBEAM_REVISION_ID;

let tdb: TestDb;
let owner: TestUser;
let editor: TestUser;
let admin: TestUser;
let viewer: TestUser;
const q = (sql: string, params: unknown[] = []) => tdb.client.query(sql, params);
const one = async (sql: string, params: unknown[] = []) => (await q(sql, params)).rows[0];
const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};
/** The URL a redirecting action sent the browser to. */
const redirected = async (run: () => Promise<unknown>) => {
  try {
    await run();
  } catch (e) {
    const m = /^NEXT_REDIRECT (.*)$/.exec((e as Error).message);
    if (m) return m[1]!;
    throw e;
  }
  throw new Error("expected a redirect");
};

beforeAll(async () => {
  tdb = await createTestDb();
  owner = await addMember(tdb, WS, "owner");
  editor = await addMember(tdb, WS, "editor");
  admin = await addMember(tdb, WS, "viewer", null, { agency_admin: true });
  viewer = await addMember(tdb, WS, "viewer");
}, 120_000);

afterAll(async () => {
  await tdb?.close();
});

beforeEach(() => signInAs({ tdb }, editor));

describe("headline numbers", () => {
  it("records them, leaves fresh identical ones alone, and writes changed ones at once", async () => {
    const { recordHeadline } = await import("@/app/w/[slug]/headline-actions");
    const numbers = { flow_efficiency: 0.4, processes_attention: 1, processes_total: 3, client_groups_at_risk: 0, client_groups_total: 2 };
    expect(await recordHeadline(WS, [REV], 26, numbers)).toEqual({ status: "recorded" });
    expect(await one("select revision_ids, horizon_weeks, numbers, computed_by from workspace_headlines where workspace_id = $1", [WS])).toMatchObject({
      revision_ids: [REV],
      horizon_weeks: 26,
      numbers: { flow_efficiency: 0.4, processes_total: 3 },
      computed_by: editor.id,
    });
    expect(await recordHeadline(WS, [REV], 26, numbers)).toEqual({ status: "fresh" });
    expect(await recordHeadline(WS, [REV], 26, { ...numbers, processes_attention: 2 })).toEqual({ status: "recorded" });
    expect((await one("select numbers from workspace_headlines where workspace_id = $1", [WS])).numbers.processes_attention).toBe(2);
    expect((await q("select 1 from workspace_headlines where workspace_id = $1", [WS])).rowCount).toBe(1);
  });
});

describe("sandbox scenarios", () => {
  const hire = { id: "11111111-1111-4111-8111-111111111111", lever: "D1", target: northbeamRoleIds.strat, op: "set", value: 1, from: "2027-02" };
  const lead = (n: number, from?: string) => ({ id: `22222222-2222-4222-8222-00000000000${n}`, lever: "A1", target: null, op: "multiply", value: 1.2, ...(from ? { from } : {}) });
  // Headcount by role (D5) is a capped lever: each month it starts from costs a run, so it is what the six-month limit counts.
  const cut = (n: number, from?: string) => ({ id: `22222222-2222-4222-8222-00000000000${n}`, lever: "D5", target: "role-1", op: "add", value: -1, ...(from ? { from } : {}) });
  const input = (name: string, changes: unknown[] = [hire], extra: Record<string, unknown> = {}) => ({ name, description: null, parent_id: null, changes, horizon_months: 12, ...extra });

  it("saves a scenario with its changes, changes it only if nobody else has, and deletes it", async () => {
    const { saveSandboxScenario, deleteSandboxScenario } = await import("@/app/w/[slug]/sandbox-actions");
    const made = await saveSandboxScenario(WS, null, input("Hire early", [hire], { horizon_months: 24 }), null);
    expect(made.status).toBe("ok");
    if (made.status !== "ok") return;
    expect(made.scenario).toMatchObject({ name: "Hire early", horizon_months: 24, parent_id: null });
    expect((await one("select changes, created_by from sandbox_scenarios where id = $1", [made.scenario.id]))).toMatchObject({ changes: [hire], created_by: editor.id });
    const renamed = await saveSandboxScenario(WS, made.scenario.id, input("Hire earlier"), made.scenario.updated_at);
    expect(renamed).toMatchObject({ status: "ok", scenario: { name: "Hire earlier" } });
    // The page still holds the first version: someone changed it since.
    expect(await saveSandboxScenario(WS, made.scenario.id, input("Stale"), made.scenario.updated_at)).toEqual({
      status: "error",
      message: "Someone else changed or deleted this scenario. Reload to see it.",
    });
    expect((await one("select name from sandbox_scenarios where id = $1", [made.scenario.id])).name).toBe("Hire earlier");
    expect(await saveSandboxScenario(WS, null, input("hire earlier", []), null)).toMatchObject({ status: "error", message: "A scenario with that name already exists." });
    expect(await deleteSandboxScenario(WS, made.scenario.id)).toEqual({ status: "ok" });
    expect(await deleteSandboxScenario(WS, made.scenario.id)).toMatchObject({ status: "error" });
  });

  it("refuses what is not valid before it reaches the database, with the reason", async () => {
    const { saveSandboxScenario } = await import("@/app/w/[slug]/sandbox-actions");
    expect(await saveSandboxScenario("nope", null, input("x"), null)).toEqual({ status: "error", message: "That scenario isn't valid." });
    expect(await saveSandboxScenario(WS, null, input("x", [{ ...hire, value: 3 }]), null)).toEqual({ status: "error", message: "A hire's FTE must be between 0.1 and 2." });
    expect(await saveSandboxScenario(WS, null, input("   "), null)).toEqual({ status: "error", message: "Give the scenario a name." });
    expect(await saveSandboxScenario(WS, null, input("x", [], { parent_id: "33333333-3333-4333-8333-333333333333" }), null)).toEqual({ status: "error", message: "The scenario this one builds on isn't there any more." });
    expect(await saveSandboxScenario(WS, "33333333-3333-4333-8333-333333333333", input("x"), null)).toEqual({ status: "error", message: "That scenario isn't valid." });
  });

  it("checks the limits on the effective changes (a scenario with its parents'), and on the scenarios that build on the one being saved", async () => {
    const { saveSandboxScenario } = await import("@/app/w/[slug]/sandbox-actions");
    const months = (...ms: string[]) => ms.map((m, i) => cut(i + 1, `2027-${m}`));
    const parent = await saveSandboxScenario(WS, null, input("Base", months("01", "02", "03", "04")), null);
    if (parent.status !== "ok") throw new Error(JSON.stringify(parent));
    const child = await saveSandboxScenario(WS, null, input("Base plus", [{ ...cut(5, "2027-05") }], { parent_id: parent.scenario.id }), null);
    expect(child.status).toBe("ok");
    const over = await saveSandboxScenario(WS, null, input("Base plus more", [cut(5, "2027-05"), cut(6, "2027-06"), { ...cut(7, "2027-07") }], { parent_id: parent.scenario.id }), null);
    expect(over).toMatchObject({ status: "error", message: expect.stringMatching(/more than 6 different months/) });
    const grow = await saveSandboxScenario(WS, parent.scenario.id, input("Base", months("01", "02", "03", "04", "06", "07")), parent.scenario.updated_at);
    expect(grow).toMatchObject({ status: "error", message: expect.stringMatching(/“Base plus” builds on this one/) });
    expect((await one("select jsonb_array_length(changes) as n from sandbox_scenarios where id = $1", [parent.scenario.id])).n).toBe(4);
  });

  it("refuses to delete a scenario others build on, naming them", async () => {
    const { saveSandboxScenario, deleteSandboxScenario } = await import("@/app/w/[slug]/sandbox-actions");
    const parent = await saveSandboxScenario(WS, null, input("Parent plan", []), null);
    if (parent.status !== "ok") throw new Error(JSON.stringify(parent));
    const a = await saveSandboxScenario(WS, null, input("Child B", [], { parent_id: parent.scenario.id }), null);
    const b = await saveSandboxScenario(WS, null, input("Child A", [], { parent_id: parent.scenario.id }), null);
    expect(a.status === "ok" && b.status === "ok").toBe(true);
    expect(await deleteSandboxScenario(WS, parent.scenario.id)).toEqual({ status: "error", message: "Other scenarios build on this one: “Child A”, “Child B”. Delete them or change what they build on first." });
    expect(Number((await one("select count(*) from sandbox_scenarios where id = $1", [parent.scenario.id])).count)).toBe(1);
    if (a.status === "ok" && b.status === "ok") {
      expect(await deleteSandboxScenario(WS, a.scenario.id)).toEqual({ status: "ok" });
      expect(await deleteSandboxScenario(WS, b.scenario.id)).toEqual({ status: "ok" });
    }
    expect(await deleteSandboxScenario(WS, parent.scenario.id)).toEqual({ status: "ok" });
  });

  it("refuses a Viewer, and a signed-out caller, writing nothing", async () => {
    const { saveSandboxScenario, deleteSandboxScenario } = await import("@/app/w/[slug]/sandbox-actions");
    const mine = await saveSandboxScenario(WS, null, input("Viewer test"), null);
    if (mine.status !== "ok") throw new Error(JSON.stringify(mine));
    await signInAs({ tdb }, viewer);
    expect(await saveSandboxScenario(WS, null, input("By a viewer"), null)).toEqual({ status: "error", message: "You don't have permission to change scenarios here." });
    expect(await saveSandboxScenario(WS, mine.scenario.id, input("Hijacked"), mine.scenario.updated_at)).toEqual({ status: "error", message: "Someone else changed or deleted this scenario. Reload to see it." });
    expect(await deleteSandboxScenario(WS, mine.scenario.id)).toMatchObject({ status: "error" });
    expect((await one("select name from sandbox_scenarios where id = $1", [mine.scenario.id])).name).toBe("Viewer test");
    // A Viewer reads it, though.
    expect((await tdb.dbAs({ sub: viewer.id, role: "authenticated", app_metadata: {} } as never).selectFrom("sandbox_scenarios").select("name").where("id", "=", mine.scenario.id).execute()).map((r) => r.name)).toEqual(["Viewer test"]);
    await signInAs({ tdb }, admin);
    expect(await deleteSandboxScenario(WS, mine.scenario.id)).toEqual({ status: "ok" });
  });

  it("the process page's createScenario writes a standalone whole-run sandbox row; updateScenarioPatch leaves the Sandbox's own alone", async () => {
    const { createScenario, deleteScenario, updateScenarioPatch } = await import("@/app/w/[slug]/scenario-actions");
    const { saveSandboxScenario } = await import("@/app/w/[slug]/sandbox-actions");
    const patch = [{ path: "demand.leads_per_week", op: "multiply", value: 1.3 }];
    const made = await createScenario(WS, { name: "More leads, process page", description: "d", patch, parent_scenario_id: "44444444-4444-4444-8444-444444444444" });
    if (made.status !== "ok") throw new Error(JSON.stringify(made));
    expect(made.scenario).toMatchObject({ name: "More leads, process page", patch, parent_scenario_id: null });
    const stored = await one("select changes, parent_id from sandbox_scenarios where id = $1", [made.scenario.id]);
    expect(stored.parent_id).toBeNull();
    expect(stored.changes).toEqual([{ id: expect.any(String), lever: "A1", target: null, op: "multiply", value: 1.3 }]);
    const repointed = await updateScenarioPatch(made.scenario.id, [{ path: "demand.leads_per_week", op: "multiply", value: 1.4 }]);
    expect(repointed).toMatchObject({ status: "ok", scenario: { patch: [{ path: "demand.leads_per_week", op: "multiply", value: 1.4 }] } });
    // A scenario with a hire from a month is the Sandbox's: the process page can't replace its changes with patches.
    const timed = await saveSandboxScenario(WS, null, input("With a hire"), null);
    if (timed.status !== "ok") throw new Error(JSON.stringify(timed));
    expect(await updateScenarioPatch(timed.scenario.id, patch)).toMatchObject({ status: "error" });
    expect((await one("select changes from sandbox_scenarios where id = $1", [timed.scenario.id])).changes).toEqual([hire]);
    // And it can't delete one that others build on.
    const child = await saveSandboxScenario(WS, null, input("Builds on it", [], { parent_id: made.scenario.id }), null);
    expect(await deleteScenario(made.scenario.id)).toEqual({ status: "error", message: "Other scenarios build on this one: “Builds on it”. Delete them or change what they build on first." });
    if (child.status === "ok") await tdb.client.query("delete from sandbox_scenarios where id = $1", [child.scenario.id]);
    expect(await deleteScenario(made.scenario.id)).toEqual({ status: "ok" });
    await tdb.client.query("delete from sandbox_scenarios where id = $1", [timed.scenario.id]);
  });
});

describe("blocks and runs", () => {
  it("saves a block with its steps as JSON", async () => {
    const { createBlock } = await import("@/app/w/[slug]/block-actions");
    const b = northbeamBundle();
    const steps = b.steps.slice(0, 2);
    const bundle = { steps, edges: [], entry_step_id: steps[0]!.id };
    const r = await createBlock(WS, { name: "Intake", description: "First two steps", bundle });
    if (r.status !== "ok") throw new Error(JSON.stringify(r));
    expect(r.block).toMatchObject({ name: "Intake", type: "manual", workspace_id: WS });
    expect((await one("select steps from blocks where id = $1", [r.block.id])).steps.steps).toHaveLength(2);
  });

  it("saves a run against the live revision, and refuses one against an older revision", async () => {
    const { saveRun } = await import("@/app/w/[slug]/run-actions");
    const stat = { mean: 1, p10: 0, p90: 2 };
    const input = {
      name: "Run 1",
      processId: P,
      revisionId: REV,
      results: { won: stat, lost: stat, mrr_added: stat, billed: stat, overtime_hours: stat, horizon_weeks: 26, reps: 30 },
      seed: 1,
      reps: 30,
      durationMs: 12,
      engineVersion: "1.0.0",
    };
    const r = await saveRun(input);
    expect(r.status).toBe("ok");
    if (r.status === "ok") {
      const row = await one("select name, revision_ids, reps, seed, results, params_snapshot from runs where id = $1", [r.id]);
      expect(row).toMatchObject({ name: "Run 1", reps: 30, seed: 1, results: { reps: 30 } });
      expect(row.revision_ids).toContain(REV);
      expect(row.params_snapshot).toBeTypeOf("object");
    }
    expect(await saveRun({ ...input, revisionId: "99999999-9999-4999-8999-999999999999" })).toMatchObject({ status: "error", message: expect.stringMatching(/newer revision/) });
  });
});

describe("sharing", () => {
  it("makes a link, refreshes its copy, and turns it off", async () => {
    const { createShareLink, refreshShareLink, revokeShareLink } = await import("@/app/w/[slug]/share-actions");
    const made = await createShareLink(SLUG, { kind: "overview", targetId: null, people: false, financials: false, emails: "", expiresOn: null, label: "For the board" });
    expect(made).toMatchObject({ status: "ok", url: expect.stringMatching(/^https:\/\/flow\.example\/s\//) });
    const link = await one("select id, kind, label, mode, token_hash, revoked_at, engine_version from share_links where workspace_id = $1", [WS]);
    expect(link).toMatchObject({ kind: "overview", label: "For the board", mode: "view", revoked_at: null });
    expect(link.token_hash).toMatch(/^[0-9a-f]{64}$/);
    const before = (await one("select snapshot from share_links where id = $1", [link.id])).snapshot;
    expect(before).toBeTypeOf("object");
    expect(await refreshShareLink(SLUG, link.id)).toEqual({ status: "ok" });
    expect(await revokeShareLink(SLUG, link.id)).toEqual({ status: "ok" });
    expect((await one("select revoked_at from share_links where id = $1", [link.id])).revoked_at).not.toBeNull();
    expect(await revokeShareLink(SLUG, link.id)).toEqual({ status: "error", message: "That link is already off, or you can't change it." });
    expect(await refreshShareLink(SLUG, link.id)).toEqual({ status: "error", message: "This link was turned off." });
  });
});

describe("sources", () => {
  it("adds a source with its links in one go, links it again, and unlinks it", async () => {
    const { createSource, linkSource, unlinkSource } = await import("@/app/w/[slug]/source-actions");
    const made = await createSource(WS, { kind: "notes", title: "Call notes", body: "Rosa said so." }, [{ kind: "process", processId: P }, { kind: "step", processId: P, stepId: northbeamStepIds.audit }]);
    if (made.status !== "ok") throw new Error(JSON.stringify(made));
    expect(made.source).toMatchObject({ title: "Call notes", kind: "notes" });
    expect(made.links.map((l) => l.kind).sort()).toEqual(["process", "step"]);
    const again = await linkSource(made.source.id, { kind: "step", processId: P, stepId: northbeamStepIds.kickoff });
    expect(again).toMatchObject({ status: "ok", link: { kind: "step", step_id: northbeamStepIds.kickoff, workspace_id: WS } });
    expect(await linkSource(made.source.id, { kind: "step", processId: P, stepId: northbeamStepIds.kickoff })).toEqual({ status: "error", message: "That source is already linked to that." });
    if (again.status === "ok") expect(await unlinkSource(again.link.id)).toEqual({ status: "ok" });
    expect(await linkSource("99999999-9999-4999-8999-999999999999", { kind: "process", processId: P })).toEqual({ status: "error", message: "That source isn't there any more." });
    // An issue's own list and its links stay in step.
    const issue = (await q("select id from issues where workspace_id = $1 limit 1", [WS])).rows[0].id;
    const onIssue = await linkSource(made.source.id, { kind: "issue", issueId: issue });
    expect(onIssue.status).toBe("ok");
    expect((await q("select 1 from issue_sources where issue_id = $1 and source_id = $2", [issue, made.source.id])).rowCount).toBe(1);
    if (onIssue.status === "ok") expect(await unlinkSource(onIssue.link.id)).toEqual({ status: "ok" });
    expect((await q("select 1 from issue_sources where issue_id = $1 and source_id = $2", [issue, made.source.id])).rowCount).toBe(0);
    expect(await unlinkSource(`issue-source:${issue}:${made.source.id}`)).toEqual({ status: "error", message: "You don't have permission to change sources here." });
  });
});

describe("processes", () => {
  it("makes a library process (and a draft with a start and an end), then renames, retypes, archives and restores it", async () => {
    const { createLibraryProcess } = await import("@/app/w/[slug]/library-actions");
    const { renameProcess, changeProcessKind, archiveProcess, restoreProcess } = await import("@/app/w/[slug]/process-admin-actions");
    const made = await createLibraryProcess(WS, { kind: "new", name: "Onboarding checklist", processKind: "servicing" } as never);
    if (!made.process) throw new Error(JSON.stringify(made));
    const id = made.process.id;
    expect((await one("select count(*)::int as n from steps where process_id = $1", [id])).n).toBe(2);
    expect(await createLibraryProcess(WS, { kind: "new", name: "onboarding CHECKLIST", processKind: "servicing" } as never)).toEqual({ error: "There is already a process called 'onboarding CHECKLIST'. Give it another name." });
    expect(await renameProcess(id, "Onboarding steps")).toEqual({ status: "ok" });
    expect(await renameProcess(id, "Onboarding steps")).toEqual({ status: "ok" });
    const taken = (await one("select name from processes where workspace_id = $1 and id <> $2 and not is_company and archived_at is null limit 1", [WS, id])).name as string;
    expect(await renameProcess(id, taken.toUpperCase())).toEqual({ status: "error", message: `There is already a process called '${taken.toUpperCase()}'.` });
    expect(await changeProcessKind(id, "pipeline")).toEqual({ status: "ok" });
    expect(await one("select name, kind, entity_name from processes where id = $1", [id])).toEqual({ name: "Onboarding steps", kind: "pipeline", entity_name: "lead" });
    expect(await archiveProcess(id)).toEqual({ status: "ok" });
    expect((await one("select archived_at from processes where id = $1", [id])).archived_at).not.toBeNull();
    expect(await restoreProcess(id)).toEqual({ status: "ok" });
    expect((await one("select archived_at from processes where id = $1", [id])).archived_at).toBeNull();
    // Client work linked to a service can't become a pipeline: the message names the service.
    const servicing = (await q("select ss.process_id, s.name from service_servicing ss join services s on s.id = ss.service_id limit 1")).rows[0];
    expect(await changeProcessKind(servicing.process_id, "pipeline")).toMatchObject({ status: "error", message: expect.stringContaining(servicing.name) });
    // A viewer-like caller (not a member) changes nothing.
    signInAs({ tdb }, await addMember(tdb, WS, "viewer"));
    expect(await archiveProcess(id)).toEqual({ status: "error", message: "Only Agency admins can change processes here." });
  });

  it("opens, edits, publishes and discards a draft through the editor actions", async () => {
    const { openDraft, discardDraft, publishDraft, insertProcessRows, deleteProcessRows, saveProcessFields } = await import("@/app/w/[slug]/actions");
    const opened = await openDraft(P);
    if (opened.status !== "ok") throw new Error(JSON.stringify(opened));
    const rev = opened.revision.id;
    const step = "77777777-7777-4777-8777-777777777771";
    const step2 = "77777777-7777-4777-8777-777777777772";
    // Rows as the editor holds them: a live step with the editor's own fields only, under a new id.
    const model = northbeamBundle().steps.find((x) => x.id === northbeamStepIds.audit)!;
    const fields = Object.fromEntries(Object.entries(model).filter(([k]) => k === "work_params" || k === "wait_params" || (k !== "id" && !k.includes(".") && Object.hasOwn(STEP_FIELDS, k))));
    const row = (id: string, name: string) => ({ ...fields, id, name, role_id: null, person_id: null, rework_to_step_id: null, parent_step_id: null, entry_step_id: null, child_process_id: null });
    expect(await insertProcessRows(rev, [row(step, "New A"), row(step2, "New B")], [{ id: "88888888-8888-4888-8888-888888888881", from_step_id: step, to_step_id: step2, probability: 1, label: null, condition: null }])).toEqual({ status: "ok" });
    expect((await q("select 1 from steps where revision_id = $1 and id in ($2, $3)", [rev, step, step2])).rowCount).toBe(2);
    expect((await q("select 1 from edges where revision_id = $1", [rev])).rowCount).toBeGreaterThanOrEqual(1);
    expect(await saveProcessFields(rev, "steps", step, { name: "New A" }, { name: "Renamed" })).toMatchObject({ status: "saved" });
    expect((await one("select name from steps where revision_id = $1 and id = $2", [rev, step])).name).toBe("Renamed");
    expect(await deleteProcessRows(rev, [step, step2], ["88888888-8888-4888-8888-888888888881"])).toEqual({ status: "ok" });
    expect((await q("select 1 from steps where revision_id = $1 and id in ($2, $3)", [rev, step, step2])).rowCount).toBe(0);
    expect(await discardDraft(P)).toEqual({ status: "ok" });
    expect(await insertProcessRows(rev, [row(step, "Late")], [])).toMatchObject({ status: "error" });
    const again = await openDraft(P);
    expect(again.status).toBe("ok");
    const pub = await publishDraft(P, true);
    expect(["published", "unresolved"]).toContain(pub.status);
  });
});

describe("settings", () => {
  it("adds and removes people, leave, services, lead sources, roles and market conditions", async () => {
    const s = await import("@/app/w/[slug]/settings/actions");
    expect(await s.createPerson(WS, {}, form({ name: "Nova Test", role_id: northbeamRoleIds.strat }))).toEqual({});
    const person = await one("select id from people where workspace_id = $1 and name = 'Nova Test'", [WS]);
    expect((await q("select 1 from person_roles where person_id = $1 and role_id = $2", [person.id, northbeamRoleIds.strat])).rowCount).toBe(1);
    expect(await s.addLeave(person.id, WS, {}, form({ start_date: "2027-03-01", end_date: "2027-03-05", note: "Away" }))).toEqual({});
    const leave = await one("select id, note from person_leave where person_id = $1", [person.id]);
    expect(leave.note).toBe("Away");
    expect(await s.removeLeave(leave.id)).toEqual({});
    expect(await s.removeLeave(leave.id)).toEqual({ error: "That leave was already removed, or you can't edit it." });

    const before = Number((await one("select count(*) from services where workspace_id = $1", [WS])).count);
    expect(await s.createService(WS, {}, form({ name: "Audit only", price: "900", churn_monthly_base: "2", tenure_months: "12" }))).toEqual({});
    const service = await one("select id, mix_share, provenance from services where workspace_id = $1 and name = 'Audit only'", [WS]);
    expect(before).toBeGreaterThan(0);
    expect(Number(service.mix_share)).toBe(0);
    expect(service.provenance.churn_health_sensitivity.source).toBe("estimated");
    expect(await s.removeService(service.id)).toEqual({});

    expect(await s.createLeadSource(WS, {}, form({ name: "Podcast", volume_week: "2", conversion_to_qualified: "10" }))).toEqual({});
    const lead = await one("select id from lead_sources where workspace_id = $1 and name = 'Podcast'", [WS]);
    expect(await s.removeLeadSource(lead.id)).toEqual({});

    // Seasonality and growth: no row yet means the default, and the first save inserts it.
    expect(await s.saveSeasonality(WS, 3, 1, 1.2)).toEqual({ status: "saved", value: 1.2 });
    expect(Number((await one("select multiplier from seasonality where workspace_id = $1 and month = 3", [WS])).multiplier)).toBe(1.2);
    expect(await s.saveSeasonality(WS, 3, 1, 1.3)).toMatchObject({ status: "conflict" });
    expect(await s.resetSeasonality(WS)).toEqual({});
    expect((await q("select 1 from seasonality where workspace_id = $1", [WS])).rowCount).toBe(0);
    expect(await s.saveGrowth(WS, 0, 0.02)).toEqual({ status: "saved", value: 0.02 });

    expect(await s.createRole(WS, {}, form({ name: "Concierge" }))).toEqual({});

    const market = await s.createMarketCondition(WS, null);
    expect(market).toMatchObject({ id: expect.any(String) });
    const marketId = (market as { id: string }).id;
    expect(await s.saveMarketField(marketId, "name", "My market")).toEqual({ status: "saved", value: "My market" });
    expect(await s.addMarketChange(WS, {}, form({ condition_id: marketId, from_month: "1", to_month: "3" }))).toEqual({});
    expect(await s.addMarketChange(WS, {}, form({ condition_id: marketId, from_month: "2", to_month: "4" }))).toEqual({ error: "Those months overlap another change. Remove it first, or pick other months." });
    expect(await s.removeMarketCondition(marketId)).toEqual({ error: "This market is on your schedule. Remove it from the schedule first." });
    const change = await one("select id from market_schedule where condition_id = $1", [marketId]);
    expect(await s.removeMarketChange(change.id)).toEqual({});
    expect(await s.removeMarketCondition(marketId)).toEqual({});
  });

  it("sets up a client group on first edit, and keeps churn drivers", async () => {
    const s = await import("@/app/w/[slug]/settings/actions");
    const d = await import("@/app/w/[slug]/settings/churn-drivers-actions");
    const svc = await one("select s.id from services s where s.workspace_id = $1 and not exists (select 1 from client_groups g where g.service_id = s.id) limit 1", [WS]);
    if (svc) {
      expect(await s.saveClientGroupField(WS, svc.id, "client_count", null, 5)).toMatchObject({ status: "saved" });
      expect((await q("select 1 from client_groups where service_id = $1", [svc.id])).rowCount).toBe(1);
    }
    const added = await d.addChurnDriver(WS);
    expect(added).toMatchObject({ status: "saved" });
    if (added.status !== "saved") return;
    expect(await d.saveChurnDriver(WS, added.rowId, { name: "Late invoices" })).toEqual({ status: "saved", rowId: added.rowId });
    expect(await d.removeChurnDriver(WS, added.rowId)).toEqual({ status: "saved", rowId: added.rowId });
    expect(await d.removeChurnDriver(WS, added.rowId)).toMatchObject({ status: "error" });
    // A built-in driver's row is made the first time it is changed.
    const builtin = await d.saveChurnDriver(WS, "price", { weight: 2 });
    expect(builtin).toMatchObject({ status: "saved" });
    expect(await d.saveChurnDriver(WS, "price", { weight: 3 })).toEqual({ status: "saved", rowId: (builtin as { rowId: string }).rowId });
    expect(Number((await one("select weight from churn_drivers where workspace_id = $1 and driver = 'price'", [WS])).weight)).toBe(3);
  });

  it("adds a client, assigns people to it, and links servicing", async () => {
    const c = await import("@/app/w/[slug]/settings/client-actions");
    const sv = await import("@/app/w/[slug]/settings/servicing-actions");
    expect(await c.addClient(WS, {}, form({ name: "Test Client Ltd", mrr: "1200", start_date: "2026-09-01" }))).toEqual({});
    const client = await one("select id from clients where workspace_id = $1 and name = 'Test Client Ltd'", [WS]);
    const person = northbeamPersonIds["Maya Collins"]!;
    expect(await c.saveClientAssignment(client.id, WS, northbeamRoleIds.strat, null, person)).toEqual({ status: "saved", value: person });
    expect(await c.saveClientAssignment(client.id, WS, northbeamRoleIds.strat, null, person)).toEqual({ status: "saved", value: person });
    expect(await c.saveClientAssignment(client.id, WS, northbeamRoleIds.strat, null, northbeamPersonIds["Leah Brooks"]!)).toEqual({ status: "conflict", theirs: person });
    expect(await c.saveClientAssignment(client.id, WS, northbeamRoleIds.strat, person, null)).toEqual({ status: "saved", value: null });
    expect((await q("select 1 from client_assignments where client_id = $1", [client.id])).rowCount).toBe(0);

    const process = (await one("select id from processes where workspace_id = $1 and kind = 'servicing' and not is_company and not exists (select 1 from service_servicing l where l.process_id = processes.id) limit 1", [WS]))?.id as string | undefined;
    const linkedAlready = await one("select service_id, process_id, id from service_servicing limit 1");
    expect(await sv.linkServicingProcess(WS, linkedAlready.service_id, linkedAlready.process_id)).toEqual({ error: "That service already runs this process." });
    expect(process === undefined || (await sv.linkServicingProcess(WS, northbeamServiceIds.seo, process)).error === undefined).toBe(true);
    expect(await sv.saveServicingSla(linkedAlready.id, null, 8)).toMatchObject({ status: expect.stringMatching(/saved|conflict/) });
  });
});

describe("history, first principles and calibration", () => {
  it("duplicates a published version as a new process, and restores one into the draft", async () => {
    const { duplicateVersion, restoreVersion } = await import("@/app/w/[slug]/p/[processId]/history/actions");
    const dup = await duplicateVersion(P, REV, "Northbeam copy");
    expect(dup).toMatchObject({ status: "duplicated", processId: expect.any(String) });
    expect(await duplicateVersion(P, REV, "northbeam COPY")).toEqual({ status: "error", message: "There is already a process called 'northbeam COPY'." });
    expect(await duplicateVersion(P, "99999999-9999-4999-8999-999999999999", "x")).toMatchObject({ status: "error" });
    const r = await restoreVersion(P, REV, true);
    expect(["restored", "error"]).toContain(r.status);
  });

  it("saves first principles into a draft", async () => {
    const { saveFirstPrinciplesAction } = await import("@/app/w/[slug]/p/[processId]/first-principles/actions");
    const out = await saveFirstPrinciplesAction(WS, P, { purpose: "Win good clients" }, null, null);
    expect(out, JSON.stringify(out)).toMatchObject({ status: "saved" });
  });

  it("records an import dataset and a client calibration refusal", async () => {
    const { recordDataset } = await import("@/app/w/[slug]/settings/calibration/actions");
    const bad = await recordDataset({ workspaceId: WS, kind: "nope", fileName: "x.csv", columnMap: {}, rowCount: 1 });
    expect(bad).toMatchObject({ status: "error" });
    signInAs({ tdb }, owner);
    const bad2 = await recordDataset({ workspaceId: WS, kind: "leads", fileName: "", columnMap: {}, rowCount: 1 });
    expect(bad2).toMatchObject({ status: "error" });
  });
});

describe("access settings", () => {
  const url = (u: string) => new URLSearchParams(u.split("?")[1]);

  it("links a signed-in person to a person record, once per person", async () => {
    signInAs({ tdb }, owner);
    const a = await import("@/app/w/[slug]/settings/access/actions");
    const member = await one("select id from memberships where user_id = $1", [editor.id]);
    const person = (await one("select id from people p where workspace_id = $1 and not exists (select 1 from memberships m where m.person_id = p.id) limit 1", [WS])).id as string;
    const linked = await redirected(() => a.setMemberPerson(SLUG, form({ id: member.id, person_id: person })));
    expect(linked, linked).toContain("notice=Linked");
    const second = await one("select id from memberships where user_id = $1", [owner.id]);
    expect(url(await redirected(() => a.setMemberPerson(SLUG, form({ id: second.id, person_id: person })))).get("error")).toBeTruthy();
    expect(await redirected(() => a.setMemberPerson(SLUG, form({ id: member.id, person_id: "" })))).toContain("notice=Unlinked");
  });

  it("lets an Agency admin add, change and remove a Viewer or Agency admin rule, but not an Owner rule", async () => {
    signInAs({ tdb }, owner);
    const a = await import("@/app/w/[slug]/settings/access/actions");
    expect(url(await redirected(() => a.addDeploymentRule(SLUG, form({ kind: "email", value: " New@Person.example ", role: "viewer" })))).get("notice")).toBe("new@person.example can now sign in as a Viewer.");
    expect(url(await redirected(() => a.addDeploymentRule(SLUG, form({ kind: "email", value: "new@person.example", role: "viewer" })))).get("error")).toMatch(/already on the list/);
    const rule = await one("select id from deployment_access where value = 'new@person.example'", []);
    expect(url(await redirected(() => a.setDeploymentRole(SLUG, form({ id: rule.id, role: "agency_admin" })))).get("notice")).toMatch(/^Saved/);
    expect((await one("select role from deployment_access where id = $1", [rule.id])).role).toBe("agency_admin");
    // Not an Owner rule: the database refuses, and the page says why.
    const refused = url(await redirected(() => a.addDeploymentRule(SLUG, form({ kind: "email", value: "sneaky@person.example", role: "owner" }))));
    expect(refused.get("error")).toMatch(/Only an Owner can add, change or remove an Owner/);
    expect(url(await redirected(() => a.setDeploymentRole(SLUG, form({ id: rule.id, role: "owner" })))).get("error")).toMatch(/Only an Owner/);
    expect(url(await redirected(() => a.addDeploymentRule(SLUG, form({ kind: "email", value: "x@y.example", role: "editor" })))).get("error")).toBeTruthy();
    expect(url(await redirected(() => a.removeDeploymentRule(SLUG, form({ id: rule.id })))).get("notice")).toMatch(/^Removed/);
  });

  it("lets the Owner make an Owner rule, and stops a Viewer changing the list", async () => {
    const a = await import("@/app/w/[slug]/settings/access/actions");
    signInAs({ tdb }, admin);
    expect(url(await redirected(() => a.addDeploymentRule(SLUG, form({ kind: "email", value: "second@owner.example", role: "owner" })))).get("notice")).toMatch(/an Owner/);
    const rule = await one("select id from deployment_access where value = 'second@owner.example'", []);
    signInAs({ tdb }, viewer);
    expect(url(await redirected(() => a.removeDeploymentRule(SLUG, form({ id: rule.id })))).get("error")).toBeTruthy();
    expect((await one("select role from deployment_access where id = $1", [rule.id])).role).toBe("owner");
  });
});
