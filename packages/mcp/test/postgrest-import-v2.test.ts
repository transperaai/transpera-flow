import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkProcessFile, findGaps, gapInputFromBundle, PROCESS_FILE_EXAMPLE_2, type Database } from "@transpera-flow/db";
import { importProcessFile, previewProcessFile, ToolError } from "../src";
import type { ToolContext } from "../src/context";
import { signJwt } from "./helpers";

// Upload a transpera-process/2 file (issue #167, B14), end to end as the web app does it: checked file → shared import code →
// PostgREST with RLS as the signed-in user → `import_process_bundle`. Every section lands (draft with step evidence, sources and
// their links, first principles, pending suggestions, pending proposals) and nothing company-level is applied. Skipped unless
// POSTGREST_URL is set (see postgrest-import-file.test.ts).

const POSTGREST_URL = process.env.POSTGREST_URL;
const JWT_SECRET = process.env.POSTGREST_JWT_SECRET ?? "";
const ADMIN_URL = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/postgres";
const DATABASE_NAME = process.env.POSTGREST_DATABASE ?? "transpera_flow_postgrest";
const SUPABASE_URL = "https://project.supabase.test";

let admin: pg.Client;
let workspaceId: string;
let editorCtx: ToolContext;
let viewerCtx: ToolContext;
let editorId: string;
let mdRoleId: string;

const toPostgrest: typeof fetch = (input, init) => fetch(String(input).replace(`${SUPABASE_URL}/rest/v1`, POSTGREST_URL!), init);

async function createUser(email: string) {
  const id = randomUUID();
  await admin.query("insert into auth.users (id, email) values ($1, $2)", [id, email]);
  return id;
}

function contextFor(userId: string): ToolContext {
  const anon = signJwt({ role: "anon", iss: "test" }, JWT_SECRET);
  const user = signJwt({ sub: userId, role: "authenticated", iss: "test", aud: "authenticated" }, JWT_SECRET);
  const db = createClient<Database>(SUPABASE_URL, anon, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: { Authorization: `Bearer ${user}` }, fetch: toPostgrest },
  });
  return { db, tokenHash: "", userId, activeWorkspaceId: null, today: "2026-10-05" };
}

// Loosely typed on purpose: the tests change a file one way at a time, by reaching into it.
function v2(change: (f: ReturnType<typeof JSON.parse>) => void = () => {}) {
  const f = JSON.parse(JSON.stringify(PROCESS_FILE_EXAMPLE_2));
  f.name = `V2 ${randomUUID().slice(0, 8)}`;
  change(f);
  const checked = checkProcessFile(f);
  expect(checked.errors).toEqual([]);
  return checked.file!;
}

const q = async (sql: string, params: unknown[] = []) => (await admin.query(sql, params)).rows;
const count = async (sql: string, params: unknown[] = []) => Number((await q(sql, params))[0].n);
const counts = async () => ({
  processes: await count("select count(*) n from processes where workspace_id = $1", [workspaceId]),
  sources: await count("select count(*) n from sources where workspace_id = $1", [workspaceId]),
  suggestions: await count("select count(*) n from suggestions where workspace_id = $1", [workspaceId]),
  proposals: await count("select count(*) n from suggestion_proposals where workspace_id = $1", [workspaceId]),
  fp: await count("select count(*) n from first_principles where workspace_id = $1", [workspaceId]),
});

