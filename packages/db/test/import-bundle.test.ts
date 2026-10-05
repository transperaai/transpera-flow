import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NORTHBEAM_WORKSPACE_ID } from "../src";
import { createTestDb, createUser, type TestDb } from "./harness";

// B14 (1/2, issue #167, migration 20261129000000): `import_process_bundle` writes a /2 upload (process, draft, sources and their
// links, first principles, pending suggestions and proposals) in one transaction, and a step's "branch odds not given" marker
// goes away when anyone writes its branches' probabilities. Made with Supabase's default privileges, as production.

const ws = NORTHBEAM_WORKSPACE_ID;
let db: TestDb;
let editor: { id: string; claims: Record<string, unknown> };
let viewer: { id: string; claims: Record<string, unknown> };
let other: { id: string; claims: Record<string, unknown> };

beforeAll(async () => {
  db = await createTestDb({ supabaseDefaultPrivileges: true });
  editor = await createUser(db, "editor@import-bundle.example.com");
  viewer = await createUser(db, "viewer@import-bundle.example.com");
  other = await createUser(db, "other@import-bundle.example.com");
  await db.client.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, 'editor'), ($1, $3, 'viewer')", [ws, editor.id, viewer.id]);
});

afterAll(async () => {
  await db?.close();
});

/**
 * Run as a signed-in user and COMMIT (the harness's `db.as` rolls back): what one PostgREST request does. A call that throws is
 * rolled back whole, which is what "all or nothing" means; the checks after it read the committed state.
 */
async function as<T>(claims: Record<string, unknown>, fn: (c: TestDb["client"]) => Promise<T>): Promise<T> {
  await db.client.query("begin");
  try {
    await db.client.query("set local role authenticated");
    await db.client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
    const r = await fn(db.client);
    await db.client.query("commit");
    return r;
  } catch (e) {
    await db.client.query("rollback");
    throw e;
  }
}

const step = (id: string, name: string, kind: string, extra: Record<string, unknown> = {}) => ({
  id,
  name,
  kind,
  outcome: kind === "end" ? "done" : null,
  work_hours: 0,
  wait_hours: 0,
  rework_rate: 0,
  x: 0,
  y: 0,
  provenance: {},
  assumption: false,
  conflict: false,
  ...extra,
});

/** start → review (cites `source`) → decide → won / lost, the decision marked as having no odds given. */
function node(name: string, source: string) {
  const [a, b, d, w, l] = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  return {
    ids: { review: b, decide: d },
    node: {
      id: randomUUID(),
      parent_id: null,
      name,
      kind: "pipeline",
      entity_name: "lead",
      description: null,
      steps: [
        step(a, "Start", "start"),
        step(b, "Review", "task", {
          work_hours: 0.25,
          provenance: { work_hours: { source: "estimated", evidence: [{ source_id: source, speaker: "Sam", quote: "Fifteen minutes.", timestamp: "00:01", value: 0.25 }] } },
        }),
        step(d, "Decide", "decision", { provenance: { branch_odds: { source: "estimated", defaulted: true, note: "No odds given." } } }),
        step(w, "Won", "end"),
        step(l, "Lost", "end", { outcome: "lost" }),
      ],
      edges: [
        { id: randomUUID(), from_step_id: a, to_step_id: b, probability: 1 },
        { id: randomUUID(), from_step_id: b, to_step_id: d, probability: 1 },
        { id: randomUUID(), from_step_id: d, to_step_id: w, probability: 0.5, label: "Wins" },
        { id: randomUUID(), from_step_id: d, to_step_id: l, probability: 0.5, label: "Loses" },
      ],
    },
  };
}

const count = async (sql: string, params: unknown[] = []) => Number((await db.client.query(sql, params)).rows[0].n);

