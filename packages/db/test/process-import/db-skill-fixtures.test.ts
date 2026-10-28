import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkProcessFile } from "../../src";
import { importProcessFile, previewProcessFile } from "../../src/process-import";
import type { ImportContext } from "../../src/process-import/context";
import { startTestDb, userClaims, type ImportTestDb } from "./helpers";

// The process-file skill's fixtures (issue #167, B14 part 2): the Tidewater and Copperleaf files in docs/import/examples/, as the
// skill would write them, uploaded the way the web app does (checked file, shared import code, Kysely under RLS as the signed-in
// user). Each lands as a draft with step evidence, sources and their links and first principles; nothing
// company-level is touched. The files themselves are checked in packages/db/test/process-file-skill-fixtures.test.ts. Runs on
// a throwaway database (test/helpers.ts).

let env: ImportTestDb;
let admin: pg.Client;
/** The workspaces and users these tests make. */
const madeWorkspaces: string[] = [];
const madeUsers: string[] = [];

const q = async (sql: string, params: unknown[] = []) => (await admin.query(sql, params)).rows;
const count = async (sql: string, params: unknown[] = []) => Number((await q(sql, params))[0].n);

function contextFor(userId: string): ImportContext {
  return { db: env.dbAs(userClaims(userId)), userId };
}

const fixture = (name: string) => {
  const checked = checkProcessFile(JSON.parse(readFileSync(new URL(`../../../../docs/import/examples/${name}.json`, import.meta.url), "utf8")));
  expect(checked.errors).toEqual([]);
  return checked.file!;
};

interface World {
  workspaceId: string;
  ctx: ImportContext;
  roles: Record<string, string>;
}

/** A company as it stands before the interviews: the roles, people, clients, services and lead sources the files talk about. */
async function company(slug: string, roles: string[], people: [string, number][], leadSources: [string, number][], clients: [string, number][] = [], services: string[] = []): Promise<World> {
  const workspaceId = (await q("insert into workspaces (name, slug) values ($1, $2 || '-' || substr(gen_random_uuid()::text, 1, 8)) returning id", [slug, slug.toLowerCase()]))[0].id;
  const roleIds: Record<string, string> = {};
  for (const r of roles) roleIds[r] = (await q("insert into roles (workspace_id, name) values ($1, $2) returning id", [workspaceId, r]))[0].id;
  for (const [name, fte] of people) await q("insert into people (workspace_id, name, fte) values ($1, $2, $3)", [workspaceId, name, fte]);
  for (const [name, volume] of leadSources) await q("insert into lead_sources (workspace_id, name, volume_week) values ($1, $2, $3)", [workspaceId, name, volume]);
  for (const [name, mrr] of clients) await q("insert into clients (workspace_id, name, mrr) values ($1, $2, $3)", [workspaceId, name, mrr]);
  for (const name of services) await q("insert into services (workspace_id, name, pricing_model, price) values ($1, $2, 'retainer', 1000)", [workspaceId, name]);
  madeWorkspaces.push(workspaceId);
  const editorId = randomUUID();
  madeUsers.push(editorId);
  await q("insert into auth.users (id, email) values ($1, $2)", [editorId, `skill-${randomUUID()}@example.com`]);
  await q("insert into memberships (workspace_id, user_id, role) values ($1, $2, 'owner')", [workspaceId, editorId]);
  const ctx = contextFor(editorId);
  return { workspaceId, ctx, roles: roleIds };
}

