import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateApiToken, type McpHandlerOptions } from "../src";
import { call, connect, signJwt } from "./helpers";

// End to end for the process-building tools (issue #24), as in production:
// MCP client → handleMcpRequest → supabase-js → PostgREST with the
// pre-request hook → Postgres with every migration and RLS. Runs against the
// database postgrest-db.ts prepares (see postgrest.test.ts), in a workspace
// of its own so it can run beside that suite. Skipped unless POSTGREST_URL is set.

const POSTGREST_URL = process.env.POSTGREST_URL;
const JWT_SECRET = process.env.POSTGREST_JWT_SECRET ?? "";
const ADMIN_URL = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/postgres";
const DATABASE_NAME = process.env.POSTGREST_DATABASE ?? "transpera_flow_postgrest";
const SUPABASE_URL = "https://project.supabase.test";

let admin: pg.Client;
let options: McpHandlerOptions;
let workspaceId: string;
let editorId: string;
let editorToken: string;
let viewerToken: string;
let strangerToken: string;
let consultantRoleId: string;
/** The processes `onPublished` (the web app starts AI analysis there, A46) was told about. */
const publishedIds: string[] = [];

const toPostgrest: typeof fetch = (input, init) => {
  if (input instanceof Request) throw new Error("expected supabase-js to pass a URL string");
  return fetch(String(input).replace(`${SUPABASE_URL}/rest/v1`, POSTGREST_URL!), init);
};

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

type Row = Record<string, unknown>;

/** A revision's steps and edges as stored, for "live is unchanged" checks. */
async function snapshot(revisionId: string) {
  const steps = (await admin.query("select * from steps where revision_id = $1 order by id", [revisionId])).rows as Row[];
  const edges = (await admin.query("select * from edges where revision_id = $1 order by id", [revisionId])).rows as Row[];
  return { steps, edges };
}

async function processRow(name: string) {
  return (await admin.query("select * from processes where workspace_id = $1 and name = $2", [workspaceId, name])).rows[0] as Row & {
    id: string;
    live_revision_id: string | null;
    draft_revision_id: string | null;
    source: string;
  };
}

async function stepsOf(revisionId: string) {
  return (await admin.query("select * from steps where revision_id = $1", [revisionId])).rows as (Row & {
    id: string;
    name: string;
    provenance: Record<string, Row>;
  })[];
}

