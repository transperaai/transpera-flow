import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateApiToken, type McpHandlerOptions } from "../src";
import { call, connect, startTestDb, type McpTestDb } from "./helpers";

// A source's original is a link (step 4 of the move off Supabase): the database keeps it beside the pasted text, refuses anything
// that isn't a web address, and `list_sources` returns it to everyone who can read the workspace. Nothing is uploaded over MCP, and
// MCP adds no source (it is read-only, docs/plans/cut-list.md item 5): a source's link is set in the app. Its own database, so the
// rate limit of a token is its own.

let env: McpTestDb;
let admin: pg.Client;
let options: McpHandlerOptions;
let workspaceId: string;
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
  viewerToken = await member("reference-viewer@example.com", "viewer");
});

afterAll(async () => {
  await env?.close();
});

describe("sources with a link to the original", () => {
  it("the database keeps the link beside the text, and a source without one has none", async () => {
    await admin.query("insert into sources (workspace_id, title, kind, body, file_url) values ($1, 'Onboarding SOP', 'sop', '1. Send the welcome pack.', $2)", [workspaceId, LINK]);
    await admin.query("insert into sources (workspace_id, title, kind, file_url) values ($1, 'Recording', 'transcript', 'https://www.notion.so/team/Recording-1')", [workspaceId]);
    await admin.query("insert into sources (workspace_id, title, kind, body) values ($1, 'Pasted notes', 'notes', 'Rosa said so.')", [workspaceId]);
    expect((await admin.query("select file_url, body from sources where title = 'Onboarding SOP'")).rows).toEqual([{ file_url: LINK, body: "1. Send the welcome pack." }]);
    expect((await admin.query("select file_url from sources where title = 'Pasted notes'")).rows).toEqual([{ file_url: null }]);
  });

  it("refuses anything that isn't a web address, and adds nothing", async () => {
    const before = (await admin.query("select count(*)::int n from sources where workspace_id = $1", [workspaceId])).rows[0].n as number;
    for (const bad of ["drive.google.com/file/1", "ftp://example.com/x", "javascript:alert(1)", "https://example.com/has space", `https://example.com/${"a".repeat(2000)}`]) {
      await expect(admin.query("insert into sources (workspace_id, title, kind, file_url) values ($1, 'Bad link', 'other', $2)", [workspaceId, bad]), bad).rejects.toMatchObject({ code: "23514" });
    }
    expect((await admin.query("select count(*)::int n from sources where workspace_id = $1", [workspaceId])).rows[0].n).toBe(before);
  });

  it("list_sources returns each source's link, to a viewer as well; there is no tool to add one", async () => {
    const viewer = await connect(viewerToken, options);
    const listed = await call<{ sources: { title: string; file_url: string | null; text: string }[] }>(viewer, "list_sources", { limit: 200 });
    expect(listed.ok, JSON.stringify(listed)).toBe(true);
    const byTitle = Object.fromEntries(listed.data.sources.map((s) => [s.title, s.file_url]));
    expect(byTitle["Onboarding SOP"]).toBe(LINK);
    expect(byTitle["Recording"]).toBe("https://www.notion.so/team/Recording-1");
    expect(byTitle["Pasted notes"]).toBeNull();
    expect(listed.data.sources.find((s) => s.title === "Onboarding SOP")?.text).toBe("1. Send the welcome pack.");
    const tools = (await viewer.listTools()).tools.map((t) => t.name);
    expect(tools).not.toContain("add_source");
    await viewer.close();
  });
});