const companyCounts = async (ws: string) => ({
  people: await count("select count(*) n from people where workspace_id = $1", [ws]),
  roles: await count("select count(*) n from roles where workspace_id = $1", [ws]),
  clients: await count("select count(*) n from clients where workspace_id = $1", [ws]),
  services: await count("select count(*) n from services where workspace_id = $1", [ws]),
  leadSources: await count("select count(*) n from lead_sources where workspace_id = $1", [ws]),
  issues: await count("select count(*) n from issues where workspace_id = $1", [ws]),
  fteSum: Number((await q("select coalesce(sum(fte), 0) s from people where workspace_id = $1", [ws]))[0].s),
  mrrSum: Number((await q("select coalesce(sum(mrr), 0) s from clients where workspace_id = $1", [ws]))[0].s),
  volumeSum: Number((await q("select coalesce(sum(volume_week), 0) s from lead_sources where workspace_id = $1", [ws]))[0].s),
});

/** What an upload wrote beside the process, read back as an admin. */
async function written(w: World, processName: string, revisionId: string) {
  const proc = (await q("select * from processes where workspace_id = $1 and name = $2", [w.workspaceId, processName]))[0];
  const steps = Object.fromEntries((await q("select * from steps where revision_id = $1", [revisionId])).map((x) => [x.name, x]));
  const sources = await q("select s.id, s.title, s.kind, s.speakers, s.created_by from sources s where s.workspace_id = $1 order by s.title", [w.workspaceId]);
  const links = await q("select l.kind, l.source_id, l.step_id from source_links l where l.process_id = $1", [proc.id]);
  const issues = await q("select type, title from issues where workspace_id = $1 order by title", [w.workspaceId]);
  return { proc, steps, sources, links, issues };
}

type Cite = { source_id: string; speaker: string; value: number };
const cites = (list: Cite[]) => list.map((c) => [c.source_id, c.speaker, c.value]);