describe.skipIf(!POSTGREST_URL)("MCP process building over PostgREST (drafts only, as the user)", () => {
  beforeAll(async () => {
    const url = new URL(ADMIN_URL);
    url.pathname = `/${DATABASE_NAME}`;
    admin = new pg.Client({ connectionString: url.toString() });
    await admin.connect();

    workspaceId = (await admin.query("insert into workspaces (name, slug) values ('Build Co', 'build-co') returning id")).rows[0].id;
    consultantRoleId = (await admin.query("insert into roles (workspace_id, name) values ($1, 'Consultant') returning id", [workspaceId])).rows[0].id;
    await admin.query("insert into roles (workspace_id, name) values ($1, 'Account manager')", [workspaceId]);
    editorId = await createUser("builder-editor@example.com");
    const viewerId = await createUser("builder-viewer@example.com");
    const strangerId = await createUser("builder-stranger@example.com");
    await admin.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, 'editor'), ($1, $3, 'viewer')", [workspaceId, editorId, viewerId]);
    const otherId = (await admin.query("insert into workspaces (name, slug) values ('Elsewhere', 'elsewhere') returning id")).rows[0].id;
    await admin.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, 'owner')", [otherId, strangerId]);
    editorToken = await issueToken(editorId);
    viewerToken = await issueToken(viewerId);
    strangerToken = await issueToken(strangerId);

    options = { supabaseUrl: SUPABASE_URL, supabaseKey: signJwt({ role: "anon", iss: "test" }, JWT_SECRET), fetch: toPostgrest, onPublished: (_db, processId) => void publishedIds.push(processId) };

    const deadline = Date.now() + 60_000;
    for (;;) {
      const res = await fetch(`${POSTGREST_URL}/workspaces?select=id`, {
        headers: { authorization: `Bearer ${options.supabaseKey}`, "x-api-token": editorToken },
      }).catch(() => null);
      if (res?.status === 200 && ((await res.json()) as unknown[]).length === 1) break;
      if (Date.now() > deadline) throw new Error("PostgREST never became ready");
      await new Promise((r) => setTimeout(r, 1000));
    }
  });

  afterAll(async () => {
    await admin?.end();
  });

  let sourceA: string;
  let sourceB: string;

  it("builds a new process from transcripts into a draft, and publishes only when estimates are settled or accepted", async () => {
    const editor = await connect(editorToken, options);
    const a = await call<{ source: { id: string } }>(editor, "add_source", {
      title: "Discovery interview",
      speakers: "Ana Ruiz, Ben Cole",
      link_later: true,
      recorded_at: "2026-10-01",
      body: "[00:02:10] Ana Ruiz: A discovery call is an hour and a half with notes...",
    });
    expect(a.ok).toBe(true);
    expect(a.assumptions).toContain("kind defaulted to transcript.");
    sourceA = a.data.source.id;
    const b = await call<{ source: { id: string } }>(editor, "add_source", { title: "Ops notes", kind: "notes", speakers: ["Ben Cole"], link_later: true });
    sourceB = b.data.source.id;
    const data = await call<{ source: { id: string; kind: string } }>(editor, "add_source", { title: "HubSpot export", kind: "data", link_later: true });
    expect(data.ok, JSON.stringify(data)).toBe(true);
    expect(data.data.source.kind).toBe("data");

    const r = await call<{
      created: boolean;
      process: { id: string };
      matched: { name: string; id: string; by: string }[];
      diff: { steps: { added: { name: string }[] }; text: string };
      conflicts: { field: string; step: string }[];
      checklist: { kind: string; step: { name: string }; field: string }[];
      text: string;
    }>(editor, "import_process", {
      process_json: {
        name: "Sales pipeline",
        kind: "pipeline",
        entity_name: "lead",
        steps: [
          { name: "Enquiry", kind: "start" },
          {
            name: "Discovery",
            role: "consultant",
            work_hours: 1.5,
            wait_hours: 24,
            rework_rate: 0,
            evidence: [{ field: "work_hours", source: sourceA, speaker: "Ana Ruiz", quote: "an hour and a half with notes", timestamp: "00:02:10", value: 1.5 }],
            assumptions: [{ field: "wait_hours", reasoning: "Calls are usually booked the next day." }],
          },
          {
            name: "Proposal",
            role: "Consultant",
            evidence: [
              { field: "work_hours", source: "Discovery interview", speaker: "Ana Ruiz", quote: "four hours for a proposal", value: 4 },
              { field: "work_hours", source: sourceB, speaker: "Ben Cole", quote: "proposals take a day", value: 8 },
            ],
          },
          { name: "Client decision", kind: "decision" },
          { name: "Won", kind: "end", outcome: "won" },
          { name: "Lost", kind: "end", outcome: "lost" },
        ],
        edges: [
          { from: "Enquiry", to: "Discovery" },
          { from: "Discovery", to: "Proposal" },
          { from: "Proposal", to: "Client decision" },
          { from: "Client decision", to: "Won", probability: 0.4 },
          { from: "Client decision", to: "Lost" },
        ],
      },
    });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(r.data.created).toBe(true);
    expect(r.data.diff.steps.added).toHaveLength(6);
    // The sources the new steps cite are linked to those steps by the database (A53), so none is flagged "Not linked" beside "Cited by".
    const linked = await admin.query("select source_id, kind, step_id from source_links where source_id = any($1::uuid[]) order by kind", [[sourceA, sourceB]]);
    expect(new Set(linked.rows.map((l) => l.source_id))).toEqual(new Set([sourceA, sourceB]));
    expect(linked.rows.every((l) => l.kind === "step" && l.step_id)).toBe(true);
    expect(r.data.diff.text).toMatch(/^New process: 6 steps added/);
    expect(r.data.conflicts).toEqual([expect.objectContaining({ step: "Proposal", field: "work_hours" })]);
    // Conflicts first, then assumptions, as the canvas's checklist rail lists them.
    expect(r.data.checklist[0]).toMatchObject({ kind: "conflict", step: { name: "Proposal" }, field: "work_hours" });
    expect(r.data.checklist.filter((i) => i.kind === "assumption").map((i) => `${i.step.name}.${i.field}`)).toEqual(
      expect.arrayContaining(["Discovery.wait_hours", "Proposal.wait_hours", "Proposal.rework_rate", "Discovery.rework_rate"]),
    );
    expect(r.assumptions).toEqual(
      expect.arrayContaining([
        "Step 'Proposal': wait_hours defaulted to 0 h (estimated; confirm it on the canvas).",
        "'Client decision': one branch's probability defaulted to 60% (the share the others leave).",
      ]),
    );

    const proc = await processRow("Sales pipeline");
    expect(proc).toMatchObject({ source: "import", live_revision_id: null });
    const unpublished = await call<{ revision: { status: string }; steps: unknown[] }>(editor, "get_process", { process: "Sales pipeline" });
    expect(unpublished).toMatchObject({ ok: true, data: { revision: { status: "draft" } } });
    expect(unpublished.assumptions).toContain("revision defaulted to draft: the process hasn't been published yet.");
    const steps = await stepsOf(proc.draft_revision_id!);
    const discovery = steps.find((s) => s.name === "Discovery")!;
    expect(discovery).toMatchObject({ role_id: consultantRoleId, created_by: editorId, assumption: true });
    expect(discovery.provenance.work_hours).toMatchObject({
      source: "estimated",
      by: editorId,
      evidence: [{ source_id: sourceA, speaker: "Ana Ruiz", quote: "an hour and a half with notes", timestamp: "00:02:10", value: 1.5 }],
    });
    expect(discovery.provenance.wait_hours).toMatchObject({ assumption: true, note: "Calls are usually booked the next day." });
    const proposal = steps.find((s) => s.name === "Proposal")!;
    expect(proposal).toMatchObject({ conflict: true, work_dist: "triangular", work_params: { min: 4, mode: 6, max: 8 } });
    // 8 h vs 4 h is 2× apart: the database logs a perception gap.
    const gap = await admin.query("select title, source from issues where workspace_id = $1 and type = 'perception_gap'", [workspaceId]);
    expect(gap.rows).toEqual([{ title: "Sources disagree on Proposal: hands-on time", source: "promoted" }]);

    // Publishing is refused while estimates are open, listing them; nothing goes live.
    const refused = await call(editor, "publish_process", { process: "Sales pipeline" });
    expect(refused).toMatchObject({ ok: false, error: { code: "unresolved" } });
    expect((refused.error as unknown as { candidates: { kind: string }[] }).candidates[0]).toMatchObject({ kind: "conflict" });
    expect((await processRow("Sales pipeline")).live_revision_id).toBeNull();

    const published = await call<{ revision: { number: number }; accepted_estimates: boolean; text: string }>(editor, "publish_process", {
      process: "sales",
      accept_estimates: true,
    });
    expect(published).toMatchObject({ ok: true, data: { revision: { number: 1 }, accepted_estimates: true } });
    expect(publishedIds, "the publish that went live told the hook").toContain(proc.id);
    expect(published.data.text).toMatch(/^Published 'Sales pipeline' as revision 1 \(6 steps added, 0 removed, 0 changed\), accepting \d+ steps with estimates\./);
    const audit = await admin.query("select actor_id, actor_kind, diff from audit_log where action = 'publish' and target_id = $1", [proc.id]);
    expect(audit.rows).toEqual([expect.objectContaining({ actor_id: editorId, actor_kind: "mcp", diff: expect.objectContaining({ accept_estimates: true }) })]);
    await editor.close();
  });

  it("import_process with a target writes into the draft, keeps stable ids, returns the diff, and never overwrites an entered value", async () => {
    const proc = await processRow("Sales pipeline");
    const liveId = proc.live_revision_id!;
    // Someone confirmed Discovery's hands-on time on the canvas before this was published (entered).
    await admin.query(
      `update steps set work_hours = 2, provenance = jsonb_set(provenance, '{work_hours}', '{"source":"entered","at":"2026-10-02T09:00:00Z"}')
       where revision_id = $1 and name = 'Discovery'`,
      [liveId],
    );
    const liveBefore = await snapshot(liveId);
    const liveIds = liveBefore.steps.map((s) => s.id);

    const editor = await connect(editorToken, options);
    // A step naming a role that doesn't exist is refused before anything is written: no draft is opened.
    expect(proc.draft_revision_id).toBeNull();
    const refused = await call(editor, "import_process", { target: "Sales pipeline", process_json: { steps: [{ name: "Discovery", role: "Astronaut" }] } });
    expect(refused).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect((await processRow("Sales pipeline")).draft_revision_id).toBeNull();
    const r = await call<{
      created: boolean;
      draft: { revision_id: string; opened_now: boolean };
      matched: { name: string; id: string; by: string }[];
      diff: {
        steps: { added: { name: string }[]; removed: unknown[]; changed: { name: string; fields: Record<string, unknown> }[] };
        edges: { added: { from: string; to: string }[]; removed: { from: string; to: string }[] };
        text: string;
      };
      not_overwritten: { step: string; field: string; kept: number; proposed: number }[];
      conflicts: { step: string; field: string; values: { value: number; speaker: string | null }[] }[];
    }>(editor, "import_process", {
      target: "Sales pipeline",
      process_json: {
        name: "Renamed pipeline",
        steps: [
          { name: "discovery", work_hours: 3, evidence: [{ field: "work_hours", source: sourceB, speaker: "Ben Cole", quote: "discovery is more like three hours", value: 3 }] },
          { name: "Negotiation", role: "Consultant", work_hours: 2, evidence: [{ field: "work_hours", source: sourceB, speaker: "Ben Cole", quote: "two hours of back and forth", value: 2 }] },
        ],
        edges: [
          { from: "Client decision", to: "Negotiation", probability: 0.45 },
          { from: "Client decision", to: "Lost", probability: 0.55 },
          { from: "Negotiation", to: "Won" },
        ],
      },
    });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(r.assumptions).toEqual(expect.arrayContaining(["process_json's name was ignored: they belong to the process, not its draft."]));
    expect(r.data).toMatchObject({ created: false, draft: { opened_now: true } });
    const discoveryId = liveBefore.steps.find((s) => s.name === "Discovery")!.id;
    expect(r.data.matched).toEqual([
      { name: "discovery", id: discoveryId, by: "name" },
      { name: "Negotiation", id: expect.any(String), by: "new" },
    ]);
    // Entered 2 h is kept; Ben's 3 h is flagged as a conflict with its source.
    expect(r.data.not_overwritten).toEqual([expect.objectContaining({ step: "Discovery", field: "work_hours", kept: 2, proposed: 3 })]);
    expect(r.data.conflicts).toEqual([
      expect.objectContaining({ step: "Discovery", field: "work_hours", values: [expect.objectContaining({ value: 2, speaker: null }), expect.objectContaining({ value: 3, speaker: "Ben Cole" })] }),
    ]);
    expect(r.data.diff.steps.added.map((s) => s.name)).toEqual(["Negotiation"]);
    expect(r.data.diff.steps.removed).toEqual([]);
    expect(r.data.diff.steps.changed).toEqual([
      expect.objectContaining({ name: "Discovery", fields: expect.objectContaining({ conflict: { live: false, draft: true } }) }),
    ]);
    expect(r.data.diff.steps.changed[0]!.fields).not.toHaveProperty("work_hours");
    expect(r.data.diff.edges.added).toEqual(
      expect.arrayContaining([expect.objectContaining({ from: "Client decision", to: "Negotiation" }), expect.objectContaining({ from: "Negotiation", to: "Won" })]),
    );
    expect(r.data.diff.edges.removed).toEqual([expect.objectContaining({ from: "Client decision", to: "Won" })]);

    // Stable ids: every live step is in the draft under the same id; live is untouched.
    const draftSteps = await stepsOf(r.data.draft.revision_id);
    expect(draftSteps.map((s) => s.id)).toEqual(expect.arrayContaining(liveIds));
    expect(draftSteps.find((s) => s.id === discoveryId)).toMatchObject({ work_hours: "2", conflict: true });
    expect(await snapshot(liveId)).toEqual(liveBefore);
    expect((await processRow("Sales pipeline")).name).toBe("Sales pipeline");

    // A second import of the same interview is idempotent: nothing new to write.
    const again = await call<{ diff: { steps: { added: unknown[] } }; not_overwritten: unknown[] }>(editor, "import_process", {
      target: proc.id,
      process_json: { steps: [{ name: "Negotiation", work_hours: 2 }], edges: [] },
    });
    expect(again.ok).toBe(true);
    expect(again.data.not_overwritten).toEqual([]);
    expect((await stepsOf(r.data.draft.revision_id)).length).toBe(draftSteps.length);
    await editor.close();
  });

  it("step tools write only into the draft, resolve names, and return candidates for an ambiguous one", async () => {
    const proc = await processRow("Sales pipeline");
    const liveBefore = await snapshot(proc.live_revision_id!);
    const editor = await connect(editorToken, options);

    const added = await call<{ step: { id: string; assumption: boolean }; edges: { id: string; from: { name: string }; to: { name: string } }[]; text: string }>(
      editor,
      "add_step",
      { process: "Sales pipeline", name: "Contract review", after: "Negotiation", work_hours: 1 },
    );
    expect(added.ok, JSON.stringify(added)).toBe(true);
    expect(added.data.step.assumption).toBe(true);
    expect(added.data.edges.map((e) => `${e.from.name}→${e.to.name}`).sort()).toEqual(["Contract review→Won", "Negotiation→Contract review"]);
    expect(added.assumptions).toEqual(
      expect.arrayContaining([
        "Step 'Contract review': work_hours 1 h has no cited source; marked as an assumption.",
        "Step 'Contract review': wait_hours defaulted to 0 h (estimated; confirm it on the canvas).",
      ]),
    );
    expect(added.data.text).toMatch(/^Added 'Contract review' to the draft of 'Sales pipeline' after 'Negotiation'\. 3 values are assumptions to confirm\./);

    expect(await call(editor, "add_step", { process: "Sales pipeline", name: "Proposal review", before: "Client decision" })).toMatchObject({ ok: true });
    const ambiguous = await call(editor, "update_step", { process: "Sales pipeline", step: "review", work_hours: 5 });
    expect(ambiguous).toMatchObject({ ok: false, error: { code: "ambiguous" } });
    expect((ambiguous.error as unknown as { candidates: { name: string }[] }).candidates.map((c) => c.name).sort()).toEqual(["Contract review", "Proposal review"]);

    const updated = await call<{ changes: Record<string, unknown>; step: { work_hours: number; tool: string } }>(editor, "update_step", {
      step: "contract rev",
      work_hours: 1.5,
      tool: "DocuSign",
      assumptions: [{ field: "work_hours", reasoning: "Legal reads it once." }],
    });
    expect(updated.ok, JSON.stringify(updated)).toBe(true);
    expect(updated.data.step).toMatchObject({ work_hours: 1.5, tool: "DocuSign" });

    // Branches must add up: set_routing refuses otherwise, and keeps ids of branches that stay.
    expect(await call(editor, "set_routing", { step: "Contract review", routes: [{ to: "Won", probability: 0.9 }, { to: "Lost", probability: 0.2 }] })).toMatchObject({
      ok: false,
      error: { code: "invalid_input" },
    });
    const routed = await call<{ routes: { id: string; to: { name: string }; probability: number }[] }>(editor, "set_routing", {
      step: "Contract review",
      routes: [
        { to: "Won", probability: 0.9 },
        { to: "Lost", probability: 0.1 },
      ],
    });
    expect(routed.ok, JSON.stringify(routed)).toBe(true);
    expect(routed.data.routes.find((x) => x.to.name === "Won")!.id).toBe(added.data.edges.find((x) => x.to.name === "Won")!.id);
    expect(await call(editor, "connect_steps", { from: "Won", to: "Lost" })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(await call(editor, "connect_steps", { from: "Contract review", to: "Won" })).toMatchObject({ ok: false, error: { code: "invalid_input" } });

    const removed = await call<{ rerouted_edges: { from: { name: string }; to: { name: string } }[] }>(editor, "remove_step", {
      step: "Proposal review",
      reconnect: true,
    });
    expect(removed.ok, JSON.stringify(removed)).toBe(true);
    expect(removed.data.rerouted_edges.map((e) => `${e.from.name}→${e.to.name}`)).toEqual(["Proposal→Client decision"]);

    // Split-style removal keeps a retired row under the same id.
    await call(editor, "add_step", { name: "Legal check", after: "Contract review", before: "Won", work_hours: 0.5 });
    const legal = (await stepsOf(proc.draft_revision_id!)).find((s) => s.name === "Legal check")!;
    const retired = await call(editor, "remove_step", { step: legal.id, replaced_by: ["Contract review"] });
    expect(retired.ok, JSON.stringify(retired)).toBe(true);
    const row = (await stepsOf(proc.draft_revision_id!)).find((s) => s.id === legal.id)!;
    expect(row.replaced_by).toHaveLength(1);

    // The draft never reached live.
    expect(await snapshot(proc.live_revision_id!)).toEqual(liveBefore);
    const draft = await call<{ steps: { name: string }[] }>(editor, "get_process", { process: "Sales pipeline", revision: "draft" });
    expect(draft.data.steps.map((s) => s.name)).toContain("Contract review");
    expect(draft.data.steps.map((s) => s.name)).not.toContain("Legal check");
    await editor.close();
  });

  it("add_source needs links (or link_later), resolves them by name, and link_source adds more", async () => {
    const editor = await connect(editorToken, options);
    const issueNumber = (await admin.query("insert into issues (workspace_id, type, title) values ($1, 'manual', 'Slow proposals') returning number", [workspaceId])).rows[0].number as number;
    const sourcesBefore = Number((await admin.query("select count(*) from sources where workspace_id = $1", [workspaceId])).rows[0].count);

    // No links: refused with the way out, and nothing is added.
    const none = await call(editor, "add_source", { title: "No links" });
    expect(none).toMatchObject({ ok: false, error: { code: "links_required" } });
    expect(JSON.stringify(none)).toMatch(/link_later: true/);
    expect(await call(editor, "add_source", { title: "Empty", links: [] })).toMatchObject({ ok: false, error: { code: "links_required" } });
    expect(await call(editor, "add_source", { title: "Both", links: [{ process: "Sales pipeline" }], link_later: true })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    // A link that names nothing, two things, or something that isn't there: refused before anything is written.
    expect(await call(editor, "add_source", { title: "Bad", links: [{}] })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(await call(editor, "add_source", { title: "Bad", links: [{ step: "Discovery", issue: 1 }] })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(await call(editor, "add_source", { title: "Bad", links: [{ step: "No such step" }] })).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(await call(editor, "add_source", { title: "Bad", links: [{ insight: "not a key" }] })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(Number((await admin.query("select count(*) from sources where workspace_id = $1", [workspaceId])).rows[0].count)).toBe(sourcesBefore);

    // Linked by name and number; the same thing named twice is one link.
    const ok = await call<{ source: { id: string }; links: string[]; text: string }>(editor, "add_source", {
      title: "Ops walkthrough",
      kind: "notes",
      links: [{ process: "Sales pipeline" }, { step: "Discovery" }, { issue: issueNumber }, { step: "Discovery", process: "Sales pipeline" }],
    });
    expect(ok.ok, JSON.stringify(ok)).toBe(true);
    expect(ok.data.links).toEqual(["Process: Sales pipeline", "Step: Discovery", `Issue #${issueNumber}`]);
    const made = await admin.query("select kind from source_links where source_id = $1 order by kind", [ok.data.source.id]);
    expect(made.rows.map((r) => r.kind)).toEqual(["issue", "process", "step"]);
    // The issue's own list of sources records it too, so its history says "linked a source".
    const listed = await admin.query("select count(*)::int as n from issue_sources s join issues i on i.id = s.issue_id where s.source_id = $1 and i.number = $2 and i.workspace_id = $3", [ok.data.source.id, issueNumber, workspaceId]);
    expect(listed.rows[0].n).toBe(1);

    // link_source adds more, and says what was already there.
    const more = await call<{ added: string[]; already_linked: string[] }>(editor, "link_source", {
      source: "Ops walkthrough",
      links: [{ step: "Proposal" }, { process: "Sales pipeline" }, { insight: `spof:step:${randomUUID()}` }],
    });
    expect(more.ok, JSON.stringify(more)).toBe(true);
    expect(more.data.already_linked).toEqual(["Process: Sales pipeline"]);
    expect(more.data.added).toHaveLength(2);
    // link_source to an issue does the same.
    const second = await call<{ added: string[] }>(editor, "link_source", { source: "Ops notes", links: [{ issue: issueNumber }] });
    expect(second.ok, JSON.stringify(second)).toBe(true);
    const listed2 = await admin.query("select count(*)::int as n from issue_sources s join issues i on i.id = s.issue_id join sources o on o.id = s.source_id where o.title = 'Ops notes' and i.number = $1 and i.workspace_id = $2", [issueNumber, workspaceId]);
    expect(listed2.rows[0].n).toBe(1);
    // An empty list is refused by the tool's input schema (at least one link), before the tool runs: the client gets a protocol error, not a result.
    const empty = await editor.callTool({ name: "link_source", arguments: { source: "Ops walkthrough", links: [] } }).catch((e: Error) => e);
    expect(empty instanceof Error ? empty.message : JSON.stringify(empty)).toMatch(/at least 1|too_small|Too small/i);
    expect(await call(editor, "link_source", { source: "No such source", links: [{ process: "Sales pipeline" }] })).toMatchObject({ ok: false, error: { code: "not_found" } });

    // link_later leaves it unlinked until something cites it.
    const later = await call<{ source: { id: string }; links: string[] }>(editor, "add_source", { title: "Cited later", link_later: true });
    expect(later.ok).toBe(true);
    expect(later.assumptions.join(" ")).toMatch(/not linked to anything yet/);
    expect((await admin.query("select count(*)::int as n from source_links where source_id = $1", [later.data.source.id])).rows[0].n).toBe(0);
    await editor.close();
  });

  it("viewers can't build and strangers can't see the workspace", async () => {
    const proc = await processRow("Sales pipeline");
    const before = await snapshot(proc.draft_revision_id!);
    const viewer = await connect(viewerToken, options);
    for (const [tool, args] of [
      ["add_source", { title: "Mine", link_later: true }],
      ["link_source", { source: sourceA, links: [{ process: "Sales pipeline" }] }],
      ["create_process", { name: "Viewer's" }],
      ["add_step", { process: "Sales pipeline", name: "Sneaky" }],
      ["update_step", { process: "Sales pipeline", step: "Discovery", work_hours: 9 }],
      ["remove_step", { process: "Sales pipeline", step: "Discovery" }],
      ["connect_steps", { process: "Sales pipeline", from: "Discovery", to: "Lost" }],
      ["set_routing", { process: "Sales pipeline", step: "Discovery", routes: [{ to: "Lost", probability: 1 }] }],
      ["import_process", { target: "Sales pipeline", process_json: { steps: [{ name: "Sneaky" }] } }],
      ["publish_process", { process: "Sales pipeline", accept_estimates: true }],
      ["discard_draft", { process: "Sales pipeline" }],
      ["create_from_template", { template: "client onboarding" }],
    ] as const) {
      expect(await call(viewer, tool, args), tool).toMatchObject({ ok: false, error: { code: "forbidden" } });
    }
    await viewer.close();
    expect(await snapshot(proc.draft_revision_id!)).toEqual(before);

    const stranger = await connect(strangerToken, options);
    for (const [tool, args] of [
      ["add_step", { workspace: "build-co", process: "Sales pipeline", name: "x" }],
      ["import_process", { workspace: workspaceId, process_json: { name: "x", steps: [] } }],
      ["publish_process", { workspace: "Build Co" }],
    ] as const) {
      expect(await call(stranger, tool, args), tool).toMatchObject({ ok: false, error: { code: "not_found" } });
    }
    await stranger.close();
  });

  it("creates from a template into a draft, and discards it", async () => {
    const editor = await connect(editorToken, options);
    const list = await call<{ templates: { id: string; name: string }[] }>(editor, "list_templates");
    expect(list.data.templates.map((t) => t.id)).toEqual(["agency-sales-pipeline", "client-onboarding", "monthly-reporting"]);
    const made = await call<{ checklist: unknown[]; steps: { kind: string; assumption: boolean }[] }>(editor, "create_from_template", {
      template: "onboarding",
      name: "Onboarding",
    });
    expect(made.ok, JSON.stringify(made)).toBe(true);
    expect(made.data.steps.filter((s) => s.kind === "task").every((s) => s.assumption)).toBe(true);
    expect(made.data.checklist.length).toBeGreaterThan(0);
    expect(await processRow("Onboarding")).toMatchObject({ source: "template", live_revision_id: null });
    expect(await call(editor, "create_from_template", { template: "onboarding", name: "onboarding" })).toMatchObject({ ok: false, error: { code: "name_taken" } });
    const discarded = await call<{ text: string }>(editor, "discard_draft", { process: "Onboarding" });
    expect(discarded).toMatchObject({ ok: true });
    expect(await processRow("Onboarding")).toMatchObject({ draft_revision_id: null });
    expect(await call(editor, "publish_process", { process: "Onboarding" })).toMatchObject({ ok: false, error: { code: "no_draft" } });

    const created = await call<{ steps: { name: string }[] }>(editor, "create_process", { name: "Reporting", kind: "servicing" });
    expect(created.ok, JSON.stringify(created)).toBe(true);
    expect(created.data.steps.map((s) => s.name).sort()).toEqual(["Done", "Start"]);
    await editor.close();
  });

  it("audit-logs every MCP write with actor_kind mcp", async () => {
    const rows = (
      await admin.query("select actor_id, actor_kind, action, target_table, target_id from audit_log where workspace_id = $1 order by created_at", [workspaceId])
    ).rows as { actor_id: string; actor_kind: string; action: string; target_table: string; target_id: string }[];
    const companyId = (await admin.query("select id from processes where workspace_id = $1 and is_company", [workspaceId])).rows[0]!.id as string;
    const mcp = rows.filter((r) => r.actor_kind === "mcp");
    expect(mcp.length).toBeGreaterThan(0);
    expect(mcp.every((r) => r.actor_id === editorId)).toBe(true);
    const seen = new Set(mcp.map((r) => `${r.action} ${r.target_table}`));
    for (const kind of [
      "insert sources",
      "insert processes",
      "open_draft processes",
      "insert steps",
      "update steps",
      "delete steps",
      "insert edges",
      "update edges",
      "delete edges",
      "publish processes",
      "discard_draft processes",
    ]) {
      expect(seen, kind).toContain(kind);
    }
    // Only the test's own setup (as the database owner) is logged as anything else, and the company map's versions the system
    // makes when a process is created (B11: "Added <process>", a published version of its own, by the system).
    const systemMapVersion = (r: { actor_kind: string; action: string; target_id: string }) => r.actor_kind === "system" && r.action === "publish" && r.target_id === companyId;
    expect(rows.filter((r) => r.actor_kind !== "mcp" && !systemMapVersion(r)).every((r) => r.target_table === "memberships")).toBe(true);
    expect(rows.filter(systemMapVersion).length).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // Processes inside processes (issue #102). These run after the audit-log
  // test above, which expects the test's own setup to be the only writes that
  // aren't MCP's; they set workspace numbers the simulations need.
  // -------------------------------------------------------------------------

  const sid = (n: number) => `70000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const SIM = { reps: 4, seed: 7, start_date: "2026-11-02", revision: "live" } as const;

  type Outcome = {
    created: boolean;
    process: { id: string; name: string };
    matched: { name: string; id: string; by: string }[];
    diff: { text: string; steps: { added: { name: string }[]; changed: unknown[] } };
    warnings: string[];
    children: (Outcome & { step: string })[];
    text: string;
  };
  type Run = Record<string, unknown>;

  /** A run's numbers, without what names a process. */
  const numbers = (r: Run) => {
    const { process: _p, revision: _r, duration_ms: _d, workspace: _w, ...rest } = r;
    return rest;
  };

  it("lists import_process with nested steps in its schema", async () => {
    const editor = await connect(editorToken, options);
    const { tools } = await editor.listTools();
    const tool = tools.find((t) => t.name === "import_process")!;
    const text = JSON.stringify(tool.inputSchema);
    expect(text).toContain("child_process");
    expect(text).toContain("a group");
    await editor.close();
  });

  it("imports groups inside groups in one call, and simulates exactly as the same process drawn flat", async () => {
    await admin.query(
      `update workspaces set settings = '{"hours_per_week":40,"horizon_weeks":13,"leads_per_week":7,"active_clients":20,"churn_monthly":0.03,"retainer":3000}'::jsonb where id = $1`,
      [workspaceId],
    );
    const editor = await connect(editorToken, options);
    const step = (n: number, name: string, over: Record<string, unknown> = {}) => ({
      id: sid(n),
      name,
      role: "Consultant",
      work_hours: 1 + n / 10,
      wait_hours: 2 + n,
      rework_rate: n === 4 ? 0.1 : 0,
      ...over,
    });
    const flat = await call<Outcome>(editor, "import_process", {
      process_json: {
        name: "Flat sales",
        steps: [
          { id: sid(0), name: "Enquiry", kind: "start" },
          step(1, "Receive enquiry"),
          step(2, "Check fit"),
          step(3, "Discovery"),
          step(4, "Proposal"),
          { id: sid(9), name: "Won", kind: "end", outcome: "won" },
        ],
        edges: [
          { from: "Enquiry", to: "Receive enquiry" },
          { from: "Receive enquiry", to: "Check fit" },
          { from: "Check fit", to: "Discovery" },
          { from: "Discovery", to: "Proposal" },
          { from: "Proposal", to: "Won" },
        ],
      },
    });
    expect(flat.ok, JSON.stringify(flat)).toBe(true);

    const nested = await call<Outcome>(editor, "import_process", {
      process_json: {
        name: "Nested sales",
        steps: [
          { id: sid(0), name: "Enquiry", kind: "start" },
          {
            name: "Sales",
            steps: [
              { name: "Qualify", steps: [step(1, "Receive enquiry"), step(2, "Check fit")] },
              step(3, "Discovery"),
              step(4, "Proposal"),
            ],
          },
          { id: sid(9), name: "Won", kind: "end", outcome: "won" },
        ],
        // Edges name steps at any depth; those into a group enter its first step.
        edges: [
          { from: "Enquiry", to: "Sales" },
          { from: "Receive enquiry", to: "Check fit" },
          { from: "Check fit", to: "Discovery" },
          { from: "Discovery", to: "Proposal" },
          { from: "Sales", to: "Won" },
        ],
      },
    });
    expect(nested.ok, JSON.stringify(nested)).toBe(true);
    expect(nested.data.diff.steps.added.map((s) => s.name).sort()).toEqual(["Check fit", "Discovery", "Enquiry", "Proposal", "Qualify", "Receive enquiry", "Sales", "Won"]);
    expect(nested.data.warnings).toEqual([]);

    const proc = await processRow("Nested sales");
    const rows = await stepsOf(proc.draft_revision_id!);
    const named = (name: string) => rows.find((r) => r.name === name)! as unknown as { id: string; kind: string; parent_step_id: string | null; entry_step_id: string | null; x: number; y: number };
    expect(named("Sales")).toMatchObject({ kind: "group", parent_step_id: null, entry_step_id: named("Qualify").id });
    expect(named("Qualify")).toMatchObject({ kind: "group", parent_step_id: named("Sales").id, entry_step_id: sid(1) });
    expect(named("Receive enquiry")).toMatchObject({ id: sid(1), parent_step_id: named("Qualify").id });
    expect(named("Check fit").parent_step_id).toBe(named("Qualify").id);
    expect(named("Proposal").parent_step_id).toBe(named("Sales").id);
    expect(named("Won").parent_step_id).toBeNull();

    // get_process shows the nesting, so Claude can read back what it wrote.
    const read = await call<{ steps: { name: string; parent_step_id: string | null; entry_step_id: string | null }[] }>(editor, "get_process", { process: "Nested sales", revision: "draft" });
    expect(read.data.steps.find((s) => s.name === "Qualify")).toMatchObject({ parent_step_id: named("Sales").id, entry_step_id: sid(1) });

    for (const name of ["Flat sales", "Nested sales"]) {
      const published = await call(editor, "publish_process", { process: name, accept_estimates: true });
      expect(published.ok, JSON.stringify(published)).toBe(true);
    }
    const a = await call<Run>(editor, "run_scenario", { process: "Flat sales", ...SIM });
    const b = await call<Run>(editor, "run_scenario", { process: "Nested sales", ...SIM });
    expect(a.ok, JSON.stringify(a)).toBe(true);
    expect(b.ok, JSON.stringify(b)).toBe(true);
    // Same steps, same numbers: nesting is how the map is drawn, not what is simulated.
    expect(numbers(b.data)).toEqual(numbers(a.data));
    expect((a.data.kpi as { won: { mean: number } }).won.mean).toBeGreaterThan(0);
    await editor.close();
  });

  it("round trips: reading the nested process back and importing it again changes nothing", async () => {
    const editor = await connect(editorToken, options);
    const read = await call<{
      steps: { id: string; name: string; kind: string; outcome: string | null; parent_step_id: string | null; entry_step_id: string | null }[];
      edges: { from_step_id: string; to_step_id: string; probability: number }[];
    }>(editor, "get_process", { process: "Nested sales" });
    const name = new Map(read.data.steps.map((s) => [s.id, s.name]));
    const again = await call<Outcome>(editor, "import_process", {
      target: "Nested sales",
      process_json: {
        steps: read.data.steps.map((s) => ({
          id: s.id,
          name: s.name,
          kind: s.kind,
          ...(s.outcome ? { outcome: s.outcome } : {}),
          parent: s.parent_step_id ? name.get(s.parent_step_id) : null,
          ...(s.entry_step_id ? { entry: name.get(s.entry_step_id) } : {}),
        })),
        edges: read.data.edges.map((e) => ({ from: name.get(e.from_step_id), to: name.get(e.to_step_id), probability: e.probability })),
      },
    });
    expect(again.ok, JSON.stringify(again)).toBe(true);
    expect(again.data.created).toBe(false);
    expect(again.data.diff.text).toBe("The draft is the same as live.");
    expect(again.data.matched.every((m) => m.by === "id")).toBe(true);
    await editor.close();
  });

  it("imports a child process in the same call, and simulates it as part of the process that holds it", async () => {
    const editor = await connect(editorToken, options);
    const task = (n: number, name: string) => ({ id: sid(n), name, role: "Consultant", work_hours: 1 + n / 10, wait_hours: 2 + n, rework_rate: n === 14 ? 0.1 : 0 });
    const flat = await call<Outcome>(editor, "import_process", {
      process_json: {
        name: "Flat delivery",
        steps: [
          { id: sid(10), name: "Enquiry", kind: "start" },
          task(11, "Qualify"),
          task(12, "Kickoff"),
          task(13, "Build"),
          task(14, "Go live"),
          { id: sid(19), name: "Won", kind: "end", outcome: "won" },
        ],
        edges: [
          { from: "Enquiry", to: "Qualify" },
          { from: "Qualify", to: "Kickoff" },
          { from: "Kickoff", to: "Build" },
          { from: "Build", to: "Go live" },
          { from: "Go live", to: "Won" },
        ],
      },
    });
    expect(flat.ok, JSON.stringify(flat)).toBe(true);

    const made = await call<Outcome>(editor, "import_process", {
      process_json: {
        name: "Company delivery",
        steps: [
          { id: sid(10), name: "Enquiry", kind: "start" },
          task(11, "Qualify"),
          {
            name: "Delivery",
            process: {
              name: "Delivery process",
              steps: [{ name: "Start delivery", kind: "start" }, task(12, "Kickoff"), task(13, "Build"), task(14, "Go live"), { name: "Delivered", kind: "end", outcome: "done" }],
              edges: [
                { from: "Start delivery", to: "Kickoff" },
                { from: "Kickoff", to: "Build" },
                { from: "Build", to: "Go live" },
                { from: "Go live", to: "Delivered" },
              ],
            },
          },
          { id: sid(19), name: "Won", kind: "end", outcome: "won" },
        ],
        edges: [
          { from: "Enquiry", to: "Qualify" },
          { from: "Qualify", to: "Delivery" },
          { from: "Delivery", to: "Won" },
        ],
      },
    });
    expect(made.ok, JSON.stringify(made)).toBe(true);
    expect(made.data.children).toHaveLength(1);
    expect(made.data.children[0]).toMatchObject({ step: "Delivery", created: true, process: { name: "Delivery process" } });
    expect(made.data.text).toContain("'Delivery' holds 'Delivery process'");

    const parent = await processRow("Company delivery");
    const child = await processRow("Delivery process");
    expect(child).toMatchObject({ parent_process_id: parent.id, source: "import" });
    expect(parent).toMatchObject({ parent_process_id: null });
    const holder = (await stepsOf(parent.draft_revision_id!)).find((s) => s.name === "Delivery")! as unknown as { kind: string; child_process_id: string; work_hours: number; role_id: string | null };
    expect(holder).toMatchObject({ kind: "subprocess", child_process_id: child.id, role_id: null });
    expect(Number(holder.work_hours)).toBe(0);
    expect((await stepsOf(child.draft_revision_id!)).map((s) => s.name).sort()).toEqual(["Build", "Delivered", "Go live", "Kickoff", "Start delivery"]);

    const read = await call<{ process: { parent_process_id: string | null } }>(editor, "get_process", { process: "Delivery process", revision: "draft" });
    expect(read.data.process.parent_process_id).toBe(parent.id);

    // Publish the child, then the parent, and simulate: the child's steps are simulated inside the parent.
    expect(await call(editor, "publish_process", { process: "Flat delivery", accept_estimates: true })).toMatchObject({ ok: true });
    expect(await call(editor, "publish_process", { process: "Delivery process", accept_estimates: true })).toMatchObject({ ok: true });
    expect(await call(editor, "publish_process", { process: "Company delivery", accept_estimates: true })).toMatchObject({ ok: true });
    const a = await call<Run>(editor, "run_scenario", { process: "Flat delivery", ...SIM });
    const b = await call<Run>(editor, "run_scenario", { process: "Company delivery", ...SIM });
    expect(b.ok, JSON.stringify(b)).toBe(true);
    expect(numbers(b.data)).toEqual(numbers(a.data));

    // The child on its own simulates too (it is a process of its own, with its own page and versions).
    const alone = await call<Run>(editor, "run_scenario", { process: "Delivery process", ...SIM });
    expect(alone.ok, JSON.stringify(alone)).toBe(true);
    await editor.close();
  });

  it("writes into the child a step already holds, and moves an existing process inside a step", async () => {
    const editor = await connect(editorToken, options);
    // The same import again, now with a changed child step: it goes into the existing child's draft.
    const again = await call<Outcome>(editor, "import_process", {
      target: "Company delivery",
      process_json: {
        steps: [{ name: "Delivery", process: { steps: [{ name: "Build", work_hours: 9, role: "Consultant" }] } }],
      },
    });
    expect(again.ok, JSON.stringify(again)).toBe(true);
    expect(again.data.children).toHaveLength(1);
    expect(again.data.children[0]).toMatchObject({ step: "Delivery", created: false, process: { name: "Delivery process" } });
    expect(again.data.children[0]!.matched).toEqual([{ name: "Build", id: sid(13), by: "name" }]);
    const child = await processRow("Delivery process");
    expect(child.draft_revision_id).not.toBeNull();

    // An existing standalone process becomes the child of a new step.
    expect(await call(editor, "create_process", { name: "Standalone" })).toMatchObject({ ok: true });
    const adopt = await call<Outcome>(editor, "import_process", {
      target: "Company delivery",
      process_json: { steps: [{ name: "Standalone step", child_process: "Standalone" }] },
    });
    expect(adopt.ok, JSON.stringify(adopt)).toBe(true);
    expect(adopt.data.text).toContain("(moved inside it)");
    const parent = await processRow("Company delivery");
    expect(await processRow("Standalone")).toMatchObject({ parent_process_id: parent.id });

    // A process has one parent.
    expect(await call(editor, "import_process", { target: "Flat delivery", process_json: { steps: [{ name: "Also here", child_process: "Standalone" }] } })).toMatchObject({
      ok: false,
      error: { code: "invalid_input", message: expect.stringContaining("already sits inside") },
    });
    await editor.close();
  });

  it("refuses a loop, a name that is taken and a bad nesting, and writes nothing", async () => {
    const editor = await connect(editorToken, options);
    const processesBefore = (await admin.query("select count(*)::int n from processes where workspace_id = $1", [workspaceId])).rows[0].n;
    const parent = await processRow("Company delivery");
    const child = await processRow("Delivery process");
    const before = await snapshot(child.draft_revision_id!);

    // The child can't hold the process that holds it.
    expect(await call(editor, "import_process", { target: "Delivery process", process_json: { steps: [{ name: "Back up", child_process: "Company delivery" }] } })).toMatchObject({
      ok: false,
      error: { code: "invalid_input", message: expect.stringContaining("can't sit inside itself") },
    });
    // Nor can a process hold itself.
    expect(await call(editor, "import_process", { target: "Company delivery", process_json: { steps: [{ name: "Me", child_process: "Company delivery" }] } })).toMatchObject({
      ok: false,
      error: { code: "invalid_input" },
    });
    // A new child named like an existing process: nothing is created, not even the parent.
    expect(
      await call(editor, "import_process", {
        process_json: { name: "Brand new parent", steps: [{ name: "Holds", process: { name: "Standalone", steps: [] } }] },
      }),
    ).toMatchObject({ ok: false, error: { code: "name_taken" } });
    // Two new processes with the same name in one call.
    expect(
      await call(editor, "import_process", {
        process_json: { name: "Twin parent", steps: [{ name: "One", process: { name: "Twin child", steps: [] } }, { name: "Two", process: { name: "twin child", steps: [] } }] },
      }),
    ).toMatchObject({ ok: false, error: { code: "name_taken" } });
    // Bad nesting inside a child stops the whole call before the parent is written.
    expect(
      await call(editor, "import_process", {
        process_json: { name: "Parent of a bad child", steps: [{ name: "Holds", process: { name: "Bad child", steps: [{ name: "Box", kind: "group", work_hours: 3 }] } }] },
      }),
    ).toMatchObject({ ok: false, error: { code: "invalid_input", message: expect.stringContaining("does no work itself") } });
    // A step in a task, a start step in a group, and a group removed from under its steps.
    expect(await call(editor, "import_process", { target: "Delivery process", process_json: { steps: [{ name: "In a task", parent: "Build" }] } })).toMatchObject({
      ok: false,
      error: { code: "invalid_input", message: expect.stringContaining("isn't a group") },
    });
    expect(await call(editor, "import_process", { target: "Delivery process", process_json: { steps: [{ name: "Box", steps: [{ name: "Again", kind: "start" }] }] } })).toMatchObject({
      ok: false,
      error: { code: "invalid_input" },
    });

    expect((await admin.query("select count(*)::int n from processes where workspace_id = $1", [workspaceId])).rows[0].n).toBe(processesBefore);
    expect(await snapshot(child.draft_revision_id!)).toEqual(before);
    expect(await processRow("Company delivery")).toMatchObject({ id: parent.id });
    await editor.close();
  });

  it("refuses two steps holding one child process, in one call or against a step that holds it already, and writes nothing", async () => {
    const editor = await connect(editorToken, options);
    expect(await call(editor, "create_process", { name: "Shared child" })).toMatchObject({ ok: true });
    const processesBefore = (await admin.query("select count(*)::int n from processes where workspace_id = $1", [workspaceId])).rows[0].n;
    const draftsBefore = (await admin.query("select count(*)::int n from process_revisions where workspace_id = $1", [workspaceId])).rows[0].n;

    // Two steps of one import name the same existing process.
    expect(
      await call(editor, "import_process", {
        process_json: { name: "Twice holder", steps: [{ name: "One", child_process: "Shared child" }, { name: "Two", child_process: "Shared child" }] },
      }),
    ).toMatchObject({ ok: false, error: { code: "invalid_input", message: expect.stringContaining("can't sit in both") } });
    // A new parent and an existing one can't both take it either (the second holder is in the first call's scope).
    expect(
      await call(editor, "import_process", {
        process_json: {
          name: "Nested twice",
          steps: [{ name: "Outer", process: { name: "Outer child", steps: [{ name: "Inner", child_process: "Shared child" }] } }, { name: "Again", child_process: "Shared child" }],
        },
      }),
    ).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect((await admin.query("select count(*)::int n from processes where workspace_id = $1", [workspaceId])).rows[0].n).toBe(processesBefore);
    expect((await admin.query("select count(*)::int n from process_revisions where workspace_id = $1", [workspaceId])).rows[0].n).toBe(draftsBefore);

    // One step holds it; a second step of another call may not.
    const first = await call(editor, "import_process", { target: "Company delivery", process_json: { steps: [{ name: "Holds shared", child_process: "Shared child" }] } });
    expect(first.ok, JSON.stringify(first)).toBe(true);
    const parent = await processRow("Company delivery");
    const before = await snapshot(parent.draft_revision_id!);
    expect(await call(editor, "import_process", { target: "Company delivery", process_json: { steps: [{ name: "Holds shared too", child_process: "Shared child" }] } })).toMatchObject({
      ok: false,
      error: { code: "invalid_input", message: expect.stringContaining("already held by the step 'Holds shared'") },
    });
    expect(await snapshot(parent.draft_revision_id!)).toEqual(before);
    await editor.close();
  });

  it("turns a group into a task and moves its steps out in one import (leaving, then changing kind, then entering)", async () => {
    const editor = await connect(editorToken, options);
    const done = await call<Outcome>(editor, "import_process", {
      target: "Nested sales",
      process_json: {
        steps: [
          { name: "Qualify", kind: "task", entry: null, work_hours: 1, role: "Consultant" },
          { name: "Receive enquiry", parent: null },
          { name: "Check fit", parent: null },
        ],
      },
    });
    expect(done.ok, JSON.stringify(done)).toBe(true);
    const proc = await processRow("Nested sales");
    const rows = (await stepsOf(proc.draft_revision_id!)) as unknown as { name: string; kind: string; parent_step_id: string | null; entry_step_id: string | null }[];
    const by = (n: string) => rows.find((r) => r.name === n)!;
    expect(by("Qualify")).toMatchObject({ kind: "task", entry_step_id: null });
    expect(by("Receive enquiry").parent_step_id).toBeNull();
    expect(by("Check fit").parent_step_id).toBeNull();
    expect(by("Sales")).toMatchObject({ kind: "group" });
    await editor.close();
  });

  it("changes a group's first step, and moves the old first step out of the group listed before it, without partial writes or false conflicts", async () => {
    const editor = await connect(editorToken, options);
    const made = await call<Outcome>(editor, "import_process", {
      process_json: {
        name: "Entry changes",
        steps: [
          { name: "Start", kind: "start" },
          { name: "Box", steps: [{ name: "A", work_hours: 1, role: "Consultant" }, { name: "B", work_hours: 1, role: "Consultant" }, { name: "C", work_hours: 1, role: "Consultant" }] },
          { name: "End", kind: "end", outcome: "won" },
        ],
        edges: [{ from: "Start", to: "Box" }, { from: "Box", to: "End" }],
      },
    });
    expect(made.ok, JSON.stringify(made)).toBe(true);
    const proc = await processRow("Entry changes");
    const rowsOf = async () => (await stepsOf(proc.draft_revision_id!)) as unknown as { id: string; name: string; parent_step_id: string | null; entry_step_id: string | null }[];
    const by = async (n: string) => (await rowsOf()).find((r) => r.name === n)!;
    expect((await by("Box")).entry_step_id).toBe((await by("A")).id);

    // (a) Another step becomes the first step: no conflict, and the group ends with it.
    const changed = await call<Outcome & { edit_conflicts: unknown[] }>(editor, "import_process", { target: "Entry changes", process_json: { steps: [{ name: "Box", entry: "B" }] } });
    expect(changed.ok, JSON.stringify(changed)).toBe(true);
    expect(changed.data.edit_conflicts).toEqual([]);
    expect((await by("Box")).entry_step_id).toBe((await by("B")).id);

    // (b) The first step moves out, listed before its group, and the group gets a new one in the same call.
    const moved = await call<Outcome & { edit_conflicts: unknown[] }>(editor, "import_process", {
      target: "Entry changes",
      process_json: { steps: [{ name: "B", parent: null }, { name: "Box", entry: "C" }] },
    });
    expect(moved.ok, JSON.stringify(moved)).toBe(true);
    expect(moved.data.edit_conflicts).toEqual([]);
    expect((await by("B")).parent_step_id).toBeNull();
    expect((await by("Box")).entry_step_id).toBe((await by("C")).id);
    await editor.close();
  });
});
