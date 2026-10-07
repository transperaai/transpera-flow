import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BUNDLE_TABLES, NORTHBEAM_WORKSPACE_ID, WORKSPACE_BUNDLE_FORMAT, bundleJsonChunks, collectAccountIds, exportWorkspaceBundle, scrubDeep, type Row, type TableReader } from "../src";
import type pg from "pg";
import { createTestDb, createUser, type TestDb } from "./harness";

// The JSON workspace bundle export (issue #39, B10 part 1): every entity of the workspace with all versions, only for people
// who can read the workspace, nothing of another workspace, no emails, tokens or authors.

let db: TestDb;
const ws = NORTHBEAM_WORKSPACE_ID;

beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db?.close();
});

/** Reads as `claims` under RLS: what the app's Supabase client does. */
async function exportAs(claims: Record<string, unknown> | null, workspaceId = ws, canEdit = true) {
  return db.as(claims, async (c) => {
    const read: TableReader = async (table, wsId) => {
      const spec = Object.values(BUNDLE_TABLES).find((t) => t.table === table)!;
      return (await c.query(`select ${spec.columns ?? "*"} from public.${table} where workspace_id = $1 order by ${spec.order.join(", ")}`, [wsId])).rows as Row[];
    };
    const readWorkspace = async (id: string) => (await c.query("select id, name, slug, plan, settings, provenance from workspaces where id = $1", [id])).rows[0] ?? null;
    return exportWorkspaceBundle(workspaceId, readWorkspace, read, { canEdit, now: new Date("2026-10-05T12:00:00Z") });
  });
}

async function member(email: string, role: string) {
  const user = await createUser(db, email);
  await db.client.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, $3)", [ws, user.id, role]);
  return user;
}

const keysDeep = (v: unknown, out = new Set<string>()): Set<string> => {
  if (Array.isArray(v)) v.forEach((x) => keysDeep(x, out));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) {
    out.add(k);
    keysDeep(x, out);
  }
  return out;
};

