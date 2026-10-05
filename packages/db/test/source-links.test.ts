import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  NORTHBEAM_PROCESS_ID,
  NORTHBEAM_WORKSPACE_ID,
  citeEvidence,
  derivedSourceLinks,
  linkColumns,
  northbeamIssues,
  northbeamSourceIds,
  northbeamSourceLinks,
  northbeamSources,
  northbeamStepIds,
  type SourceLinkTarget,
  type StepRow,
  unionIssueSources,
} from "../src";
import { createTestDb, createUser, type TestDb } from "./harness";

// Sources must link (issue #118, A53, migration 20261124500000_source_links.sql): the link table under row-level
// security, adding a source only with a link, the unlinked count, the check on step links, and the copy of today's
// step citations and issue sources into links.

const MIGRATION = "20261124500000_source_links.sql";
const dir = (p: string) => new URL(p, import.meta.url);
const ADMIN_URL = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/postgres";
const ws = NORTHBEAM_WORKSPACE_ID;
const interview = northbeamSourceIds.strategyInterview;
const notes = northbeamSourceIds.salesNotes;
const issue = northbeamIssues()[1]!.id;

const migrationText = readFileSync(dir(`../supabase/migrations/${MIGRATION}`), "utf8");

/** The SQL of one preflight query (P5, P7, P8) as written in the migration's header: its lines indented by eight spaces or more. */
function preflight(n: number): string {
  const lines = migrationText.split("\n");
  const from = lines.findIndex((l) => l.startsWith(`--   P${n}.`));
  const rest = lines.slice(from + 1);
  const to = rest.findIndex((l) => /^--   P\d\./.test(l) || l.startsWith("-- Post-apply"));
  return rest
    .slice(0, to)
    .filter((l) => l.startsWith("--        "))
    .map((l) => l.slice(2))
    .join("\n")
    .replace(/;\s*$/, "");
}

/** The rollback block in the migration's header, as SQL. */
function rollbackSql(): string {
  const lines = migrationText.split("\n");
  const from = lines.findIndex((l) => l.startsWith("--   begin;"));
  const to = lines.findIndex((l, i) => i > from && l.startsWith("--   commit;"));
  return lines.slice(from, to + 1).map((l) => l.slice(2)).join("\n");
}

