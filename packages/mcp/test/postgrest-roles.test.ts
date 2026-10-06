import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateApiToken } from "../src";
import { signJwt } from "./helpers";

// Keeping an owner (issue #30, B1 part 1; migration 20261206000000), as an API token reaches it: the request carries `x-api-token`
// on an anonymous JWT, the pre-request hook switches the transaction to `authenticated` with the token owner's claims, and the guard
// (which reads `current_user`) must fire there and not for the SECURITY DEFINER reconciliation behind it. Skipped unless POSTGREST_URL is set (see postgrest-db.ts).

const POSTGREST_URL = process.env.POSTGREST_URL;
const JWT_SECRET = process.env.POSTGREST_JWT_SECRET ?? "";
const ADMIN_URL = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/postgres";
const DATABASE_NAME = process.env.POSTGREST_DATABASE ?? "transpera_flow_postgrest";

let admin: pg.Client;
const one = async (sql: string, params: unknown[] = []) => (await admin.query(sql, params)).rows[0] as Record<string, unknown>;

let ws = "";
const users = { owner: "", second: "", editor: "", agency: "" };
const tokens = { second: "" };
let owner: SupabaseClient;
let editor: SupabaseClient;
let agency: SupabaseClient;

/** An API token's client: an anonymous JWT plus `x-api-token`, as the MCP server sends it. */
function client(apiToken: string): SupabaseClient {
  const anon = signJwt({ role: "anon", iss: "test" }, JWT_SECRET);
  return createClient("http://postgrest.invalid", anon, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      headers: { authorization: `Bearer ${anon}`, "x-api-token": apiToken },
      fetch: (input, init) => fetch(String(input instanceof Request ? input.url : input).replace("http://postgrest.invalid/rest/v1", POSTGREST_URL!), init),
    },
  });
}

describe.skipIf(!POSTGREST_URL)("keeping an owner over PostgREST", () => {
  beforeAll(async () => {
    const url = new URL(ADMIN_URL);
    url.pathname = `/${DATABASE_NAME}`;
    admin = new pg.Client({ connectionString: url.toString() });
    await admin.connect();
    const tag = randomUUID().slice(0, 8);
    ws = (await one("insert into workspaces (name, slug) values ('Roles Co', $1) returning id", [`roles-${tag}`])).id as string;
    for (const k of Object.keys(users) as (keyof typeof users)[]) {
      users[k] = randomUUID();
      await admin.query("insert into auth.users (id, email, raw_app_meta_data) values ($1, $2, $3)", [
        users[k],
        `roles-${k}-${tag}@example.com`,
        k === "agency" ? { agency_admin: true } : {},
      ]);
    }
    await admin.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, 'owner'), ($1, $3, 'editor')", [ws, users.owner, users.editor]);
    const issue = async (userId: string) => {
      const { token, hash } = generateApiToken();
      await admin.query("insert into api_tokens (user_id, token_hash, label) values ($1, $2, 'roles')", [userId, hash]);
      return token;
    };
    owner = client(await issue(users.owner));
    editor = client(await issue(users.editor));
    agency = client(await issue(users.agency));
    tokens.second = await issue(users.second);
    const deadline = Date.now() + 60_000;
    while ((await owner.from("workspaces").select("id").eq("id", ws)).data?.length !== 1) {
      if (Date.now() > deadline) throw new Error("PostgREST never became ready");
      await new Promise((r) => setTimeout(r, 1000));
    }
  });

  afterAll(async () => {
    if (ws) {
      await admin.query("delete from workspaces where id = $1", [ws]);
      await admin.query("delete from audit_log where workspace_id = $1", [ws]);
    }
    await admin?.end();
  });

  const role = async (userId: string) => (await one("select role, active from memberships where workspace_id = $1 and user_id = $2", [ws, userId])) as { role: string; active: boolean } | undefined;

  it("refuses an owner's token demoting, deactivating or removing the last owner, with the guard's message", async () => {
    const demote = await owner.from("memberships").update({ role: "editor" }).eq("workspace_id", ws).eq("user_id", users.owner).select("id");
    expect(demote.error?.message).toMatch(/workspace_keeps_an_owner/);
    expect(demote.error?.code).toBe("23514");
    const off = await owner.from("memberships").update({ active: false }).eq("workspace_id", ws).eq("user_id", users.owner).select("id");
    expect(off.error?.message).toMatch(/workspace_keeps_an_owner/);
    const gone = await owner.from("memberships").delete().eq("workspace_id", ws).eq("user_id", users.owner).select("id");
    expect(gone.error?.message).toMatch(/workspace_keeps_an_owner/);
    expect(await role(users.owner)).toEqual({ role: "owner", active: true });
  });

  it("lets an editor's token change no membership at all", async () => {
    const res = await editor.from("memberships").update({ role: "owner" }).eq("workspace_id", ws).eq("user_id", users.editor).select("id");
    expect(res.data).toEqual([]);
    expect(await role(users.editor)).toEqual({ role: "editor", active: true });
  });

  it("allows the demotion once there is a second owner, and the new owner is then the last", async () => {
    await admin.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, 'owner')", [ws, users.second]);
    const demote = await owner.from("memberships").update({ role: "editor" }).eq("workspace_id", ws).eq("user_id", users.owner).select("id");
    expect(demote.error).toBeNull();
    expect(demote.data).toHaveLength(1);
    expect(await role(users.owner)).toEqual({ role: "editor", active: true });
    // The demoted owner can no longer manage anything, and the second is now the last owner.
    const second = client(tokens.second);
    const again = await second.from("memberships").update({ role: "viewer" }).eq("workspace_id", ws).eq("user_id", users.second).select("id");
    expect(again.error?.message).toMatch(/workspace_keeps_an_owner/);
  });

  it("lets an agency admin's token remove the last owner", async () => {
    const gone = await agency.from("memberships").delete().eq("workspace_id", ws).eq("user_id", users.second).select("id");
    expect(gone.error).toBeNull();
    expect(gone.data).toHaveLength(1);
    expect(await role(users.second)).toBeUndefined();
  });
});