describe("workspace bundle export", () => {
  it("holds every entity of the workspace with a format version, and all versions of every process", async () => {
    const editor = await member("bundle.editor@northbeam.example", "editor");
    const b = await exportAs(editor.claims);
    expect(b).not.toBeNull();
    expect(b!.format).toBe(WORKSPACE_BUNDLE_FORMAT);
    expect(b!.workspace.id).toBe(ws);
    const total = async (t: string) => Number((await db.client.query(`select count(*) from public.${t} where workspace_id = $1`, [ws])).rows[0].count);
    expect(b!.processes.length).toBe(await total("processes"));
    expect(b!.counts.process_versions).toBe(await total("process_revisions"));
    expect(b!.counts.steps).toBe(await total("steps"));
    expect(b!.counts.edges).toBe(await total("edges"));
    expect(b!.issues.length).toBe(await total("issues"));
    expect(b!.sources.length).toBe(await total("sources"));
    expect(b!.company_model.roles!.length).toBe(await total("roles"));
    expect(b!.company_model.people!.length).toBe(await total("people"));
    expect(b!.company_model.client_groups!.length).toBe(await total("client_groups"));
    // The company map is a process with versions too.
    const company = b!.processes.find((p) => p.is_company);
    expect(company).toBeTruthy();
    expect((company!.versions as Row[]).length).toBeGreaterThan(0);
    // Each version carries its own steps and edges; the live one is marked.
    const withLive = b!.processes.filter((p) => (p.versions as Row[]).some((v) => v.live));
    expect(withLive.length).toBeGreaterThan(0);
    const live = (withLive[0]!.versions as Row[]).find((v) => v.live)!;
    expect((live.steps as Row[]).length).toBeGreaterThan(0);
  });

  it("keeps named clients, flagged hidden", async () => {
    const viewer = await member("bundle.clients@northbeam.example", "viewer");
    const b = await exportAs(viewer.claims);
    const n = Number((await db.client.query("select count(*) from clients where workspace_id = $1", [ws])).rows[0].count);
    expect(b!.company_model.clients!.length).toBe(n);
    expect(b!.company_model.clients!.every((c) => c.hidden === true)).toBe(true);
  });

  it("lets a viewer export what they can read, and nobody else", async () => {
    const viewer = await member("bundle.viewer@northbeam.example", "viewer");
    expect(await exportAs(viewer.claims)).not.toBeNull();
    const stranger = await createUser(db, "bundle.stranger@elsewhere.example");
    expect(await exportAs(stranger.claims)).toBeNull();
    expect(await exportAs(null)).toBeNull();
  });

  it("never holds another workspace's rows", async () => {
    // A second workspace with a row in a table of every kind a bundle reads would be ideal; two is enough to show the filter.
    const other = "00000000-0000-4000-8000-0000000000b1";
    await db.client.query("insert into workspaces (id, name, slug) values ($1, 'Other Co', 'other-co-bundle')", [other]);
    await db.client.query("insert into roles (workspace_id, name, color) values ($1, 'Secret role', '#000000')", [other]);
    await db.client.query("insert into sources (workspace_id, kind, title, body) values ($1, 'notes', 'Secret source', 'secret body')", [other]);
    const editor = await member("bundle.isolation@northbeam.example", "editor");
    const b = await exportAs(editor.claims);
    const text = JSON.stringify(b);
    expect(text).not.toContain("Secret role");
    expect(text).not.toContain("Secret source");
    expect(text).not.toContain("Other Co");
    // A reader that leaked a foreign row (a policy mistake) is still filtered.
    const leaky = await db.as(editor.claims, async (c) => {
      const read: TableReader = async (table) => (await c.query(`select ${Object.values(BUNDLE_TABLES).find((x) => x.table === table)!.columns ?? "*"} from public.${table} where workspace_id in ($1, $2)`, [ws, other])).rows as Row[];
      return exportWorkspaceBundle(ws, async (id) => (await c.query("select id, name, slug, plan, settings, provenance from workspaces where id = $1", [id])).rows[0] ?? null, read, { canEdit: true });
    });
    expect(JSON.stringify(leaky)).not.toContain("Secret role");
  });

  it("leaves out emails, members, authors and tokens", async () => {
    const editor = await member("bundle.secrets@northbeam.example", "editor");
    await db.client.query("update people set email = 'someone.private@northbeam.example' where id = (select id from people where workspace_id = $1 limit 1)", [ws]);
    const b = await exportAs(editor.claims);
    const text = JSON.stringify(b);
    expect(text).not.toContain("@northbeam.example");
    expect(text).not.toContain("someone.private");
    const keys = keysDeep(b);
    for (const k of ["created_by", "published_by", "reviewed_by", "user_id", "email", "proposer_email", "actor", "by"]) expect(keys.has(k), k).toBe(false);
    for (const k of ["memberships", "api_tokens", "token_hash", "workspace_access_emails", "workspace_domains", "link_hash"]) expect(keys.has(k), k).toBe(false);
    expect(text).not.toContain(editor.id);
  });

  it("holds no account id anywhere, after an editor edits an issue, confirms a step value, accepts a suggestion and changes a setting", async () => {
    const owner = await member("bundle.owner@northbeam.example", "owner");
    const other = await member("bundle.other@northbeam.example", "editor");
    const as = async <T>(claims: Record<string, unknown>, fn: (c: pg.Client) => Promise<T>): Promise<T> => {
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
    };
    const proc = (await db.client.query("select id, live_revision_id from processes where workspace_id = $1 and not is_company and live_revision_id is not null limit 1", [ws])).rows[0];
    const ads = (await db.client.query("select id from lead_sources where workspace_id = $1 limit 1", [ws])).rows[0].id;
    await as(owner.claims, async (c) => {
      // An issue edited (its history records who), a workspace setting changed (provenance records who).
      const issue = (await c.query("select id from issues where workspace_id = $1 limit 1", [ws])).rows[0].id;
      await c.query("update issues set evidence = 'Seen on the call' where id = $1", [issue]);
      await c.query("update workspaces set settings = settings || '{\"currency\": \"EUR\"}'::jsonb where id = $1", [ws]);
      // A step value confirmed on a draft, as the editor writes it (provenance carries `by`).
      const draft = (await c.query("select public.open_draft($1) as r", [proc.id])).rows[0].r;
      const rev = draft.revision_id ?? draft.id ?? (await c.query("select draft_revision_id from processes where id = $1", [proc.id])).rows[0].draft_revision_id;
      await c.query(
        "update steps set provenance = jsonb_build_object('work_hours', jsonb_build_object('source', 'entered', 'by', $1::text, 'at', now())) where revision_id = $2 and id = (select id from steps where revision_id = $2 and kind = 'task' limit 1)",
        [owner.id, rev],
      );
      // A suggestion accepted.
      const s = (await c.query("insert into suggestions (workspace_id, target_table, target_id, patch, evidence) values ($1, 'lead_sources', $2, '{\"set\": {\"volume_week\": 33}}', '[]') returning id", [ws, ads])).rows[0].id;
      await c.query("select public.review_suggestions($1::uuid[], 'accept', 'ok')", [[s]]);
    });
    // The ids really are in the database, in the places that matter: the test can fail.
    const raw = async (sql: string) => Number((await db.client.query(sql, [owner.id])).rows[0].n);
    expect(await raw("select count(*) n from issue_events where actor = $1")).toBeGreaterThan(0);
    expect(await raw("select count(*) n from workspaces where provenance::text like '%' || $1 || '%'")).toBeGreaterThan(0);
    expect(await raw("select count(*) n from steps where provenance::text like '%' || $1 || '%'")).toBeGreaterThan(0);
    expect(await raw("select count(*) n from lead_sources where provenance::text like '%' || $1 || '%'")).toBeGreaterThan(0);
    expect(await raw("select count(*) n from suggestions where reviewed_by = $1")).toBeGreaterThan(0);

    const b = await exportAs(owner.claims);
    const text = JSON.stringify(b);
    for (const u of [owner.id, other.id]) expect(text.toLowerCase()).not.toContain(u.toLowerCase());
    // And no user in the database at all.
    const users = (await db.client.query("select id from auth.users")).rows.map((r) => String(r.id).toLowerCase());
    for (const u of users) expect(text.toLowerCase(), u).not.toContain(u);
    // What is not an account stays: the issue's history is there, without who.
    const issue = b!.issues.find((i) => (i.events as Row[]).length > 0)!;
    expect((issue.events as Row[])[0]).toHaveProperty("kind");
    expect((issue.events as Row[])[0]).not.toHaveProperty("actor");
  });

  it("gives a viewer what is published, and an editor everything: drafts and pending suggestions", async () => {
    const editor = await member("bundle.scope.editor@northbeam.example", "editor");
    const viewer = await member("bundle.scope.viewer@northbeam.example", "viewer");
    const proc = (await db.client.query("select id from processes where workspace_id = $1 and not is_company and live_revision_id is not null limit 1", [ws])).rows[0].id;
    // A draft and a pending suggestion exist (made as the database owner; the export is what is under test).
    await db.client.query("select set_config('request.jwt.claims', $1, false)", [JSON.stringify(editor.claims)]);
    await db.client.query("set role authenticated");
    await db.client.query("select public.open_draft($1)", [proc]);
    await db.client.query("insert into suggestions (workspace_id, target_table, target_id, patch, evidence) select $1, 'lead_sources', id, '{\"set\": {\"volume_week\": 77}}', '[]' from lead_sources where workspace_id = $1 limit 1", [ws]);
    await db.client.query("reset role");
    const drafts = (b: NonNullable<Awaited<ReturnType<typeof exportAs>>>) => b.processes.flatMap((p) => p.versions as Row[]).filter((v) => v.status === "draft");
    const all = (await exportAs(editor.claims, ws, true))!;
    expect(all.scope).toBe("everything");
    expect(drafts(all).length).toBeGreaterThan(0);
    expect(all.suggestions.some((s) => s.status === "pending")).toBe(true);
    const v = (await exportAs(viewer.claims, ws, false))!;
    expect(v.scope).toBe("published");
    expect(drafts(v)).toHaveLength(0);
    expect(v.suggestions).toHaveLength(0);
    expect(v.suggestion_proposals).toHaveLength(0);
    // Nothing of a draft's steps or edges either, and no process points at one.
    const kept = new Set(v.processes.flatMap((p) => (p.versions as Row[]).map((x) => x.id)));
    expect(v.counts.steps).toBe(v.processes.reduce((n, p) => n + (p.versions as Row[]).reduce((m, x) => m + (x.steps as Row[]).length, 0), 0));
    expect(v.processes.every((p) => p.draft_revision_id === null)).toBe(true);
    expect(kept.size).toBeLessThan(all.counts.process_versions! + 1);
    expect(v.counts.process_versions).toBeLessThan(all.counts.process_versions!);
  });

  it("is deterministic plain JSON: the same workspace gives the same text", async () => {
    const editor = await member("bundle.json@northbeam.example", "editor");
    const a = JSON.stringify(await exportAs(editor.claims));
    const b = JSON.stringify(await exportAs(editor.claims));
    expect(a).toBe(b);
    expect(a.length).toBeGreaterThan(1000);
  });
});