describe("migrating today's step citations", () => {
  let client: pg.Client;
  let name: string;
  const w1 = randomUUID();
  const w2 = randomUUID();
  const proc = randomUUID();
  const rev1 = randomUUID();
  const rev2 = randomUUID();
  const stepA = randomUUID();
  const stepB = randomUUID();
  const stepC = randomUUID();
  const src1 = randomUUID();
  const src2 = randomUUID();
  const srcUncited = randomUUID();
  const srcOther = randomUUID();
  const gone = randomUUID();
  const stepD = randomUUID();
  let expected: { steps: number; issues: number; orphans: number; unlinked: { workspace_id: string; will_be_unlinked: string }[] };
  const issueId = randomUUID();
  const cite = (source_id: string, value = 1) => ({ source_id, speaker: "Rosa", quote: "q", timestamp: null, value });
  const prov = (cols: Record<string, string[]>) =>
    JSON.stringify(Object.fromEntries(Object.entries(cols).map(([c, ids]) => [c, { source: "estimated", at: "2026-09-29T00:00:00Z", evidence: ids.map((i) => cite(i)) }])));
  let beforeSteps: unknown[];
  let beforeSources: unknown[];
  let beforeIssueSources: unknown[];

  beforeAll(async () => {
    name = `transpera_flow_test_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`create database ${name}`);
    await admin.end();
    const url = new URL(ADMIN_URL);
    url.pathname = `/${name}`;
    client = new pg.Client({ connectionString: url.toString() });
    await client.connect();
    await client.query(readFileSync(dir("./sql/auth-shim.sql"), "utf8"));
    // Everything before this migration: the schema as production has it.
    for (const f of readdirSync(dir("../supabase/migrations")).filter((f) => f.endsWith(".sql") && f < MIGRATION).sort()) {
      await client.query(readFileSync(dir(`../supabase/migrations/${f}`), "utf8"));
    }
    await client.query("insert into workspaces (id, name, slug) values ($1, 'Old Co', 'old-co'), ($2, 'Other Co', 'other-co')", [w1, w2]);
    await client.query("insert into processes (id, workspace_id, name) values ($1, $2, 'Pipeline')", [proc, w1]);
    await client.query("insert into process_revisions (id, workspace_id, process_id, number, status) values ($1, $2, $3, 1, 'draft')", [rev1, w1, proc]);
    const step = (revision: string, id: string, n: string, provenance: string) =>
      client.query("insert into steps (id, revision_id, workspace_id, process_id, name, kind, work_hours, x, y, provenance) values ($1, $2, $3, $4, $5, 'task', 1, 0, 0, $6)", [id, revision, w1, proc, n, provenance]);
    await client.query("insert into sources (id, workspace_id, title) values ($1, $2, 'Interview'), ($3, $2, 'Notes'), ($4, $2, 'Never cited'), ($5, $6, 'Other workspace')", [src1, w1, src2, srcUncited, srcOther, w2]);
    // A cites src1 from two columns and src2 once; B cites src1 and a source that no longer exists; C cites a source of another workspace.
    await step(rev1, stepA, "Check fit", prov({ work_hours: [src1], wait_hours: [src1, src2] }));
    await step(rev1, stepB, "Send proposal", prov({ rework_rate: [src1, gone] }));
    await step(rev1, stepC, "Review", prov({ work_hours: [srcOther] }));
    // A citation spelled in capitals still names the source; and a value that is not an id at all gives nothing.
    await step(rev1, stepD, "Hand over", prov({ work_hours: [src2.toUpperCase(), "not an id"] }));
    await client.query("update process_revisions set status = 'published' where id = $1", [rev1]);
    await client.query("update processes set live_revision_id = $1 where id = $2", [rev1, proc]);
    // A later draft holds step A again (same stable id) citing src2 for another column, and a step with no provenance object at all.
    await client.query("insert into process_revisions (id, workspace_id, process_id, number, status) values ($1, $2, $3, 2, 'draft')", [rev2, w1, proc]);
    await step(rev2, stepA, "Check fit", prov({ work_hours: [src1], sla_hours: [src2] }));
    await client.query("insert into steps (id, revision_id, workspace_id, process_id, name, kind, work_hours, x, y, provenance) values ($1, $2, $3, $4, 'Plain', 'task', 1, 0, 0, '{}')", [randomUUID(), rev2, w1, proc]);
    // An issue that lists a source.
    await client.query("insert into issues (id, workspace_id, type, title) values ($1, $2, 'manual', 'An issue')", [issueId, w1]);
    await client.query("insert into issue_sources (issue_id, source_id, workspace_id) values ($1, $2, $3)", [issueId, src2, w1]);
    // The preflight queries in the header, run before the migration: what it promises to copy.
    const n = async (sql: string) => Number((await client.query(sql)).rows[0].count);
    expected = {
      steps: await n(preflight(5)),
      issues: await n(preflight(6)),
      orphans: await n(preflight(7)),
      unlinked: (await client.query(preflight(8))).rows,
    };
    beforeSteps = (await client.query("select * from steps order by revision_id, id")).rows;
    beforeSources = (await client.query("select * from sources order by id")).rows;
    beforeIssueSources = (await client.query("select * from issue_sources order by issue_id, source_id")).rows;
    await client.query(readFileSync(dir(`../supabase/migrations/${MIGRATION}`), "utf8"));
  });

  afterAll(async () => {
    await client?.end();
    const a = new pg.Client({ connectionString: ADMIN_URL });
    await a.connect();
    await a.query(`drop database if exists ${name} with (force)`);
    await a.end();
  });

  const links = async () => (await client.query("select source_id, kind, process_id, step_id, issue_id, workspace_id from source_links order by kind, source_id, step_id")).rows;

  it("links every source a step's values cite to that step, once per source and step, whatever the revision or column", async () => {
    const stepLinks = (await links()).filter((l) => l.kind === "step");
    const pair = (l: { source_id: string; step_id: string }) => `${l.source_id}:${l.step_id}`;
    expect(stepLinks.map(pair).sort()).toEqual([`${src1}:${stepA}`, `${src2}:${stepA}`, `${src1}:${stepB}`, `${src2}:${stepD}`].sort());
    for (const l of stepLinks) {
      expect(l.process_id).toBe(proc);
      expect(l.workspace_id).toBe(w1);
      expect(l.issue_id).toBeNull();
    }
  });

  it("covers every citation of a source that exists (read back from the stored provenance), and skips the ones that cannot link", async () => {
    // Computed independently of the migration's SQL: every source id named in any step's evidence that is a source of the step's workspace.
    const sourceIds = new Set((await client.query("select id from sources where workspace_id = $1", [w1])).rows.map((r) => r.id));
    const cited = new Set<string>();
    for (const row of (await client.query("select id, workspace_id, provenance from steps")).rows) {
      for (const entry of Object.values(row.provenance as Record<string, { evidence?: { source_id: string }[] }>)) {
        for (const ev of entry.evidence ?? []) if (row.workspace_id === w1 && sourceIds.has(ev.source_id.toLowerCase())) cited.add(`${ev.source_id.toLowerCase()}:${row.id}`);
      }
    }
    const linked = new Set((await links()).filter((l) => l.kind === "step").map((l) => `${l.source_id}:${l.step_id}`));
    expect(linked).toEqual(cited);
    // The source that is gone and the one in another workspace gave no link, and neither did the step with no citations.
    expect((await links()).some((l) => l.source_id === srcOther)).toBe(false);
  });

  it("links the sources an issue already lists, and leaves a source nothing cites unlinked", async () => {
    expect((await links()).filter((l) => l.kind === "issue")).toEqual([{ source_id: src2, kind: "issue", process_id: null, step_id: null, issue_id: issueId, workspace_id: w1 }]);
    const unlinked = (await client.query("select public.unlinked_source_count($1) as n", [w1])).rows[0].n;
    // Never cited, and nothing else of src* is unlinked: src1 and src2 are linked; the other workspace's source is not counted here.
    expect(unlinked).toBe(1);
    expect((await client.query("select public.unlinked_source_count($1) as n", [w2])).rows[0].n).toBe(1);
  });

  it("makes exactly the links the header's preflight promised, and finds nothing that would abort it", async () => {
    expect(expected.orphans).toBe(0);
    expect(expected.steps).toBe(4);
    expect(expected.issues).toBe(1);
    const count = async (kind: string) => Number((await client.query("select count(*) from source_links where kind = $1", [kind])).rows[0].count);
    expect(await count("step")).toBe(expected.steps);
    expect(await count("issue")).toBe(expected.issues);
    // P8: the sources it said would be flagged are the ones the count flags.
    expect(expected.unlinked.map((r) => [r.workspace_id, Number(r.will_be_unlinked)]).sort()).toEqual(
      [[w1, 1], [w2, 1]].sort(),
    );
    for (const r of expected.unlinked) expect((await client.query("select public.unlinked_source_count($1) as n", [r.workspace_id])).rows[0].n).toBe(Number(r.will_be_unlinked));
  });

  it("loses nothing: steps, sources and issue_sources are exactly as they were (a copy, not a move)", async () => {
    expect((await client.query("select * from steps order by revision_id, id")).rows).toEqual(beforeSteps);
    expect((await client.query("select * from sources order by id")).rows).toEqual(beforeSources);
    expect((await client.query("select * from issue_sources order by issue_id, source_id")).rows).toEqual(beforeIssueSources);
  });
});

describe("the rollback in the header", () => {
  let client: pg.Client;
  let name: string;

  beforeAll(async () => {
    name = `transpera_flow_test_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`create database ${name}`);
    await admin.end();
    const url = new URL(ADMIN_URL);
    url.pathname = `/${name}`;
    client = new pg.Client({ connectionString: url.toString() });
    await client.connect();
    await client.query(readFileSync(dir("./sql/auth-shim.sql"), "utf8"));
    for (const f of readdirSync(dir("../supabase/migrations")).filter((f) => f.endsWith(".sql")).sort()) {
      await client.query(readFileSync(dir(`../supabase/migrations/${f}`), "utf8"));
    }
    await client.query("create schema supabase_migrations; create table supabase_migrations.schema_migrations (version text primary key, name text, statements text[])");
    await client.query("insert into supabase_migrations.schema_migrations (version, name) values ('20261124500000', 'source_links')");
  });

  afterAll(async () => {
    await client?.end();
    const a = new pg.Client({ connectionString: ADMIN_URL });
    await a.connect();
    await a.query(`drop database if exists ${name} with (force)`);
    await a.end();
  });

  it("undoes the migration: no table, functions or triggers left, data sources become notes, the narrow check is back", async () => {
    const w = randomUUID();
    await client.query("insert into workspaces (id, name, slug) values ($1, 'Roll Co', 'roll-co')", [w]);
    await client.query("insert into sources (workspace_id, title, kind) values ($1, 'An export', 'data')", [w]);
    await client.query(rollbackSql());
    expect((await client.query("select to_regclass('public.source_links') as t")).rows[0].t).toBeNull();
    expect((await client.query("select count(*)::int as n from pg_proc where proname in ('add_source', 'unlinked_source_count', 'cited_source_ids', 'link_cited_sources', 'link_issue_source', 'source_links_before_insert')")).rows[0].n).toBe(0);
    expect((await client.query("select count(*)::int as n from pg_trigger where tgname in ('link_cited_sources', 'link_issue_source')")).rows[0].n).toBe(0);
    expect((await client.query("select kind from sources where title = 'An export'")).rows[0].kind).toBe("notes");
    await expect(client.query("insert into sources (workspace_id, title, kind) values ($1, 'Another', 'data')", [w])).rejects.toThrow(/sources_kind/);
    expect((await client.query("select count(*)::int as n from supabase_migrations.schema_migrations where version = '20261124500000'")).rows[0].n).toBe(0);
  });
});