function extras(source: string, proc: string, stepId: string) {
  return {
    sources: [{ id: source, kind: "transcript", title: "Talk with Sam", speakers: ["Sam"], recorded_at: "2026-09-30", body: "Sam: Fifteen minutes." }],
    first_principles: { job_who: "A founder", job_done: "Signed", statements: [{ text: "Leads go cold", kind: "truth", source: "Sam", test: "", linked_parameter: null }], requirements: [], deletes: [], improvements: [], why_problem: "", why_chain: [""], root_cause: "", measures: [] },
    suggestions: [
      { target_table: "people", target_id: null, patch: { set: { name: "Bundle Person", fte: 1 } }, evidence: [{ source_id: source, speaker: "Sam", quote: "Fifteen minutes.", timestamp: "00:01" }], note: "Assumed: named in the SOP" },
      { target_table: "roles", target_id: null, patch: { set: { name: "Bundle Role" } }, evidence: [], note: null },
    ],
    proposals: [{ kind: "issue", title: "Review is slow", detail: "Said so.", payload: { severity: "warning", type: "delay", links: [{ process_id: proc, step_id: stepId }] }, evidence: [{ source_id: source, quote: "Fifteen minutes." }], note: null, issue_id: null }],
  };
}

describe("import_process_bundle", () => {
  it("writes the process, sources, links, first principles, pending suggestions and proposals as the signed-in editor, and applies nothing live", async () => {
    const source = randomUUID();
    const n = node("Bundle ok", source);
    const peopleBefore = await count("select count(*) n from people where workspace_id = $1", [ws]);
    const rolesBefore = await count("select count(*) n from roles where workspace_id = $1", [ws]);
    const issuesBefore = await count("select count(*) n from issues where workspace_id = $1", [ws]);
    await as(editor.claims, async (c) => {
      const { rows } = await c.query("select public.import_process_bundle($1, $2, '[]', $3) r", [ws, JSON.stringify([n.node]), JSON.stringify(extras(source, n.node.id, n.ids.review))]);
      const r = rows[0].r;
      expect(r).toMatchObject({ sources: 1, suggestions: 2, proposals: 1, first_principles: true });
      expect(r.processes).toHaveLength(1);
      const rev = r.processes[0].revision_id;

      expect((await c.query("select kind, title, speakers, recorded_at::text d, body, created_by from sources where id = $1", [source])).rows[0]).toMatchObject({ kind: "transcript", title: "Talk with Sam", speakers: ["Sam"], d: "2026-09-30", created_by: editor.id });
      // The source is linked to the process, and (by the step trigger) to the step that cites it: never "Not linked".
      const links = (await c.query("select kind, process_id, step_id from source_links where source_id = $1 order by kind", [source])).rows;
      expect(links).toEqual([
        { kind: "process", process_id: n.node.id, step_id: null },
        { kind: "step", process_id: n.node.id, step_id: n.ids.review },
      ]);
      expect((await c.query("select job_who, job_done, statements, revision_id from first_principles where process_id = $1", [n.node.id])).rows[0]).toMatchObject({ job_who: "A founder", job_done: "Signed", revision_id: rev });
      const sugg = (await c.query("select target_table, status, created_via, note, evidence from suggestions where workspace_id = $1 and (patch -> 'set' ->> 'name') in ('Bundle Person', 'Bundle Role') order by target_table", [ws])).rows;
      expect(sugg.map((s) => [s.target_table, s.status, s.created_via])).toEqual([["people", "pending", "mcp"], ["roles", "pending", "mcp"]]);
      expect(sugg[0].evidence[0]).toMatchObject({ source_id: source, speaker: "Sam" });
      const props = (await c.query("select kind, status, title, payload from suggestion_proposals where workspace_id = $1 and title = 'Review is slow'", [ws])).rows;
      expect(props).toHaveLength(1);
      expect(props[0]).toMatchObject({ kind: "issue", status: "pending" });
      expect(props[0].payload.links[0]).toEqual({ process_id: n.node.id, step_id: n.ids.review });
    });
    // Nothing company-level was applied.
    expect(await count("select count(*) n from people where workspace_id = $1", [ws])).toBe(peopleBefore);
    expect(await count("select count(*) n from roles where workspace_id = $1", [ws])).toBe(rolesBefore);
    expect(await count("select count(*) n from issues where workspace_id = $1", [ws])).toBe(issuesBefore);
  });

  it("is all or nothing: a bad suggestion, proposal, first principles or a name already taken leaves no process, source, link or row behind", async () => {
    const taken = node("Bundle ok", randomUUID());
    const cases: [string, ReturnType<typeof node>, (e: ReturnType<typeof extras>) => void, RegExp][] = [
      ["a name already taken", taken, () => {}, /You already have a process called 'Bundle ok'/],
      ["a suggestion table that doesn't exist", node("Bundle bad suggestion", ""), (e) => (e.suggestions[0]!.target_table = "pizza"), /suggestions_target_table/],
      ["a proposal with a severity issues don't take", node("Bundle bad proposal", ""), (e) => ((e.proposals[0]!.payload as { severity: string }).severity = "dire"), /suggestion_proposals_payload/],
      ["a first principles list that isn't a list", node("Bundle bad fp", ""), (e) => ((e.first_principles as { statements: unknown }).statements = { not: "a list" }), /first_principles_statements_check/],
      ["a source with no title", node("Bundle bad source", ""), (e) => (e.sources[0]!.title = " "), /sources_title_length/],
    ];
    for (const [what, n, change, message] of cases) {
      const source = randomUUID();
      const bundle = n === taken ? n : { ids: n.ids, node: { ...n.node, steps: n.node.steps.map((s) => ({ ...s, provenance: s.name === "Review" ? { work_hours: { source: "estimated", evidence: [{ source_id: source, quote: "x" }] } } : s.provenance })) } };
      const e = extras(source, bundle.node.id, bundle.ids.review);
      change(e);
      const before = {
        processes: await count("select count(*) n from processes where workspace_id = $1", [ws]),
        sources: await count("select count(*) n from sources where workspace_id = $1", [ws]),
        links: await count("select count(*) n from source_links where workspace_id = $1", [ws]),
        suggestions: await count("select count(*) n from suggestions where workspace_id = $1", [ws]),
        proposals: await count("select count(*) n from suggestion_proposals where workspace_id = $1", [ws]),
        fp: await count("select count(*) n from first_principles where workspace_id = $1", [ws]),
      };
      await expect(
        as(editor.claims, (c) => c.query("select public.import_process_bundle($1, $2, '[]', $3)", [ws, JSON.stringify([bundle.node]), JSON.stringify(e)])),
        what,
      ).rejects.toThrow(message);
      expect({
        processes: await count("select count(*) n from processes where workspace_id = $1", [ws]),
        sources: await count("select count(*) n from sources where workspace_id = $1", [ws]),
        links: await count("select count(*) n from source_links where workspace_id = $1", [ws]),
        suggestions: await count("select count(*) n from suggestions where workspace_id = $1", [ws]),
        proposals: await count("select count(*) n from suggestion_proposals where workspace_id = $1", [ws]),
        fp: await count("select count(*) n from first_principles where workspace_id = $1", [ws]),
      }, what).toEqual(before);
    }
  });

  it("works with no extras at all, and refuses oversized or malformed ones", async () => {
    const n = node("Bundle bare", randomUUID());
    await as(editor.claims, async (c) => {
      const r = (await c.query("select public.import_process_bundle($1, $2) r", [ws, JSON.stringify([n.node])])).rows[0].r;
      expect(r).toMatchObject({ sources: 0, suggestions: 0, proposals: 0, first_principles: false });
    });
    for (const [bad, message] of [
      [{ sources: Array.from({ length: 51 }, () => ({})) }, /at most 50 sources, 300 suggestions and 50 proposals/],
      [{ suggestions: Array.from({ length: 301 }, () => ({})) }, /at most 50 sources/],
      [{ proposals: Array.from({ length: 51 }, () => ({})) }, /at most 50 sources/],
      [{ sources: "x" }, /must be arrays/],
      [[], /p_extras must be an object/],
    ] as const) {
      await expect(as(editor.claims, (c) => c.query("select public.import_process_bundle($1, $2, '[]', $3)", [ws, JSON.stringify([node(`Bundle bad ${Math.random()}`, "").node]), JSON.stringify(bad)]))).rejects.toThrow(message);
    }
    await expect(as(editor.claims, (c) => c.query("select public.import_process_bundle($1, '[]', '[]', '{}')", [ws]))).rejects.toThrow(/p_nodes must be an array of processes/);
  });

  it("refuses a viewer and a stranger whole, and anon can't call it", async () => {
    for (const who of [viewer, other]) {
      const source = randomUUID();
      const n = node(`Bundle refused ${who.id}`, source);
      const sources = await count("select count(*) n from sources where workspace_id = $1", [ws]);
      await expect(as(who.claims, (c) => c.query("select public.import_process_bundle($1, $2, '[]', $3)", [ws, JSON.stringify([n.node]), JSON.stringify(extras(source, n.node.id, n.ids.review))]))).rejects.toThrow(/row-level security|permission denied|42501/);
      expect(await count("select count(*) n from sources where workspace_id = $1", [ws])).toBe(sources);
    }
    await db.client.query("begin");
    try {
      await db.client.query("set local role anon");
      await expect(db.client.query("select public.import_process_bundle($1, '[]')", [ws])).rejects.toThrow(/permission denied for function import_process_bundle/);
    } finally {
      await db.client.query("rollback");
    }
  });

  it("only authenticated holds EXECUTE on it (no anon, no PUBLIC)", async () => {
    const acl = (await db.client.query("select proacl::text a from pg_proc where pronamespace = 'public'::regnamespace and proname = 'import_process_bundle'")).rows[0].a as string;
    expect(acl).toContain("authenticated=X/");
    expect(acl).not.toMatch(/anon=/);
    expect(acl).not.toMatch(/(^\{|,)=X\//);
  });
});

describe("the branch-odds marker", () => {
  async function made(name: string) {
    const source = randomUUID();
    const n = node(name, source);
    const rev = await as(editor.claims, async (c) => (await c.query("select public.import_process_bundle($1, $2, '[]', $3) r", [ws, JSON.stringify([n.node]), JSON.stringify({ sources: extras(source, n.node.id, n.ids.review).sources })])).rows[0].r.processes[0].revision_id as string);
    return { n, rev };
  }
  const marker = async (rev: string, id: string) => (await db.client.query("select provenance -> 'branch_odds' m from steps where revision_id = $1 and id = $2", [rev, id])).rows[0].m;

  it("is stored with the step, and goes when one of its branches' probabilities is written", async () => {
    const { n, rev } = await made("Odds marker clears");
    expect(await marker(rev, n.ids.decide)).toMatchObject({ source: "estimated", defaulted: true });
    await as(editor.claims, (c) => c.query("update edges set probability = 0.7 where revision_id = $1 and from_step_id = $2 and label = 'Wins'", [rev, n.ids.decide]));
    expect(await marker(rev, n.ids.decide)).toBeNull();
    // The rest of the step's provenance is untouched, and nothing else was changed.
    expect((await db.client.query("select provenance ? 'work_hours' h from steps where revision_id = $1 and id = $2", [rev, n.ids.review])).rows[0].h).toBe(true);
  });

  it("stays when something else about an edge changes", async () => {
    const { n, rev } = await made("Odds marker stays");
    await as(editor.claims, (c) => c.query("update edges set label = 'Wins it' where revision_id = $1 and from_step_id = $2 and label = 'Wins'", [rev, n.ids.decide]));
    expect(await marker(rev, n.ids.decide)).toMatchObject({ defaulted: true });
  });

  it("is carried into a draft opened from the published version, and still clears there", async () => {
    const { n, rev } = await made("Odds marker carried");
    const proc = n.node.id;
    await as(editor.claims, async (c) => {
      await c.query("select public.publish_process($1, true)", [proc]);
    });
    const draft = await as(editor.claims, async (c) => (await c.query("select public.open_draft($1) r", [proc])).rows[0].r.revision_id as string);
    expect(draft).not.toBe(rev);
    expect(await marker(draft, n.ids.decide)).toMatchObject({ defaulted: true });
    await as(editor.claims, (c) => c.query("update edges set probability = 0.6 where revision_id = $1 and from_step_id = $2 and label = 'Wins'", [draft, n.ids.decide]));
    expect(await marker(draft, n.ids.decide)).toBeNull();
    // The published version keeps its marker: history is not edited.
    expect(await marker(rev, n.ids.decide)).toMatchObject({ defaulted: true });
  });
});