describe("uploading the process-file skill's fixtures", () => {
  beforeAll(async () => {
    env = await startTestDb();
    admin = env.t.client;
  });

  afterAll(async () => {
    await env?.close();
  });

  it("Tidewater: Monthly client report lands as a draft with its sources, evidence and first principles", async () => {
    const w = await company(
      "Tidewater",
      ["Account manager", "SEO specialist", "Director"],
      [["Hana Iqbal", 1], ["Owen Hart", 1], ["Priti Rao", 1], ["Callum Reid", 1]],
      [["Referrals", 2]],
      [["Marlow Physio", 2500]],
      ["SEO retainer", "Content add-on"],
    );
    const before = await companyCounts(w.workspaceId);
    const file = fixture("tidewater-monthly-client-report");

    // The preview says what each section would make and what is still missing, and writes nothing.
    const preview = await previewProcessFile(w.ctx, w.workspaceId, file);
    expect(preview.unknownRoles).toEqual([]);
    expect(preview.unknownPeople).toEqual([]);
    expect(preview.extras!.sources.map((s) => s.title)).toEqual(["Tidewater interview: Hana Iqbal, account manager", "Tidewater interview: Owen Hart, SEO specialist"]);
    expect(preview.extras!.firstPrinciplesParts).toBeGreaterThan(0);
    expect(preview.gap.gaps.map((g) => g.text)).toEqual(["Director review has no hands-on time", "No recurrence: link this process to a service and set how often it repeats in Settings"]);
    expect(await companyCounts(w.workspaceId)).toEqual(before);

    const r = await importProcessFile(w.ctx, file, { workspaceId: w.workspaceId, source: "tidewater-monthly-client-report.json" });
    expect(r).toMatchObject({ steps: 8, links: 8, bundle: { sources: 2, first_principles: true } });
    const x = await written(w, "Monthly client report", r.revision_id);
    expect(x.proc).toMatchObject({ live_revision_id: null, draft_revision_id: r.revision_id, source: "import", kind: "servicing" });

    // Step evidence names the real source ids and the speaker, and a disagreement is two quotes, not one number.
    const hana = x.sources.find((s) => s.title.includes("Hana"))!;
    const owen = x.sources.find((s) => s.title.includes("Owen"))!;
    expect(hana).toMatchObject({ kind: "transcript", speakers: ["Interviewer", "Hana Iqbal"], created_by: expect.any(String) });
    expect(cites(x.steps["Pull ranking data"].provenance.work_hours.evidence)).toEqual([
      [hana.id, "Hana Iqbal", 1],
      [owen.id, "Owen Hart", 3],
    ]);
    expect(cites(x.steps["Director review"].provenance.rework_rate.evidence)).toEqual([
      [hana.id, "Hana Iqbal", 0.2],
      [owen.id, "Owen Hart", 0.5],
    ]);
    expect(x.steps["Write commentary"]).toMatchObject({ work_dist: "triangular", work_params: { min: 2, mode: 2.5, max: 3 }, tool: "Google Docs" });
    expect(Number(x.steps["Write commentary"].current_wip)).toBe(4);
    expect(x.steps["Director review"].person_id).not.toBeNull();

    // Sources are linked to the process, so neither says "Not linked to anything yet".
    expect(x.links.filter((l) => l.kind === "process").map((l) => l.source_id).sort()).toEqual([hana.id, owen.id].sort());

    // Nothing company-level was touched; the two disagreements of 2x or more are logged as perception gaps.
    expect(await companyCounts(w.workspaceId)).toEqual({ ...before, issues: before.issues + 2 });
    expect(x.issues).toEqual([
      { type: "perception_gap", title: "Sources disagree on Director review: rework rate" },
      { type: "perception_gap", title: "Sources disagree on Pull ranking data: hands-on time" },
    ]);

    // First principles are on the draft: the requirement has an owner who is a person, and the measure is the stated promise.
    const fp = (await q("select * from first_principles where process_id = $1", [x.proc.id]))[0];
    expect(fp).toMatchObject({ revision_id: r.revision_id });
    expect(fp.measures[0]).toMatchObject({ kpi: "cycleHours", comparator: "atMost", target: 40 });
    expect(fp.requirements[0].owner_person_id).not.toBeNull();
  });

  it("Copperleaf: Enquiry to signed client lands as a draft, and what is missing is marked as missing", async () => {
    const w = await company(
      "Copperleaf",
      ["Managing director", "Account director", "Paid media specialist", "Finance"],
      [["Grace Adeyemi", 1], ["Tom Whitfield", 1], ["Ellie Marsh", 1], ["Kofi Mensah", 1], ["Nadia Sharp", 1]],
      [["Website enquiries", 6], ["Referrals", 1]],
      [["Ashgrove Garden Centre", 3000], ["Brambleway Farm Shop", 1800], ["Corran Physio", 2500]],
      ["PPC management", "Paid social"],
    );
    const before = await companyCounts(w.workspaceId);
    const file = fixture("copperleaf-enquiry-to-signed-client");

    const preview = await previewProcessFile(w.ctx, w.workspaceId, file);
    expect(preview.unknownRoles).toEqual(["Designer"]);
    expect(preview.unknownPeople).toEqual([]);
    expect(preview.gap.gaps.map((g) => g.text)).toEqual(["Pitch deck has no role", "Send contract has no hands-on time"]);
    expect(preview.extras!.firstPrinciplesParts).toBeGreaterThan(0);
    expect(await companyCounts(w.workspaceId)).toEqual(before);

    const r = await importProcessFile(w.ctx, file, { workspaceId: w.workspaceId, source: "copperleaf-enquiry-to-signed-client.json" });
    expect(r).toMatchObject({ steps: 15, links: 14, bundle: { sources: 2, first_principles: true } });
    expect(r.warnings).toContain("One step has no role: the file's role isn't one of your roles and wasn't mapped to one.");
    const x = await written(w, "Enquiry to signed client", r.revision_id);
    expect(x.proc).toMatchObject({ live_revision_id: null, draft_revision_id: r.revision_id, source: "import", kind: "pipeline" });
    const grace = x.sources.find((s) => s.title.includes("Grace"))!;
    const tom = x.sources.find((s) => s.title.includes("Tom"))!;

    // The step numbers the interviews gave, as stored, and the ones nobody gave left for the gap warning.
    const s = x.steps;
    expect(s["Wait for a diary slot"]).toMatchObject({ wait_dist: "triangular", wait_params: { min: 15, mode: 18.75, max: 22.5 } });
    expect(Number(s["Wait for a diary slot"].wait_hours)).toBe(18.75);
    // The quote states 75, which differs from the range middle, so the stored wait is the stated ceiling as a plain value.
    expect(Number(s["Client considers proposal"].wait_hours)).toBe(75);    expect(Number(s["Pricing sign-off"].work_hours)).toBe(0.33);
    expect(Number(s["Send contract"].current_wip)).toBe(3);
    expect(cites(s["Send contract"].provenance.wait_hours.evidence)).toEqual([
      [grace.id, "Grace Adeyemi", 15],
      [tom.id, "Tom Whitfield", 7.5],
    ]);
    expect(Number(s["Write proposal"].sla_hours)).toBe(37.5);
    expect(Number(s["Write proposal"].current_wip)).toBe(5);
    expect(cites(s["Write proposal"].provenance.work_hours.evidence)).toEqual([
      [grace.id, "Grace Adeyemi", 2.5],
      [tom.id, "Tom Whitfield", 11.25],
    ]);
    expect(s["Audit ad accounts"].provenance.work_hours).toMatchObject({ assumption: true, note: expect.stringContaining("interviewer proposed four hours") });
    expect(s["Send contract"].provenance.work_hours?.note ?? "").toMatch(/^Server default for a/);
    expect(Number(s["First look at enquiry"].work_hours)).toBe(0.25);
    expect(s["First look at enquiry"].provenance.work_hours).toMatchObject({ assumption: true });
    expect(s["Pitch deck"].role_id).toBeNull();
    expect(s["Pricing sign-off"]).toMatchObject({ role_id: w.roles["Account director"] });
    expect(s["Pricing sign-off"].person_id).not.toBeNull();

    // The odds: each speaker's quote is kept, and the middle of the two is used for the branches (they still add to 1).
    const edges = await q(
      "select e.probability::float8 p, a.name f, b.name t from edges e join steps a on a.id = e.from_step_id and a.revision_id = e.revision_id join steps b on b.id = e.to_step_id and b.revision_id = e.revision_id where e.revision_id = $1 and a.name in ('First look at enquiry', 'Client decides')",
      [r.revision_id],
    );
    expect(Object.fromEntries(edges.map((e) => [`${e.f} > ${e.t}`, e.p]))).toEqual({
      "First look at enquiry > Not a fit": 0.33,
      "First look at enquiry > Wait for a diary slot": 0.67,
      "Client decides > Send contract": 0.415,
      "Client decides > Lost": 0.585,
    });
    expect(s["Client decides"].provenance.branch_odds).toBeUndefined();
    // The withdrawn audit-skip share left no decision in the draft.
    expect(s["Already spending on ads?"]).toBeUndefined();

    // Sources linked to the process; nothing company-level touched; conflicts of 2x or more logged as perception gaps.
    expect(x.links.filter((l) => l.kind === "process").map((l) => l.source_id).sort()).toEqual([grace.id, tom.id].sort());
    expect(await companyCounts(w.workspaceId)).toEqual({ ...before, issues: before.issues + 4 });
    expect(x.issues.map((i) => i.type)).toEqual(["perception_gap", "perception_gap", "perception_gap", "perception_gap"]);

    // First principles: only the two rules a speaker stated.
    const fp = (await q("select * from first_principles where process_id = $1", [x.proc.id]))[0];
    expect(fp.requirements).toHaveLength(2);
    expect(fp.requirements[0]).toMatchObject({ step_id: s["Pricing sign-off"].id });
    expect(fp.requirements[0].owner_person_id).not.toBeNull();
    expect(fp.measures).toEqual([]);
  });
});
