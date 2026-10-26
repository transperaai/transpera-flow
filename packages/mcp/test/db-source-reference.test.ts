import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateApiToken, type McpHandlerOptions } from "../src";
import { call, connect, startTestDb, type McpTestDb } from "./helpers";

// A source's original is a link (step 4 of the move off Supabase): `add_source` takes `file_url`, the database keeps it beside the
// pasted text, and `list_sources` returns it to everyone who can read the workspace. Nothing is uploaded over MCP. A source's
// link is changed in the app (there is no update_source tool). Its own database, so the rate limit of a token is its own.

let env: McpTestDb;
let admin: pg.Client;
let options: McpHandlerOptions;
let workspaceId: string;
let editorToken: string;
let viewerToken: string;

async function member(email: string, role: string) {
  const id = randomUUID();
  await admin.query("insert into auth.users (id, email) values ($1, $2)", [id, email]);
  await admin.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, $3)", [workspaceId, id, role]);
  const { token, hash } = generateApiToken();
  await admin.query("insert into api_tokens (user_id, token_hash, label) values ($1, $2, 'e2e')", [id, hash]);
  return token;
}

const LINK = "https://drive.google.com/file/d/abc123/view";

beforeAll(async () => {
  env = await startTestDb();
  admin = env.t.client;
  options = env.options;
  workspaceId = (await admin.query("insert into workspaces (name, slug) values ('Reference Co', 'reference-co') returning id")).rows[0].id;
  await admin.query("insert into processes (workspace_id, name, kind, entity_name) values ($1, 'Sales pipeline', 'pipeline', 'lead')", [workspaceId]);
  editorToken = await member("reference-editor@example.com", "editor");
  viewerToken = await member("reference-viewer@example.com", "viewer");
});

afterAll(async () => {
  await env?.close();
});

describe("MCP sources with a link to the original", () => {
  it("add_source keeps the link beside the text, and a source without one has none", async () => {
    const editor = await connect(editorToken, options);
    const made = await call<{ source: { id: string; file_url: string | null; body_length: number } }>(editor, "add_source", {
      title: "Onboarding SOP",
      kind: "sop",
      body: "1. Send the welcome pack.",
      file_url: LINK,
      links: [{ process: "Sales pipeline" }],
    });
    expect(made.ok, JSON.stringify(made)).toBe(true);
    expect(made.data.source).toMatchObject({ file_url: LINK, body_length: 25 });
    expect((await admin.query("select file_url, body from sources where id = $1", [made.data.source.id])).rows).toEqual([{ file_url: LINK, body: "1. Send the welcome pack." }]);
    // The same with link_later (no links yet).
    const later = await call<{ source: { id: string; file_url: string | null } }>(editor, "add_source", { title: "Recording", kind: "transcript", file_url: "https://www.notion.so/team/Recording-1", link_later: true });
    expect(later.data.source.file_url).toBe("https://www.notion.so/team/Recording-1");
    const plain = await call<{ source: { file_url: string | null } }>(editor, "add_source", { title: "Pasted notes", body: "Rosa said so.", links: [{ process: "Sales pipeline" }] });
    expect(plain.data.source.file_url).toBeNull();
    await editor.close();
  });

  it("refuses anything that isn't a web address, and adds nothing", async () => {
    const editor = await connect(editorToken, options);
    const before = (await admin.query("select count(*)::int n from sources where workspace_id = $1", [workspaceId])).rows[0].n as number;
    for (const bad of ["drive.google.com/file/1", "ftp://example.com/x", "javascript:alert(1)", "https://example.com/has space", `https://example.com/${"a".repeat(2000)}`]) {
      const out = await editor.callTool({ name: "add_source", arguments: { title: "Bad link", file_url: bad, links: [{ process: "Sales pipeline" }] } }).catch((e: Error) => e);
      const text = out instanceof Error ? out.message : JSON.stringify(out);
      expect(text, bad).toMatch(/file_url|invalid|pattern|too_big|Too big/i);
    }
    expect((await admin.query("select count(*)::int n from sources where workspace_id = $1", [workspaceId])).rows[0].n).toBe(before);
    await editor.close();
  });

  it("list_sources returns each source's link, to a viewer as well; a viewer can't add one", async () => {
    const viewer = await connect(viewerToken, options);
    const listed = await call<{ sources: { title: string; file_url: string | null; text: string }[] }>(viewer, "list_sources", { limit: 200 });
    expect(listed.ok, JSON.stringify(listed)).toBe(true);
    const byTitle = Object.fromEntries(listed.data.sources.map((s) => [s.title, s.file_url]));
    expect(byTitle["Onboarding SOP"]).toBe(LINK);
    expect(byTitle["Recording"]).toBe("https://www.notion.so/team/Recording-1");
    expect(byTitle["Pasted notes"]).toBeNull();
    expect(listed.data.sources.find((s) => s.title === "Onboarding SOP")?.text).toBe("1. Send the welcome pack.");
    const denied = await call(viewer, "add_source", { title: "Viewer's", file_url: LINK, links: [{ process: "Sales pipeline" }] });
    expect(denied.ok).toBe(false);
    expect((await admin.query("select 1 from sources where title = 'Viewer''s'")).rowCount).toBe(0);
    await viewer.close();
  });
});
