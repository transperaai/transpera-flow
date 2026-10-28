import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateApiToken, type McpHandlerOptions } from "../src";
import { call, connect, startTestDb, type McpTestDb } from "./helpers";

// The QA workspace scripts (docs/extraction/qa, issue #27): `setup-workspace.sql` makes the Copperleaf Marketing (QA) workspace
// the interview pack is read against, and `reset-workspace.sql` removes it again. An agency admin gets the membership, and MCP
// reads it (get_workspace_summary). Runs on a throwaway database (test/helpers.ts). (This was the end of db-extraction.test.ts,
// which replayed an extraction through MCP's write tools; MCP is read-only now, docs/plans/cut-list.md item 5.)

let env: McpTestDb;
let admin: pg.Client;
let options: McpHandlerOptions;

describe("the QA workspace scripts", () => {
  beforeAll(async () => {
    env = await startTestDb();
    admin = env.t.client;
    options = env.options;
  });

  afterAll(async () => {
    await env?.close();
  });

  it("the QA workspace scripts set up, reset and rerun cleanly (no extraction is run on the QA transcripts)", async () => {
    const sql = (name: string) => readFileSync(new URL(`../../../docs/extraction/qa/${name}`, import.meta.url), "utf8");
    const qa = async () => (await admin.query("select id from workspaces where slug = 'copperleaf-qa'")).rows as { id: string }[];
    await admin.query(sql("reset-workspace.sql"));

    // An agency admin, with a token and no email address, gets the membership.
    const adminId = randomUUID();
    await admin.query("insert into auth.users (id, raw_app_meta_data) values ($1, '{\"agency_admin\": true}')", [adminId]);
    const { token, hash } = generateApiToken();
    await admin.query("insert into api_tokens (user_id, token_hash, label) values ($1, $2, 'e2e-qa')", [adminId, hash]);

    await admin.query(sql("setup-workspace.sql"));
    const [ws] = await qa();
    expect((await admin.query("select role from memberships where workspace_id = $1 and user_id = $2", [ws!.id, adminId])).rows).toEqual([{ role: "agency_admin" }]);
    // The slug guard: a second run fails and changes nothing.
    await expect(admin.query(sql("setup-workspace.sql"))).rejects.toThrow(/already exists/);
    await admin.query("rollback"); // the script's own begin is still open on this connection, as in an editor tab
    expect(await qa()).toHaveLength(1);

    const client = await connect(token, options);
    const summary = await call<{ workspace: { settings: { hours_per_week: number } }; roles: { name: string }[]; people: { name: string }[]; processes: unknown[] }>(
      client,
      "get_workspace_summary",
      { workspace: "copperleaf-qa" },
    );
    expect(summary.ok, JSON.stringify(summary.error)).toBe(true);
    expect(summary.data.workspace.settings.hours_per_week).toBe(37.5);
    expect(summary.data.roles.map((r) => r.name)).toEqual(["Account director", "Finance", "Managing director", "Paid media specialist"]);
    expect(summary.data.people.map((p) => p.name)).toEqual(["Ellie Marsh", "Grace Adeyemi", "Kofi Mensah", "Nadia Sharp", "Tom Whitfield"]);
    await client.close();
    // Content of its own, so the reset has a process to clear.
    await admin.query("insert into processes (workspace_id, name, kind, entity_name) values ($1, 'Reset check', 'pipeline', 'lead')", [ws!.id]);

    // Other test files run in parallel on the same database and add and delete workspaces of their own meanwhile, so the
    // reset is checked against workspaces nobody else touches: a sentinel made here, and the seeded samples if loaded. The
    // reset must leave them in place (and remove only copperleaf-qa).
    const sentinel = randomUUID();
    await admin.query("insert into workspaces (id, name, slug) values ($1, 'Reset sentinel', $2)", [sentinel, `reset-sentinel-${sentinel.slice(0, 8)}`]);
    const kept = async () =>
      new Set(
        ((await admin.query("select id from workspaces where id = $1 or slug in ('northbeam', 'larkspur')", [sentinel])).rows as { id: string }[]).map(
          (r) => r.id,
        ),
      );
    const before = await kept();
    expect(before.has(sentinel)).toBe(true);
    await admin.query(sql("reset-workspace.sql"));
    expect(await qa()).toHaveLength(0);
    const after = await kept();
    expect([...before].filter((id) => !after.has(id))).toEqual([]);
    await admin.query("delete from workspaces where id = $1", [sentinel]);
    // ...and it creates none: anything new since `before` came from another test file, never from the QA scripts.
    expect((await admin.query("select count(*)::int as n from workspaces where slug like 'copperleaf%'")).rows[0].n).toBe(0);
    expect((await admin.query("select 1 from people where name = 'Grace Adeyemi'")).rowCount).toBe(0);

    // It can be rerun, and reset again; resetting when there is nothing to remove is harmless.
    await admin.query(sql("setup-workspace.sql"));
    expect(await qa()).toHaveLength(1);
    await admin.query(sql("reset-workspace.sql"));
    await admin.query(sql("reset-workspace.sql"));
    expect(await qa()).toHaveLength(0);
    await admin.query("delete from api_tokens where user_id = $1", [adminId]);
    await admin.query("delete from auth.users where id = $1", [adminId]);
  });
});
