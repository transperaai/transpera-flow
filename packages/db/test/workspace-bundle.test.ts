import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BUNDLE_TABLES, NEVER_EXPORTED, NORTHBEAM_WORKSPACE_ID, WORKSPACE_BUNDLE_FORMAT, exportWorkspaceBundle, type Row, type TableReader } from "../src";
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
async function exportAs(claims: Record<string, unknown> | null, workspaceId = ws) {
  return db.as(claims, async (c) => {
    const read: TableReader = async (table, wsId) => {
      const spec = Object.values(BUNDLE_TABLES).find((t) => t.table === table)!;
      return (await c.query(`select ${spec.columns ?? "*"} from public.${table} where workspace_id = $1 order by ${spec.order.join(", ")}`, [wsId])).rows as Row[];
    };
    const readWorkspace = async (id: string) => (await c.query("select id, name, slug, plan, settings, provenance from workspaces where id = $1", [id])).rows[0] ?? null;
    return exportWorkspaceBundle(workspaceId, readWorkspace, read, new Date("2026-10-05T12:00:00Z"));
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
      return exportWorkspaceBundle(ws, async (id) => (await c.query("select id, name, slug, plan, settings, provenance from workspaces where id = $1", [id])).rows[0] ?? null, read);
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
    for (const k of NEVER_EXPORTED) expect(keys.has(k), k).toBe(false);
    for (const k of ["memberships", "api_tokens", "token_hash", "workspace_access_emails", "workspace_domains", "link_hash"]) expect(keys.has(k), k).toBe(false);
    expect(text).not.toContain(editor.id);
  });

  it("is deterministic plain JSON: the same workspace gives the same text", async () => {
    const editor = await member("bundle.json@northbeam.example", "editor");
    const a = JSON.stringify(await exportAs(editor.claims));
    const b = JSON.stringify(await exportAs(editor.claims));
    expect(a).toBe(b);
    expect(a.length).toBeGreaterThan(1000);
  });
});