describe.skipIf(!POSTGREST_URL)("uploading a transpera-process/2 file over PostgREST", () => {
  beforeAll(async () => {
    const url = new URL(ADMIN_URL);
    url.pathname = `/${DATABASE_NAME}`;
    admin = new pg.Client({ connectionString: url.toString() });
    await admin.connect();
    workspaceId = (await q("insert into workspaces (name, slug) values ('V2 Co', 'v2-co-' || substr(gen_random_uuid()::text, 1, 8)) returning id"))[0].id;
    mdRoleId = (await q("insert into roles (workspace_id, name) values ($1, 'Managing director') returning id", [workspaceId]))[0].id;
    await q("insert into people (workspace_id, name, fte) values ($1, 'Maya Chen', 0.5)", [workspaceId]);
    editorId = await createUser(`v2-editor-${randomUUID()}@example.com`);
    const viewerId = await createUser(`v2-viewer-${randomUUID()}@example.com`);
    await q("insert into memberships (workspace_id, user_id, role) values ($1, $2, 'editor'), ($1, $3, 'viewer')", [workspaceId, editorId, viewerId]);
    editorCtx = contextFor(editorId);
    viewerCtx = contextFor(viewerId);
    const deadline = Date.now() + 60_000;
    for (;;) {
      const r = await editorCtx.db.from("workspaces").select("id");
      if (!r.error && (r.data ?? []).length >= 1) break;
      if (Date.now() > deadline) throw new Error("PostgREST never became ready");
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  });

  afterAll(async () => {
    await admin?.end();
  });

  it("every section lands: draft with step evidence, sources and links, first principles, pending suggestions and proposals", async () => {
    const people = await count("select count(*) n from people where workspace_id = $1", [workspaceId]);
    const roles = await count("select count(*) n from roles where workspace_id = $1", [workspaceId]);
    const services = await count("select count(*) n from services where workspace_id = $1", [workspaceId]);
    const leads = await count("select count(*) n from lead_sources where workspace_id = $1", [workspaceId]);
    const issues = await count("select count(*) n from issues where workspace_id = $1", [workspaceId]);
    const file = v2();
    const r = await importProcessFile(editorCtx, file, { workspaceId, source: "v2.json" });
    expect(r.bundle).toEqual({ sources: 3, suggestions: expect.any(Number), proposals: 1, first_principles: true });
    expect(r.bundle!.suggestions).toBeGreaterThanOrEqual(3);
    const proc = (await q("select * from processes where workspace_id = $1 and name = $2", [workspaceId, file.name]))[0];
    expect(proc).toMatchObject({ live_revision_id: null, draft_revision_id: r.revision_id, source: "import" });

    // Steps: role matched, evidence cited with the real source ids, assumptions carry their reason, branch odds not given are marked.
    const steps = Object.fromEntries((await q("select * from steps where revision_id = $1", [r.revision_id])).map((s) => [s.name, s]));
    const sources = Object.fromEntries((await q("select * from sources where workspace_id = $1 and title like any (array['Interview with Maya%', 'Sales process SOP%', 'Lead export%'])", [workspaceId])).map((s) => [s.kind, s]));
    expect(Object.keys(sources).sort()).toEqual(["data", "notes", "transcript"]);
    expect(sources.transcript).toMatchObject({ speakers: ["Maya Chen", "Interviewer"], created_by: editorId });
    expect(String(sources.transcript.recorded_at)).toContain("2026");
    expect(sources.transcript.body).toContain("fifteen minutes");
    expect(steps["Review enquiry"]).toMatchObject({ role_id: mdRoleId, tool: "HubSpot" });
    const cite = steps["Write proposal"].provenance.work_hours.evidence[0];
    expect(cite).toMatchObject({ source_id: sources.transcript.id, speaker: "Maya Chen", timestamp: "00:06:40", value: 3 });
    expect(Number(steps["Write proposal"].work_hours)).toBe(3);
    expect(Number(steps["Write proposal"].current_wip)).toBe(2);
    expect(steps["Review enquiry"].provenance.wait_hours).toMatchObject({ assumption: true, note: "Nobody gave a wait; four hours is the half-day the SOP allows." });
    expect(steps["Discovery call"]).toMatchObject({ work_dist: "triangular", work_params: { min: 0.5, mode: 1, max: 1.5 } });
    expect(steps["Client decides"].provenance.branch_odds).toBeUndefined();
    expect(steps["Review enquiry"].notes).toContain("Odds to Discovery call [Qualified] (67%): “maybe two in three are a fit”");
    expect(steps["Client decides"].notes).toContain("Odds to Client signs [Signs] (60%): assumed: No data on win rate yet");
    expect(steps["Review enquiry"].notes).toContain("Checked the same day");

    // Sources are linked to the process, and the interview to the steps that cite it: none says "Not linked".
    const links = await q("select s.kind skind, l.kind, l.step_id from source_links l join sources s on s.id = l.source_id where l.process_id = $1", [proc.id]);
    expect(links.filter((l) => l.kind === "process").map((l) => l.skind).sort()).toEqual(["data", "notes", "transcript"]);
    expect(links.filter((l) => l.kind === "step").every((l) => l.skind === "transcript")).toBe(true);
    expect(links.filter((l) => l.kind === "step").map((l) => l.step_id)).toContain(steps["Write proposal"].id);

    // First principles are written to the draft.
    const fp = (await q("select * from first_principles where process_id = $1", [proc.id]))[0];
    expect(fp).toMatchObject({ revision_id: r.revision_id, job_who: "A founder who needs marketing help", job_done: "A signed engagement letter they trust" });
    const req = fp.requirements[0];
    expect(req).toMatchObject({ text: "Every enquiry gets a reply the same day", owner_text: "", verdict: "keep", step_id: steps["Review enquiry"].id });
    expect(req.owner_person_id).not.toBeNull();
    expect(req.why).toContain("“Every enquiry gets a reply the same day.” (Sales process SOP, version 3, page 1)");
    expect(fp.measures[0]).toMatchObject({ kpi: "winRate", comparator: "atLeast", target: 0.3 });
    expect(JSON.stringify(fp.statements)).toContain("The job, as said");

    // Company facts: pending suggestions with their evidence; nothing applied.
    const sugg = await q("select target_table, target_id, status, patch, evidence, note from suggestions where workspace_id = $1 order by target_table", [workspaceId]);
    expect(sugg.every((s) => s.status === "pending")).toBe(true);
    const byTable = (t: string) => sugg.filter((s) => s.target_table === t);
    expect(byTable("roles")[0]).toMatchObject({ patch: { set: { name: "Account manager" } }, note: "Assumed: The SOP names the role but nobody holds it yet." });
    expect(byTable("services")[0].patch.set).toMatchObject({ name: "Monthly retainer", price: 1500, pricing_model: "retainer" });
    expect(byTable("services")[0].evidence[0]).toMatchObject({ source_id: sources.notes.id, timestamp: "page 2" });
    expect(byTable("lead_sources")[0].patch.set).toMatchObject({ name: "Website form", volume_week: 8 });
    // Maya exists already: the suggestion is a change to her, not a new person (fte 0.5 → 1).
    expect(byTable("people")[0]).toMatchObject({ target_id: expect.any(String) });
    expect(byTable("people")[0].patch.set).toMatchObject({ fte: 1 });
    expect(await count("select count(*) n from people where workspace_id = $1", [workspaceId])).toBe(people);
    expect(await count("select count(*) n from roles where workspace_id = $1", [workspaceId])).toBe(roles);
    expect(await count("select count(*) n from services where workspace_id = $1", [workspaceId])).toBe(services);
    expect(await count("select count(*) n from lead_sources where workspace_id = $1", [workspaceId])).toBe(leads);
    expect(await count("select count(*) n from issues where workspace_id = $1", [workspaceId])).toBe(issues);

    // Proposals: a pending issue linked to the new process and step, with its quote.
    const prop = (await q("select * from suggestion_proposals where workspace_id = $1 and title = 'Proposals sit for a day before review'", [workspaceId]))[0];
    expect(prop).toMatchObject({ kind: "issue", status: "pending" });
    expect(prop.payload).toMatchObject({ severity: "warning", type: "delay", links: [{ process_id: proc.id, step_id: steps["Write proposal"].id }] });
    expect(prop.evidence[0]).toMatchObject({ source_id: sources.transcript.id, speaker: "Maya Chen" });

    // A person accepting the proposal makes a real issue linked to the new process's step (the draft's), as for any proposal.
    const review = await editorCtx.db.rpc("review_proposals", { ids: [prop.id], decision: "accept" });
    expect(review.error).toBeNull();
    expect(JSON.stringify(review.data)).toContain("accepted");
    expect(await count("select count(*) n from issues where workspace_id = $1", [workspaceId])).toBe(issues + 1);
  });

  it("the preview says what each section would make and where the sources disagree, and writes nothing", async () => {
    const before = await counts();
    const file = v2((f) => {
      f.steps.find((s: { id: string }) => s.id === "proposal").evidence.hands_on_hours.push({ source: "sales-sop", time: "page 3", quote: "Allow a day to write a proposal.", value: 8 });
    });
    const checked = checkProcessFile(JSON.parse(JSON.stringify({ ...file })));
    expect(checked.conflicts).toHaveLength(1);
    const p = await previewProcessFile(editorCtx, workspaceId, file);
    expect(p.extras!.sources).toHaveLength(3);
    expect(p.extras!.suggestions.length).toBeGreaterThanOrEqual(4);
    expect(p.extras!.suggestions.map((s) => s.subject).join("|")).toContain("Monthly retainer");
    expect(p.extras!.proposals).toEqual([{ kind: "issue", title: "Proposals sit for a day before review", forIssue: null }]);
    expect(p.extras!.firstPrinciplesParts).toBeGreaterThan(0);
    // Maya's fte differs from the company's: shown as a conflict, not applied.
    expect(p.extras!.conflicts.join("\n")).toMatch(/Person Maya Chen: fte is 0\.5 in your company, 1 in the file/);
    expect(await counts()).toEqual(before);
  });

  it("is all or nothing: a name already taken leaves no source, suggestion, proposal or first principles behind", async () => {
    const first = v2();
    await importProcessFile(editorCtx, first, { workspaceId, source: "first.json" });
    const before = await counts();
    await expect(importProcessFile(editorCtx, v2((f) => (f.name = first.name)), { workspaceId, source: "again.json" })).rejects.toMatchObject({ code: "name_taken" });
    expect(await counts()).toEqual(before);
  });

  it("a viewer is refused whole", async () => {
    const before = await counts();
    await expect(importProcessFile(viewerCtx, v2(), { workspaceId, source: "v.json" })).rejects.toBeInstanceOf(ToolError);
    expect(await counts()).toEqual(before);
  });

  it("leaves out what can't be placed and says so: an idea for an issue that doesn't exist, a role the company lacks", async () => {
    const file = v2((f) => {
      f.proposals.push({ type: "solution_idea", title: "Automate review", for_issue: "#999", proposed_steps: [{ name: "Bot" }], assumed: "A hunch." });
      f.company.people.push({ name: "New Hire", roles: ["Account manager"], assumed: "Starts next month." });
    });
    const before = await counts();
    const r = await importProcessFile(editorCtx, file, { workspaceId, source: "gaps.json" });
    const after = await counts();
    expect(after.proposals - before.proposals).toBe(1);
    expect(r.warnings.join("\n")).toMatch(/Proposal 'Automate review' was left out/);
    expect(r.warnings.join("\n")).toMatch(/Person 'New Hire': the role 'Account manager' isn't one of yours yet \(the file suggests it/);
    const hire = (await q("select patch from suggestions where workspace_id = $1 and patch -> 'set' ->> 'name' = 'New Hire'", [workspaceId]))[0];
    expect(hire.patch.roles).toBeUndefined();
  });

  it("a solution idea for an issue you track becomes a pending proposal", async () => {
    const issue = (await q("select id from issues where workspace_id = $1 and number is not null and status = 'open' limit 1", [workspaceId]))[0];
    expect(issue).toBeDefined();
    const number = (await q("select number from issues where id = $1", [issue.id]))[0].number;
    const file = v2((f) => {
      f.proposals.push({ type: "solution_idea", title: "Fast-track review", for_issue: `#${number}`, proposed_steps: [{ name: "Auto-review", kind: "task", role: "Managing director" }], expect: "Same-day review.", assumed: "A hunch." });
    });
    await importProcessFile(editorCtx, file, { workspaceId, source: "idea.json" });
    const idea = (await q("select kind, issue_id, payload from suggestion_proposals where workspace_id = $1 and title = 'Fast-track review'", [workspaceId]))[0];
    expect(idea).toMatchObject({ kind: "solution_idea", issue_id: issue.id });
    expect(idea.payload.steps[0]).toMatchObject({ name: "Auto-review", role: "Managing director" });
  });

  it("a /1 file still uploads unchanged: no sources, suggestions, proposals or first principles", async () => {
    const before = await counts();
    const f = JSON.parse(JSON.stringify(PROCESS_FILE_EXAMPLE_2));
    const v1 = checkProcessFile({ format: "transpera-process/1", name: `V1 ${randomUUID().slice(0, 6)}`, steps: f.steps.map((s: Record<string, unknown>) => ({ id: s.id, name: s.name, type: s.type, role: s.role, hands_on_hours: s.hands_on_hours, wait_hours: s.wait_hours })), links: f.links.map((l: Record<string, unknown>) => ({ from: l.from, to: l.to, probability: l.probability, label: l.label })) });
    expect(v1.errors).toEqual([]);
    const r = await importProcessFile(editorCtx, v1.file!, { workspaceId, source: "old.json" });
    expect(r.bundle).toBeUndefined();
    const after = await counts();
    expect(after).toEqual({ ...before, processes: before.processes + 1 });
    const decides = (await q("select provenance from steps where revision_id = $1 and name = 'Client decides'", [r.revision_id]))[0];
    expect(decides.provenance.branch_odds).toBeUndefined();
  });

  it("odds given only as quoted values round-trip: the preview, the checker and the stored edges agree, and nothing is flagged", async () => {
    const file = checkProcessFile({
      format: "transpera-process/2",
      name: `Quoted odds ${randomUUID().slice(0, 6)}`,
      sources: [{ id: "t", title: "Talk" }],
      steps: [
        { id: "s", name: "Start here", type: "start" },
        { id: "d", name: "Client decides", type: "decision" },
        { id: "y", name: "Yes", type: "end" },
        { id: "n", name: "No", type: "end" },
        { id: "m", name: "Maybe", type: "end" },
      ],
      links: [
        { from: "s", to: "d" },
        { from: "d", to: "y", evidence: [{ source: "t", quote: "Six in ten sign.", value: 0.6 }] },
        { from: "d", to: "n", evidence: [{ source: "t", quote: "About a fifth say no.", value: 0.2 }, { source: "t", quote: "More like a quarter.", value: 0.3 }] },
        { from: "d", to: "m", probability: 0.2 },
      ],
    }).file!;
    expect(file.links.map((l) => l.probability)).toEqual([undefined, 0.6, 0.25, 0.2]);
    const preview = await previewProcessFile(editorCtx, workspaceId, file);
    expect(preview.gap.gaps.map((g) => g.text)).not.toContain("Client decides: branch odds missing");
    const r = await importProcessFile(editorCtx, file, { workspaceId, source: "quoted.json" });
    const edges = await q("select e.probability::float8 p, t.name from edges e join steps t on t.id = e.to_step_id and t.revision_id = e.revision_id where e.revision_id = $1 and e.from_step_id = (select id from steps where revision_id = $1 and name = 'Client decides')", [r.revision_id]);
    expect(Object.fromEntries(edges.map((e) => [e.name, e.p]))).toEqual({ Yes: 0.6, No: 0.25, Maybe: 0.2 });
    const decides = (await q("select provenance from steps where revision_id = $1 and name = 'Client decides'", [r.revision_id]))[0];
    expect(decides.provenance.branch_odds).toBeUndefined();
    const proc = (await q("select id from processes where draft_revision_id = $1", [r.revision_id]))[0].id;
    const steps = await q("select * from steps where revision_id = $1", [r.revision_id]);
    const edgeRows = await q("select * from edges where revision_id = $1", [r.revision_id]);
    const model = findGaps(gapInputFromBundle({ steps, edges: edgeRows, process: (await q("select * from processes where id = $1", [proc]))[0], leadSources: [{ volume_week: 1 }], servicingLinks: [] } as never));
    expect(model.map((g) => g.text)).toEqual([]);
  });

  it("a two-branch decision with one branch's odds given takes the rest for the other and is not flagged", async () => {
    const file = checkProcessFile({
      format: "transpera-process/2",
      name: `Two branch ${randomUUID().slice(0, 6)}`,
      steps: [
        { id: "s", name: "Start here", type: "start" },
        { id: "d", name: "Client decides", type: "decision" },
        { id: "y", name: "Yes", type: "end" },
        { id: "n", name: "No", type: "end" },
      ],
      links: [{ from: "s", to: "d" }, { from: "d", to: "y", probability: 0.7 }, { from: "d", to: "n" }],
    }).file!;
    const preview = await previewProcessFile(editorCtx, workspaceId, file);
    expect(preview.gap.gaps.map((g) => g.text)).not.toContain("Client decides: branch odds missing");
    const r = await importProcessFile(editorCtx, file, { workspaceId, source: "two.json" });
    const no = (await q("select e.probability::float8 p from edges e join steps t on t.id = e.to_step_id and t.revision_id = e.revision_id where e.revision_id = $1 and t.name = 'No'", [r.revision_id]))[0];
    expect(no.p).toBeCloseTo(0.3);
    expect((await q("select provenance from steps where revision_id = $1 and name = 'Client decides'", [r.revision_id]))[0].provenance.branch_odds).toBeUndefined();
  });

  it("an upload's suggestions and proposals say where they came from, and the reviewer sees it", async () => {
    const r = await importProcessFile(editorCtx, v2(), { workspaceId, source: "from-claude.json" });
    expect(r.bundle!.proposals).toBe(1);
    const rows = await q("select created_via, import_source from suggestions where workspace_id = $1 and import_source = 'from-claude.json'", [workspaceId]);
    expect(rows.length).toBeGreaterThan(2);
    expect(rows.every((x) => x.created_via === "upload")).toBe(true);
    const prop = await q("select created_via, import_source from suggestion_proposals where workspace_id = $1 and import_source = 'from-claude.json'", [workspaceId]);
    expect(prop).toEqual([{ created_via: "upload", import_source: "from-claude.json" }]);
    // The app reads the proposal's source column as the signed-in user.
    const read = await editorCtx.db.from("suggestion_proposals").select("created_via, import_source").eq("import_source", "from-claude.json");
    expect(read.error).toBeNull();
    expect(read.data).toEqual([{ created_via: "upload", import_source: "from-claude.json" }]);
  });

  describe("Missing for simulation", () => {
    const gapsOf = async (revisionId: string, processId: string) => {
      const proc = (await q("select * from processes where id = $1", [processId]))[0];
      const steps = await q("select * from steps where revision_id = $1", [revisionId]);
      const edges = await q("select * from edges where revision_id = $1", [revisionId]);
      return findGaps(gapInputFromBundle({ steps, edges, process: proc, leadSources: [], servicingLinks: [] } as never)).map((g) => g.text).sort();
    };
    /** A pipeline with a work step that has no role or hands-on time, a wait step with no wait, and a decision with no odds. */
    const sparse = () =>
      checkProcessFile({
        format: "transpera-process/2",
        name: `Sparse ${randomUUID().slice(0, 6)}`,
        steps: [
          { id: "s", name: "Start here", type: "start" },
          { id: "w", name: "Write proposal", type: "step" },
          { id: "p", name: "Wait for payment", type: "wait" },
          { id: "d", name: "Client decides", type: "decision" },
          { id: "y", name: "Yes", type: "end" },
          { id: "n", name: "No", type: "end" },
        ],
        links: [
          { from: "s", to: "w" },
          { from: "w", to: "p" },
          { from: "p", to: "d" },
          { from: "d", to: "y" },
          { from: "d", to: "n" },
        ],
      }).file!;

    it("lists each gap type for what the upload had to leave out, and each clears when the value is filled in", async () => {
      const file = sparse();
      const preview = await previewProcessFile(editorCtx, workspaceId, file);
      expect(preview.gap.gaps.map((g) => g.text)).toEqual([
        "Write proposal has no role",
        "Write proposal has no hands-on time",
        "Wait for payment has no wait time",
        "Client decides: branch odds missing",
        "No incoming volume: add lead volume in Settings or accept the suggestion",
      ]);
      const r = await importProcessFile(editorCtx, file, { workspaceId, source: "sparse.json" });
      const proc = (await q("select id from processes where draft_revision_id = $1", [r.revision_id]))[0].id;
      // The same check on the draft's model finds the same gaps (volume: the workspace has no lead source with volume).
      expect(await gapsOf(r.revision_id, proc)).toEqual(preview.gap.gaps.map((g) => g.text).sort());

      // 1. A role. 2. Hands-on time (entered by a person: provenance changes). 3. A wait. 4. Odds. 5. Volume.
      const fill = async (sql: string, params: unknown[]) => {
        const res = await q(sql, params);
        return res;
      };
      const step = async (name: string) => (await q("select id from steps where revision_id = $1 and name = $2", [r.revision_id, name]))[0].id as string;
      await fill("update steps set role_id = $1 where id = $2 and revision_id = $3", [mdRoleId, await step("Write proposal"), r.revision_id]);
      expect(await gapsOf(r.revision_id, proc)).not.toContain("Write proposal has no role");
      await fill("update steps set provenance = jsonb_set(provenance, '{work_hours}', '{\"source\":\"entered\"}') where id = $1 and revision_id = $2", [await step("Write proposal"), r.revision_id]);
      expect(await gapsOf(r.revision_id, proc)).not.toContain("Write proposal has no hands-on time");
      await fill("update steps set provenance = jsonb_set(provenance, '{wait_hours}', '{\"source\":\"entered\"}') where id = $1 and revision_id = $2", [await step("Wait for payment"), r.revision_id]);
      expect(await gapsOf(r.revision_id, proc)).not.toContain("Wait for payment has no wait time");
      await fill("update edges set probability = 0.7 where revision_id = $1 and from_step_id = $2 and to_step_id = $3", [r.revision_id, await step("Client decides"), await step("Yes")]);
      expect(await gapsOf(r.revision_id, proc)).not.toContain("Client decides: branch odds missing");
      expect(await gapsOf(r.revision_id, proc)).toEqual(["No incoming volume: add lead volume in Settings or accept the suggestion"]);
    });

    it("values the file states, backs with a quote or marks assumed are not gaps", async () => {
      const file = checkProcessFile({
        format: "transpera-process/2",
        name: `Complete ${randomUUID().slice(0, 6)}`,
        sources: [{ id: "t", title: "Talk" }],
        steps: [
          { id: "s", name: "Start here", type: "start" },
          { id: "w", name: "Write proposal", type: "step", role: "Managing director", hands_on_hours: 2 },
          { id: "p", name: "Wait for payment", type: "wait", wait_hours: 336, assumed: { wait_hours: "Terms are 14 days." } },
          { id: "d", name: "Client decides", type: "decision" },
          { id: "y", name: "Yes", type: "end" },
          { id: "n", name: "No", type: "end" },
        ],
        links: [
          { from: "s", to: "w" },
          { from: "w", to: "p" },
          { from: "p", to: "d" },
          { from: "d", to: "y", probability: 0.6 },
          { from: "d", to: "n", probability: 0.4, assumed: "Whatever is left." },
        ],
      }).file!;
      const preview = await previewProcessFile(editorCtx, workspaceId, file);
      expect(preview.gap.gaps.map((g) => g.text)).toEqual(["No incoming volume: add lead volume in Settings or accept the suggestion"]);
      const r = await importProcessFile(editorCtx, file, { workspaceId, source: "complete.json" });
      const proc = (await q("select id from processes where draft_revision_id = $1", [r.revision_id]))[0].id;
      expect(await gapsOf(r.revision_id, proc)).toEqual(["No incoming volume: add lead volume in Settings or accept the suggestion"]);
    });
  });
});