describe("scrubbing", () => {
  it("drops account keys at any depth and the ids they held, and keeps what is not an account", () => {
    const id = "3b241101-e2bb-4255-8caf-4136c566a962";
    const row = { id: "r1", created_by: id, replaced_by: ["s2"], provenance: { work_hours: { source: "entered", by: id, at: "x", evidence: [{ quote: "q", actor: id }] } }, detail: { agreed_by: "p1", note: id, list: [id, "keep"] } };
    const ids = collectAccountIds(row);
    expect([...ids]).toEqual([id]);
    const out = scrubDeep(row, ids);
    expect(JSON.stringify(out)).not.toContain(id);
    expect(out).toEqual({ id: "r1", replaced_by: ["s2"], provenance: { work_hours: { source: "entered", at: "x", evidence: [{ quote: "q" }] } }, detail: { agreed_by: "p1", list: ["keep"] } });
  });

  it("matches by_ names and suffixes without case", () => {
    expect(scrubDeep({ Updated_By: "x", edited_by_name: "y", resolved_by: "z", reviewedBy: "k", keep_this: 1 })).toEqual({ reviewedBy: "k", keep_this: 1 });
  });

  it("exports per-person times (C6) for those who can read them: a default and a step, the default first; a viewer's export has none", async () => {
    const persons = (await db.client.query("select id from people where workspace_id = $1 order by id limit 2", [ws])).rows.map((r) => r.id as string);
    const step = (await db.client.query("select id from steps where workspace_id = $1 order by id limit 1", [ws])).rows[0].id as string;
    await db.client.query("insert into person_capacity_factors (person_id, workspace_id, step_id, factor) values ($1, $3, $2, 1.2), ($1, $3, null, 0.9), ($4, $3, null, 1.1)", [persons[0], step, ws, persons[1]]);
    try {
      const editor = await member("bundle.factors@northbeam.example", "editor");
      const b = (await exportAs(editor.claims))!;
      const rows = b.company_model.person_capacity_factors!;
      expect(rows).toHaveLength(3);
      expect(b.counts["company_model.person_capacity_factors"]).toBe(3);
      // Ordered by person, then step with the default (null) last in the stable paging order the database gives.
      const own = rows.filter((r) => r.person_id === persons[0]);
      expect(own.map((r) => r.step_id)).toEqual([step, null]);
      expect(rows.map((r) => Number(r.factor)).sort()).toEqual([0.9, 1.1, 1.2]);
      // A viewer linked to nobody reads none through RLS, so their export holds none.
      const viewer = await member("bundle.factors.viewer@northbeam.example", "viewer");
      const v = (await exportAs(viewer.claims, ws, false))!;
      expect(v.company_model.person_capacity_factors).toEqual([]);
    } finally {
      await db.client.query("delete from person_capacity_factors");
    }
  });

  it("sends the JSON in pieces that join to the same text", async () => {
    const editor = await member("bundle.chunks@northbeam.example", "editor");
    const b = (await exportAs(editor.claims))!;
    const chunks = [...bundleJsonChunks(b)];
    expect(chunks.length).toBeGreaterThan(50);
    expect(chunks.join("")).toBe(JSON.stringify(b));
    expect(chunks.join("")).not.toMatch(/\n\s/);
  });
});
