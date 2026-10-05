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
    ids: { review: b, decide: d, won: w, lost: l },
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
        step(d, "Decide", "decision", { provenance: { branch_odds: { source: "estimated", defaulted: true, was: { [w]: 0.5, [l]: 0.5 }, note: "No odds given." } } }),
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
    import_source: "talk.json",
    sources: [{ ref: source, kind: "transcript", title: `Talk with Sam ${source.slice(0, 8)}`, speakers: ["Sam"], recorded_at: "2026-09-30", body: "Sam: Fifteen minutes." }],
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

      // The database made the source's id; the placeholder the file cited is gone from everything written.
      const made = (await c.query("select id, kind, title, speakers, recorded_at::text d, body, created_by from sources where title = $1", [`Talk with Sam ${source.slice(0, 8)}`])).rows;
      expect(made).toHaveLength(1);
      expect(made[0]).toMatchObject({ kind: "transcript", speakers: ["Sam"], d: "2026-09-30", created_by: editor.id });
      const sid = made[0].id as string;
      expect(sid).not.toBe(source);
      // The source is linked to the process, and (by the step trigger) to the step that cites it: never "Not linked".
      const links = (await c.query("select kind, process_id, step_id from source_links where source_id = $1 order by kind", [sid])).rows;
      expect(links).toEqual([
        { kind: "process", process_id: n.node.id, step_id: null },
        { kind: "step", process_id: n.node.id, step_id: n.ids.review },
      ]);
      expect((await c.query("select job_who, job_done, statements, revision_id from first_principles where process_id = $1", [n.node.id])).rows[0]).toMatchObject({ job_who: "A founder", job_done: "Signed", revision_id: rev });
      const sugg = (await c.query("select target_table, status, created_via, note, evidence from suggestions where workspace_id = $1 and (patch -> 'set' ->> 'name') in ('Bundle Person', 'Bundle Role') order by target_table", [ws])).rows;
      expect(sugg.map((s) => [s.target_table, s.status, s.created_via])).toEqual([["people", "pending", "upload"], ["roles", "pending", "upload"]]);
      expect(sugg[0].evidence[0]).toMatchObject({ source_id: sid, speaker: "Sam" });
      expect((await c.query("select import_source from suggestions where workspace_id = $1 and created_via = 'upload'", [ws])).rows.every((r) => r.import_source === "talk.json")).toBe(true);
      // The cited source id was rewritten inside the step's provenance too.
      expect((await c.query("select provenance -> 'work_hours' -> 'evidence' -> 0 ->> 'source_id' s from steps where revision_id = $1 and name = 'Review'", [rev])).rows[0].s).toBe(sid);
      const props = (await c.query("select kind, status, title, payload from suggestion_proposals where workspace_id = $1 and title = 'Review is slow'", [ws])).rows;
      expect(props).toHaveLength(1);
      expect(props[0]).toMatchObject({ kind: "issue", status: "pending" });
      expect((await c.query("select created_via, import_source, proposer_name from suggestion_proposals where title = 'Review is slow'", [])).rows[0]).toEqual({ created_via: "upload", import_source: "talk.json", proposer_name: null });
      // Anything else a signed-in user inserts is still recorded as MCP.
      await c.query("insert into suggestion_proposals (workspace_id, kind, title, payload, created_via, import_source) values ($1, 'issue', 'By hand', '{}', 'upload', 'x')", [ws]);
      expect((await c.query("select created_via, import_source from suggestion_proposals where title = 'By hand'")).rows[0]).toEqual({ created_via: "mcp", import_source: null });
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