describe("migrating the seed's own citations", () => {
  it("a database seeded after the migration has the links a migrated one would: derived from the same citations", () => {
    const derived = northbeamSourceLinks();
    // The audit step cites both sources, discovery the sales notes, the decision the sales notes; the first issue lists the interview.
    expect(derived.filter((l) => l.kind === "step")).toHaveLength(4);
    expect(derived.filter((l) => l.kind === "issue").map((l) => l.source_id)).toEqual([interview]);
    expect(derived.every((l) => l.workspace_id === ws)).toBe(true);
  });

  it("derivedSourceLinks skips sources that are not in the workspace and counts a pair once", () => {
    const step = { id: "s1", workspace_id: ws, process_id: "p1", provenance: { work_hours: { evidence: [{ source_id: interview }, { source_id: interview }] }, wait_hours: { evidence: [{ source_id: "not-a-uuid" }, { source_id: notes }] } } };
    const rows = derivedSourceLinks([step, { ...step, workspace_id: "other" }], [], northbeamSources());
    expect(rows.map((r) => r.source_id).sort()).toEqual([interview, notes].sort());
  });
});

describe("source links", () => {
  let db: TestDb;
  let other: string;
  let otherSource: string;
  const users: Record<string, { id: string; claims: Record<string, unknown> }> = {};
  const process = NORTHBEAM_PROCESS_ID;
  const audit = northbeamStepIds.audit;

  beforeAll(async () => {
    db = await createTestDb();
    other = (await db.client.query("insert into workspaces (name, slug) values ('Other Co', 'other-co') returning id")).rows[0].id;
    otherSource = (await db.client.query("insert into sources (workspace_id, title) values ($1, 'Other interview') returning id", [other])).rows[0].id;
    await db.client.query("insert into source_links (workspace_id, source_id, kind, insight_key) values ($1, $2, 'insight', 'spof:step:abc')", [other, otherSource]);
    for (const role of ["owner", "editor", "member", "viewer"] as const) {
      users[role] = await createUser(db, `${role}@links.example.com`);
      await db.client.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, $3)", [ws, users[role]!.id, role]);
    }
    users.stranger = await createUser(db, "stranger@links.example.com");
  });

  afterAll(async () => {
    await db?.close();
  });

  const fails = async (c: pg.Client, fn: () => Promise<unknown>, re: RegExp) => {
    await c.query("savepoint s");
    await expect(fn()).rejects.toThrow(re);
    await c.query("rollback to savepoint s");
  };
  const link = (c: pg.Client, source: string, target: SourceLinkTarget, workspace = ws) => {
    const k = linkColumns(target);
    return c.query("insert into source_links (workspace_id, source_id, kind, process_id, step_id, insight_key, issue_id, solution_id) values ($1, $2, $3, $4, $5, $6, $7, $8) returning id", [
      workspace,
      source,
      k.kind,
      k.process_id,
      k.step_id,
      k.insight_key,
      k.issue_id,
      k.solution_id,
    ]);
  };
  const newSource = async (c: pg.Client, title = "Fresh notes") => (await c.query("insert into sources (workspace_id, title) values ($1, $2) returning id", [ws, title])).rows[0].id as string;
  const count = async (c: pg.Client) => Number((await c.query("select count(*) from source_links")).rows[0].count);

  it("starts from the seed's citations: the audit's figures cite both sources, and an issue lists the interview", async () => {
    const rows = (await db.client.query("select source_id, kind, step_id, issue_id from source_links where workspace_id = $1 order by kind, source_id, step_id", [ws])).rows;
    expect(rows).toHaveLength(5);
    expect(rows.filter((r) => r.kind === "step").map((r) => `${r.source_id}:${r.step_id}`)).toContain(`${interview}:${audit}`);
    expect(rows.filter((r) => r.kind === "issue")).toEqual([{ source_id: interview, kind: "issue", step_id: null, issue_id: northbeamIssues()[0]!.id }]);
  });

  it("lets everyone in the workspace read its links, and nobody else", async () => {
    for (const role of ["owner", "editor", "member", "viewer"]) {
      await db.as(users[role]!.claims, async (c) => {
        expect(await count(c), role).toBe(5);
      });
    }
    await db.as(users.stranger!.claims, async (c) => {
      expect(await count(c)).toBe(0);
    });
  });

  it("lets owners and editors add and remove links, and not members or viewers", async () => {
    for (const role of ["owner", "editor"]) {
      await db.as(users[role]!.claims, async (c) => {
        const source = await newSource(c);
        const id = (await link(c, source, { kind: "process", processId: process })).rows[0].id;
        await link(c, source, { kind: "step", processId: process, stepId: audit });
        await link(c, source, { kind: "insight", insightKey: "spof:step:abc" });
        await link(c, source, { kind: "issue", issueId: issue });
        expect((await c.query("select count(*) from source_links where source_id = $1", [source])).rows[0].count, role).toBe("4");
        expect((await c.query("delete from source_links where id = $1", [id])).rowCount, role).toBe(1);
      });
    }
    for (const role of ["member", "viewer"]) {
      // The source is made by the superuser: the person under test may not make one.
      const source = (await db.client.query("insert into sources (workspace_id, title) values ($1, 'By an admin') returning id", [ws])).rows[0].id;
      try {
        await db.as(users[role]!.claims, async (c) => {
          await fails(c, () => link(c, source, { kind: "process", processId: process }), /row-level security/);
        });
        const existing = (await db.client.query("select id from source_links where workspace_id = $1 limit 1", [ws])).rows[0].id;
        await db.as(users[role]!.claims, async (c) => {
          expect((await c.query("delete from source_links where id = $1", [existing])).rowCount, role).toBe(0);
        });
      } finally {
        await db.client.query("delete from sources where id = $1", [source]);
      }
    }
  });

  it("keeps people out of other workspaces: a stranger cannot link, and a link cannot cross workspaces", async () => {
    await db.as(users.stranger!.claims, async (c) => {
      await fails(c, () => link(c, interview, { kind: "process", processId: process }), /row-level security/);
    });
    await db.as(users.editor!.claims, async (c) => {
      // A source of another workspace, or a process of another workspace, under this workspace's id.
      await fails(c, () => link(c, otherSource, { kind: "process", processId: process }), /foreign key/);
      const mine = await newSource(c);
      await fails(c, () => link(c, mine, { kind: "issue", issueId: randomUUID() }), /foreign key/);
      // And a link written into the other workspace is refused by RLS, even for an editor here.
      await fails(c, () => link(c, otherSource, { kind: "insight", insightKey: "spof:step:xyz" }, other), /row-level security/);
    });
  });

  it("allows a source to be linked to a target once", async () => {
    await db.as(users.editor!.claims, async (c) => {
      const source = await newSource(c);
      await link(c, source, { kind: "step", processId: process, stepId: audit });
      await fails(c, () => link(c, source, { kind: "step", processId: process, stepId: audit }), /source_links_unique|duplicate key/);
      // The same step for another source, and another step for this one, are fine.
      await link(c, source, { kind: "step", processId: process, stepId: northbeamStepIds.kickoff });
      await link(c, await newSource(c, "Second"), { kind: "step", processId: process, stepId: audit });
    });
  });

  it("checks the shape: one target of the kind, a real insight key, and a step that is in the process", async () => {
    await db.as(users.editor!.claims, async (c) => {
      const source = await newSource(c);
      const raw = (kind: string, cols: Record<string, unknown>) => {
        const names = ["workspace_id", "source_id", "kind", ...Object.keys(cols)];
        return c.query(`insert into source_links (${names.join(", ")}) values (${names.map((_, i) => `$${i + 1}`).join(", ")})`, [ws, source, kind, ...Object.values(cols)]);
      };
      await fails(c, () => raw("process", {}), /source_links_target/);
      await fails(c, () => raw("step", { step_id: audit }), /source_links_target/);
      await fails(c, () => raw("process", { process_id: process, issue_id: issue }), /source_links_target/);
      await fails(c, () => raw("issue", { process_id: process }), /source_links_target/);
      await fails(c, () => raw("document", { process_id: process }), /source_links_kind/);
      await fails(c, () => raw("insight", { insight_key: "not a key" }), /source_links_insight_key_shape/);
      await fails(c, () => link(c, source, { kind: "step", processId: process, stepId: randomUUID() }), /That step is not in that process/);
    });
  });

  it("goes with its source, its process and its issue", async () => {
    const source = (await db.client.query("insert into sources (workspace_id, title) values ($1, 'Doomed') returning id", [ws])).rows[0].id;
    const sourceKept = (await db.client.query("insert into sources (workspace_id, title) values ($1, 'Kept') returning id", [ws])).rows[0].id;
    const doomedIssue = (await db.client.query("insert into issues (workspace_id, type, title) values ($1, 'manual', 'Doomed issue') returning id", [ws])).rows[0].id;
    await link(db.client, source, { kind: "process", processId: process });
    await link(db.client, sourceKept, { kind: "issue", issueId: doomedIssue });
    await db.client.query("delete from sources where id = $1", [source]);
    expect((await db.client.query("select count(*) from source_links where source_id = $1", [source])).rows[0].count).toBe("0");
    await db.client.query("delete from issues where id = $1", [doomedIssue]);
    expect((await db.client.query("select count(*) from source_links where source_id = $1", [sourceKept])).rows[0].count).toBe("0");
    await db.client.query("delete from sources where id = $1", [sourceKept]);
  });

  describe("links follow citations from now on", () => {
    const at = "2026-10-01T09:00:00.000Z";
    const draftOf = async (c: pg.Client) => (await c.query("select public.open_draft($1) as r", [process])).rows[0].r.revision_id as string;
    const linksOf = async (c: pg.Client, source: string) =>
      (await c.query("select kind, step_id, process_id, issue_id from source_links where source_id = $1 order by kind, step_id", [source])).rows;
    const count = async (c: pg.Client) => Number((await c.query("select public.unlinked_source_count($1) as n", [ws])).rows[0].n);

    it("links a source cited in the inspector's way (a per-field save), and the unlinked count drops", async () => {
      await db.as(users.editor!.claims, async (c) => {
        const source = await newSource(c, "Fresh interview");
        expect(await count(c)).toBe(1);
        const rev = await draftOf(c);
        const row = (await c.query("select * from steps where revision_id = $1 and id = $2", [rev, audit])).rows[0] as StepRow;
        const patch = citeEvidence({ ...row, work_hours: Number(row.work_hours) }, "work_hours", { source_id: source, speaker: "Leah", quote: "Six hours.", timestamp: null, value: 6 }, { at, by: users.editor!.id });
        const base = Object.fromEntries(
          Object.keys(patch).map((f) => {
            const [col, sub] = f.split(".") as [keyof StepRow & string, string | undefined];
            const v = (row as unknown as Record<string, unknown>)[col];
            return [f, sub ? ((v as Record<string, unknown> | null)?.[sub] ?? null) : v];
          }),
        );
        const saved = (await c.query("select public.save_fields('steps', $1::jsonb, $2::jsonb, $3::jsonb) as r", [JSON.stringify({ revision_id: rev, id: audit }), JSON.stringify(base), JSON.stringify(patch)])).rows[0].r;
        expect(saved.status).toBe("saved");
        expect(await linksOf(c, source)).toEqual([{ kind: "step", step_id: audit, process_id: process, issue_id: null }]);
        expect(await count(c)).toBe(0);
      });
    });

    it("links a source cited in the MCP server's way (a plain update of the provenance), whatever the id's case", async () => {
      await db.as(users.editor!.claims, async (c) => {
        const source = await newSource(c, "Call notes");
        const rev = await draftOf(c);
        const evidence = JSON.stringify([{ source_id: source.toUpperCase(), speaker: null, quote: "q", timestamp: null, value: 2 }]);
        await c.query("update steps set provenance = provenance || jsonb_build_object('wait_hours', jsonb_build_object('source', 'estimated', 'at', $3::text, 'evidence', $4::jsonb)) where revision_id = $1 and id = $2", [rev, northbeamStepIds.kickoff, at, evidence]);
        expect(await linksOf(c, source)).toEqual([{ kind: "step", step_id: northbeamStepIds.kickoff, process_id: process, issue_id: null }]);
        expect(await count(c)).toBe(0);
      });
    });

    it("links a source that an issue starts to list, and does not undo a link when the citation or the listing goes", async () => {
      await db.as(users.editor!.claims, async (c) => {
        const listed = await newSource(c, "Listed");
        const mine = (await c.query("insert into issues (workspace_id, type, title) values ($1, 'manual', 'Mine') returning id", [ws])).rows[0].id;
        await c.query("insert into issue_sources (issue_id, source_id, workspace_id) values ($1, $2, $3)", [mine, listed, ws]);
        expect(await linksOf(c, listed)).toEqual([{ kind: "issue", step_id: null, process_id: null, issue_id: mine }]);
        await c.query("delete from issue_sources where issue_id = $1", [mine]);
        expect((await linksOf(c, listed)).length, "the link is the person's own statement: it stays").toBe(1);

        const cited = await newSource(c, "Cited then un-cited");
        const rev = await draftOf(c);
        await c.query("update steps set provenance = jsonb_build_object('wait_hours', jsonb_build_object('source', 'estimated', 'at', $3::text, 'evidence', jsonb_build_array(jsonb_build_object('source_id', $4::text)))) where revision_id = $1 and id = $2", [rev, audit, at, cited]);
        expect((await linksOf(c, cited)).length).toBe(1);
        await c.query("update steps set provenance = '{}' where revision_id = $1 and id = $2", [rev, audit]);
        expect((await linksOf(c, cited)).length, "taking a citation away leaves the link").toBe(1);
      });
    });

    it("does nothing when a save leaves the citations as they were, and links again only when something new is cited", async () => {
      await db.as(users.editor!.claims, async (c) => {
        const source = await newSource(c, "Cited once");
        const rev = await draftOf(c);
        const cite = (note: string, ids: string[]) =>
          c.query("update steps set provenance = jsonb_build_object('wait_hours', jsonb_build_object('source', 'estimated', 'at', $3::text, 'note', $5::text, 'evidence', $4::jsonb)) where revision_id = $1 and id = $2", [
            rev,
            audit,
            at,
            JSON.stringify(ids.map((i) => ({ source_id: i }))),
            note,
          ]);
        await cite("first", [source]);
        expect((await linksOf(c, source)).length).toBe(1);
        // The person unlinks it; saving the step again with the same citation must not quietly put it back.
        await c.query("delete from source_links where source_id = $1", [source]);
        await cite("edited note", [source]);
        expect(await linksOf(c, source), "same citations: nothing inserted").toEqual([]);
        // A citation that was already there plus a new one: the new source is linked.
        const another = await newSource(c, "Cited second");
        await cite("third", [source, another]);
        expect((await linksOf(c, another)).length).toBe(1);
      });
    });

    it("ignores a citation of a source that is not there or is another workspace's", async () => {
      await db.as(users.editor!.claims, async (c) => {
        const rev = await draftOf(c);
        const before = await count(c);
        const evidence = JSON.stringify([{ source_id: otherSource }, { source_id: randomUUID() }, { source_id: "nope" }]);
        await c.query("update steps set provenance = jsonb_build_object('wait_hours', jsonb_build_object('source', 'estimated', 'at', $3::text, 'evidence', $4::jsonb)) where revision_id = $1 and id = $2", [rev, audit, at, evidence]);
        expect((await c.query("select count(*)::int as n from source_links where source_id = $1", [otherSource])).rows[0].n).toBe(0);
        expect(await count(c)).toBe(before);
      });
    });
  });

  describe("the data type", () => {
    it("takes a source of kind data, directly and through add_source, and still refuses an unknown kind", async () => {
      await db.as(users.editor!.claims, async (c) => {
        const direct = (await c.query("insert into sources (workspace_id, title, kind) values ($1, 'HubSpot export', 'data') returning kind", [ws])).rows[0].kind;
        expect(direct).toBe("data");
        const id = (await c.query("select public.add_source($1, $2::jsonb, $3::jsonb) as id", [ws, JSON.stringify({ kind: "data", title: "Deals Jan to Aug" }), JSON.stringify([{ kind: "process", process_id: process }])])).rows[0].id;
        expect((await c.query("select kind from sources where id = $1", [id])).rows[0].kind).toBe("data");
        await fails(c, () => c.query("insert into sources (workspace_id, title, kind) values ($1, 'x', 'video')", [ws]), /sources_kind/);
        await fails(c, () => c.query("select public.add_source($1, $2::jsonb, $3::jsonb)", [ws, JSON.stringify({ kind: "video", title: "x" }), JSON.stringify([{ kind: "process", process_id: process }])]), /sources_kind/);
        // The kinds the library adds (migration 20261130500000) go through add_source too.
        for (const kind of ["sop", "spreadsheet", "other"]) {
          const made = (await c.query("select public.add_source($1, $2::jsonb, $3::jsonb) as id", [ws, JSON.stringify({ kind, title: `A ${kind}` }), JSON.stringify([{ kind: "process", process_id: process }])])).rows[0].id;
          expect((await c.query("select kind from sources where id = $1", [made])).rows[0].kind).toBe(kind);
        }
      });
    });
  });

  describe("add_source", () => {
    it("treats the same link named twice as one", async () => {
      await db.as(users.editor!.claims, async (c) => {
        const same = { kind: "step", process_id: process, step_id: audit };
        const id = (await c.query("select public.add_source($1, $2::jsonb, $3::jsonb) as id", [ws, JSON.stringify({ title: "Twice" }), JSON.stringify([same, same, { kind: "process", process_id: process }])])).rows[0].id;
        expect((await c.query("select count(*)::int as n from source_links where source_id = $1", [id])).rows[0].n).toBe(2);
      });
    });

    const add = (c: pg.Client, source: object, links: object[]) => c.query("select public.add_source($1, $2::jsonb, $3::jsonb) as id", [ws, JSON.stringify(source), JSON.stringify(links)]);

    it("saves the source and its links together, and returns the new id", async () => {
      await db.as(users.editor!.claims, async (c) => {
        const id = (
          await add(
            c,
            { kind: "notes", title: "Ops walkthrough", speakers: ["Leah Brooks"], recorded_at: "2026-09-18", body: "Access requests go back and forth." },
            [{ kind: "step", process_id: process, step_id: audit }, { kind: "issue", issue_id: issue }, { kind: "insight", insight_key: "spof:step:abc" }],
          )
        ).rows[0].id;
        const s = (await c.query("select kind, title, speakers, recorded_at::text as day, body from sources where id = $1", [id])).rows[0];
        expect(s).toEqual({ kind: "notes", title: "Ops walkthrough", speakers: ["Leah Brooks"], day: "2026-09-18", body: "Access requests go back and forth." });
        expect((await c.query("select kind from source_links where source_id = $1 order by kind", [id])).rows.map((r) => r.kind)).toEqual(["insight", "issue", "step"]);
      });
    });

    it("refuses a source with no link, with a plain message, and saves nothing", async () => {
      await db.as(users.editor!.claims, async (c) => {
        const before = Number((await c.query("select count(*) from sources")).rows[0].count);
        await fails(c, () => add(c, { title: "No links" }, []), /Link the source to at least one process, step, insight, issue or solution\./);
        await fails(c, () => c.query("select public.add_source($1, '{\"title\": \"x\"}'::jsonb, null)", [ws]), /Link the source to at least one/);
        await fails(c, () => c.query("select public.add_source($1, '{\"title\": \"x\"}'::jsonb, '{}'::jsonb)", [ws]), /Link the source to at least one/);
        expect(Number((await c.query("select count(*) from sources")).rows[0].count)).toBe(before);
      });
    });

    it("saves nothing when one link is bad, or the title is empty", async () => {
      await db.as(users.editor!.claims, async (c) => {
        const before = Number((await c.query("select count(*) from sources")).rows[0].count);
        await fails(c, () => add(c, { title: "Half done" }, [{ kind: "process", process_id: process }, { kind: "step", process_id: process, step_id: randomUUID() }]), /That step is not in that process/);
        await fails(c, () => add(c, { title: "  " }, [{ kind: "process", process_id: process }]), /sources_title_length/);
        await fails(c, () => add(c, { title: "Bad type", kind: "video" }, [{ kind: "process", process_id: process }]), /sources_kind/);
        expect(Number((await c.query("select count(*) from sources")).rows[0].count)).toBe(before);
      });
    });

    it("is refused for a viewer, and for a stranger", async () => {
      for (const who of ["viewer", "stranger"]) {
        await db.as(users[who]!.claims, async (c) => {
          await fails(c, () => add(c, { title: "Nope" }, [{ kind: "process", process_id: process }]), /row-level security/);
        });
      }
    });
  });

  it("counts the sources that are linked to nothing, for what the caller can read", async () => {
    await db.as(users.editor!.claims, async (c) => {
      const n = async () => Number((await c.query("select public.unlinked_source_count($1) as n", [ws])).rows[0].n);
      expect(await n()).toBe(0);
      const a = await newSource(c, "Loose notes");
      await newSource(c, "More loose notes");
      expect(await n()).toBe(2);
      await link(c, a, { kind: "process", processId: process });
      expect(await n()).toBe(1);
    });
    // A stranger sees none of them.
    await db.as(users.stranger!.claims, async (c) => {
      expect(Number((await c.query("select public.unlinked_source_count($1) as n", [ws])).rows[0].n)).toBe(0);
    });
  });
});

describe("an issue's sources are its own list and its source links, once each", () => {
  const a = { issue_id: "i1", source_id: "s1" };
  const b = { issue_id: "i1", source_id: "s2" };
  const c = { issue_id: "i2", source_id: "s1" };

  it("keeps the issue's own list first and adds what only a link says, without repeats", () => {
    expect(unionIssueSources([a], [b, a, c])).toEqual([a, b, c]);
  });

  it("is the list alone when nothing is linked, and the links alone when the list is empty", () => {
    expect(unionIssueSources([a, b], [])).toEqual([a, b]);
    expect(unionIssueSources([], [b])).toEqual([b]);
    expect(unionIssueSources([], [])).toEqual([]);
  });
});