describe("hardening", () => {
  const call = (n: ReturnType<typeof node>, ex: Record<string, unknown>) =>
    as(editor.claims, async (c) => (await c.query("select public.import_process_bundle($1, $2, '[]', $3) r", [ws, JSON.stringify([n.node]), JSON.stringify(ex)])).rows[0].r);

  it("a section that is JSON null is a section that is left out", async () => {
    const r = await call(node("Bundle nulls", ""), { sources: null, suggestions: null, proposals: null, first_principles: null, import_source: null });
    expect(r).toMatchObject({ sources: 0, suggestions: 0, proposals: 0, first_principles: false });
  });

  it("refuses more than 2,000,000 characters of source text in all, in plain words", async () => {
    const big = "x".repeat(400_000);
    const src = (t: string) => ({ ref: randomUUID(), kind: "notes", title: t, speakers: [], body: big });
    await expect(call(node("Bundle big", ""), { sources: ["A", "B", "C", "D", "E", "F"].map(src) })).rejects.toThrow(/The sources' text is too long: 2400000 characters in all, and one upload takes at most 2,000,000/);
    await expect(call(node("Bundle big one", ""), { sources: ["A", "B", "C", "D", "E"].map(src) })).resolves.toMatchObject({ sources: 5 });
  });

  it("never takes a source's id from the caller: naming an id that exists makes a new source and says nothing about the other", async () => {
    const existing = (await db.client.query("select id from sources where workspace_id = $1 limit 1", [ws])).rows[0].id as string;
    const before = (await db.client.query("select title from sources where id = $1", [existing])).rows[0].title;
    const r = await call(node("Bundle ref clash", existing), { sources: [{ ref: existing, kind: "notes", title: "Made anyway" }] });
    expect(r.sources).toBe(1);
    expect((await db.client.query("select id from sources where title = 'Made anyway'")).rows[0].id).not.toBe(existing);
    expect((await db.client.query("select title from sources where id = $1", [existing])).rows[0].title).toBe(before);
  });

  /** A decision with three branches, none given odds (the marker holds what they were defaulted to). */
  async function three(name: string) {
    const n = node(name, "");
    const m = randomUUID();
    n.node.steps.push(step(m, "Maybe", "end", { outcome: "done" }));
    n.node.edges.push({ id: randomUUID(), from_step_id: n.ids.decide, to_step_id: m, probability: 0.5, label: "Maybe" } as never);
    const d = n.node.steps.find((x) => x.name === "Decide")!;
    d.provenance = { branch_odds: { source: "estimated", defaulted: true, was: { [n.ids.won]: 0.5, [n.ids.lost]: 0.5, [m]: 0.5 } } };
    const rev = (await call(n, {})).processes[0].revision_id as string;
    return { n, rev, m };
  }
  const markerOf = async (rev: string, id: string) => (await db.client.query("select provenance ? 'branch_odds' h from steps where revision_id = $1 and id = $2", [rev, id])).rows[0].h as boolean;

  it("with three branches, giving odds to one leaves the warning, and the second clears it (the last is inferred)", async () => {
    const { n, rev } = await three("Odds three");
    expect(await markerOf(rev, n.ids.decide)).toBe(true);
    await as(editor.claims, (c) => c.query("update edges set probability = 0.2 where revision_id = $1 and from_step_id = $2 and label = 'Wins'", [rev, n.ids.decide]));
    expect(await markerOf(rev, n.ids.decide)).toBe(true);
    await as(editor.claims, (c) => c.query("update edges set probability = 0.3 where revision_id = $1 and from_step_id = $2 and label = 'Loses'", [rev, n.ids.decide]));
    expect(await markerOf(rev, n.ids.decide)).toBe(false);
  });

  it("adding or removing a branch clears the marker, but the import's own edge inserts do not", async () => {
    const a = await three("Odds insert");
    expect(await markerOf(a.rev, a.n.ids.decide)).toBe(true);
    const end = randomUUID();
    await as(editor.claims, async (c) => {
      await c.query("insert into steps (id, revision_id, workspace_id, process_id, name, kind, outcome, x, y) select $1, $2, workspace_id, process_id, 'Extra', 'end', 'done', 0, 0 from steps where revision_id = $2 limit 1", [end, a.rev]);
      await c.query("insert into edges (revision_id, workspace_id, process_id, from_step_id, to_step_id, probability) select $1, workspace_id, process_id, $2, $3, 0.1 from steps where revision_id = $1 limit 1", [a.rev, a.n.ids.decide, end]);
    });
    expect(await markerOf(a.rev, a.n.ids.decide)).toBe(false);
    const b = await three("Odds delete");
    await as(editor.claims, (c) => c.query("delete from edges where revision_id = $1 and from_step_id = $2 and label = 'Maybe'", [b.rev, b.n.ids.decide]));
    expect(await markerOf(b.rev, b.n.ids.decide)).toBe(false);
  });

  it("never touches a published version: editing a draft leaves the published copy's marker", async () => {
    const { n, rev } = await three("Odds published");
    await as(editor.claims, (c) => c.query("select public.publish_process($1, true)", [n.node.id]));
    const draft = await as(editor.claims, async (c) => (await c.query("select public.open_draft($1) r", [n.node.id])).rows[0].r.revision_id as string);
    await as(editor.claims, async (c) => {
      await c.query("update edges set probability = 0.2 where revision_id = $1 and from_step_id = $2 and label = 'Wins'", [draft, n.ids.decide]);
      await c.query("update edges set probability = 0.3 where revision_id = $1 and from_step_id = $2 and label = 'Loses'", [draft, n.ids.decide]);
    });
    expect(await markerOf(draft, n.ids.decide)).toBe(false);
    expect(await markerOf(rev, n.ids.decide)).toBe(true);
  });
});
