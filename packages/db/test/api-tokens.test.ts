import { createHash, randomBytes } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NORTHBEAM_WORKSPACE_ID } from "../src";
import { createTestDb, createUser, type TestDb } from "./harness";

// API tokens and the PostgREST pre-request hook (migration 20260930040000),
// exercised the way PostgREST drives them: an `anon` transaction carrying
// `request.headers`, then the hook, then the query. The same flow runs through
// real PostgREST and the MCP handler in packages/mcp/test/postgrest.test.ts.

let db: TestDb;
const newToken = () => `tf_${randomBytes(32).toString("base64url")}`;
const hash = (t: string) => createHash("sha256").update(t, "utf8").digest("hex");

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db?.close();
});

async function issueToken(userId: string, label = "test") {
  const token = newToken();
  const id = (
    await db.client.query("insert into api_tokens (user_id, token_hash, label) values ($1, $2, $3) returning id", [
      userId,
      hash(token),
      label,
    ])
  ).rows[0].id as string;
  return { token, id };
}

/** Run `fn` the way PostgREST would for an anonymous request with these headers. */
async function asAnonRequest<T>(headers: Record<string, string>, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = db.client;
  await c.query("begin");
  try {
    await c.query("set local role anon");
    await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role: "anon" })]);
    await c.query("select set_config('request.headers', $1, true)", [JSON.stringify(headers)]);
    await c.query("select private.api_token_pre_request()");
    return await fn(c);
  } finally {
    await c.query("rollback");
  }
}

const whoami = async (c: pg.Client) =>
  (await c.query("select current_user::text as role, auth.uid()::text as uid, (select count(*)::int from workspaces) as workspaces"))
    .rows[0] as { role: string; uid: string | null; workspaces: number };

describe("api_tokens table", () => {
  it("stores only what the user sends (the hash) and shows users only their own tokens", async () => {
    const alice = await createUser(db, "alice-tokens@example.com");
    const bob = await createUser(db, "bob-tokens@example.com");
    await issueToken(bob.id, "bob's");
    const token = newToken();
    const mine = await db.as(alice.claims, async (c) => {
      await c.query("insert into api_tokens (label, token_hash) values ('laptop', $1)", [hash(token)]);
      return (await c.query("select user_id, label, token_hash from api_tokens")).rows;
    });
    expect(mine).toEqual([{ user_id: alice.id, label: "laptop", token_hash: hash(token) }]);
  });

  it("stops a user creating a token for someone else", async () => {
    const alice = await createUser(db, "alice-forge@example.com");
    const bob = await createUser(db, "bob-forge@example.com");
    await expect(
      db.as(alice.claims, (c) => c.query("insert into api_tokens (user_id, label, token_hash) values ($1, 'x', $2)", [bob.id, hash(newToken())])),
    ).rejects.toThrow(/permission denied/);
  });

  it("lets a user revoke their token, permanently, and not touch the hash or counters", async () => {
    const alice = await createUser(db, "alice-revoke@example.com");
    const { id } = await issueToken(alice.id);
    await db.client.query("begin");
    try {
      await db.client.query("set local role authenticated");
      await db.client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(alice.claims)]);
      await db.client.query("update api_tokens set revoked_at = now() where id = $1", [id]);
      await db.client.query("commit");
    } catch (err) {
      await db.client.query("rollback");
      throw err;
    }
    expect((await db.client.query("select revoked_at from api_tokens where id = $1", [id])).rows[0].revoked_at).not.toBeNull();
    await expect(db.as(alice.claims, (c) => c.query("update api_tokens set revoked_at = null where id = $1", [id]))).rejects.toThrow(
      /cannot be restored/,
    );
    await expect(
      db.as(alice.claims, (c) => c.query("update api_tokens set token_hash = $2 where id = $1", [id, hash(newToken())])),
    ).rejects.toThrow(/permission denied/);
    await expect(db.as(alice.claims, (c) => c.query("update api_tokens set rate_window_count = 0 where id = $1", [id]))).rejects.toThrow(
      /permission denied/,
    );
  });

  it("does not let one user revoke another's token", async () => {
    const alice = await createUser(db, "alice-other@example.com");
    const bob = await createUser(db, "bob-other@example.com");
    const { id } = await issueToken(bob.id);
    const changed = await db.as(alice.claims, (c) => c.query("update api_tokens set revoked_at = now() where id = $1", [id]));
    expect(changed.rowCount).toBe(0);
  });

  it("gives anon no access to the table", async () => {
    await db.client.query("begin");
    try {
      await db.client.query("set local role anon");
      await expect(db.client.query("select * from api_tokens")).rejects.toThrow(/permission denied/);
    } finally {
      await db.client.query("rollback");
    }
  });
});

describe("pre-request hook", () => {
  it("leaves requests without the header alone", async () => {
    expect(await asAnonRequest({}, async (c) => (await c.query("select current_user::text as role")).rows[0].role)).toBe("anon");
  });

  it("acts as the token's user: a member sees the workspace, a stranger's token sees nothing", async () => {
    const member = await createUser(db, "member-token@example.com");
    const stranger = await createUser(db, "stranger-token@example.com");
    await db.client.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, 'viewer')", [
      NORTHBEAM_WORKSPACE_ID,
      member.id,
    ]);
    const a = await issueToken(member.id);
    const b = await issueToken(stranger.id);

    expect(await asAnonRequest({ "x-api-token": a.token }, whoami)).toEqual({ role: "authenticated", uid: member.id, workspaces: 1 });
    expect(await asAnonRequest({ "x-api-token": b.token }, whoami)).toEqual({ role: "authenticated", uid: stranger.id, workspaces: 0 });
    expect(
      await asAnonRequest({ "x-api-token": b.token }, async (c) => (await c.query("select count(*)::int as n from steps")).rows[0].n),
    ).toBe(0);
  });

  it("carries the agency_admin flag from app_metadata", async () => {
    const admin = await createUser(db, "admin-token@example.com", { agency_admin: true });
    const { token } = await issueToken(admin.id);
    expect((await asAnonRequest({ "x-api-token": token }, whoami)).workspaces).toBeGreaterThanOrEqual(1);
  });

  it("rejects unknown and revoked tokens", async () => {
    const user = await createUser(db, "revoked-token@example.com");
    const { token, id } = await issueToken(user.id);
    await db.client.query("update api_tokens set revoked_at = now() where id = $1", [id]);
    await expect(asAnonRequest({ "x-api-token": token }, whoami)).rejects.toThrow(/Invalid or revoked API token/);
    await expect(asAnonRequest({ "x-api-token": newToken() }, whoami)).rejects.toThrow(/Invalid or revoked API token/);
  });

  it("rejects banned users' tokens", async () => {
    const user = await createUser(db, "banned-token@example.com");
    const { token } = await issueToken(user.id);
    await db.client.query("update auth.users set banned_until = now() + interval '1 day' where id = $1", [user.id]);
    await expect(asAnonRequest({ "x-api-token": token }, whoami)).rejects.toThrow(/Invalid or revoked API token/);
  });

  it("refuses a token on a request that already has a signed-in session", async () => {
    const user = await createUser(db, "both@example.com");
    const { token } = await issueToken(user.id);
    await db.client.query("begin");
    try {
      await db.client.query("set local role authenticated");
      await db.client.query("select set_config('request.headers', $1, true)", [JSON.stringify({ "x-api-token": token })]);
      await expect(db.client.query("select private.api_token_pre_request()")).rejects.toThrow(/not both/);
    } finally {
      await db.client.query("rollback");
    }
  });

  it("does not let anon call the token resolver's schema functions it wasn't granted", async () => {
    await db.client.query("begin");
    try {
      await db.client.query("set local role anon");
      await expect(db.client.query("select private.hash_api_token('x')")).rejects.toThrow(/permission denied/);
    } finally {
      await db.client.query("rollback");
    }
  });
});

describe("use_api_token", () => {
  it("is gone: the MCP endpoint checks tokens with mcp_token_lookup (ADR 0018)", async () => {
    expect((await db.client.query("select count(*)::int as n from pg_proc where proname = 'use_api_token'")).rows[0].n).toBe(0);
  });
});

describe("mcp_simulation_use", () => {
  const use = (claims: Record<string, unknown> | null) =>
    commitAs(claims, async (c) => (await c.query("select public.mcp_simulation_use() as r")).rows[0].r as { allowed: boolean; retry_after_seconds: number; limit: number });
  /** Like db.as, but committed, so the counter persists between calls. */
  async function commitAs<T>(claims: Record<string, unknown> | null, fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = db.client;
    await c.query("begin");
    try {
      await c.query("set local role authenticated");
      await c.query("select set_config('request.jwt.claims', $1, true)", [claims ? JSON.stringify(claims) : ""]);
      const out = await fn(c);
      await c.query("commit");
      return out;
    } catch (e) {
      await c.query("rollback");
      throw e;
    }
  }

  it("allows 10 simulations a minute per token, then refuses until the window ends", async () => {
    const user = await createUser(db, "sim-rate@example.com");
    const { id } = await issueToken(user.id);
    const claims = { sub: user.id, role: "authenticated", api_token_id: id };
    for (let i = 0; i < 10; i++) expect(await use(claims)).toMatchObject({ allowed: true, limit: 10 });
    const over = await use(claims);
    expect(over).toMatchObject({ allowed: false });
    expect(over.retry_after_seconds).toBeGreaterThan(0);
    // The general per-request window is separate.
    expect((await db.client.query("select rate_window_count, sim_window_count from api_tokens where id = $1", [id])).rows[0]).toEqual({ rate_window_count: 0, sim_window_count: 11 });
    await db.client.query("update api_tokens set sim_window_start = now() - interval '61 seconds' where id = $1", [id]);
    expect(await use(claims)).toMatchObject({ allowed: true });
  });

  it("counts nothing for a browser session, someone else's token or a revoked one, and anon can't call it", async () => {
    const user = await createUser(db, "sim-other@example.com");
    const other = await createUser(db, "sim-other2@example.com");
    const { id } = await issueToken(user.id);
    expect(await use({ sub: user.id, role: "authenticated" })).toMatchObject({ allowed: false });
    expect(await use({ sub: other.id, role: "authenticated", api_token_id: id })).toMatchObject({ allowed: false });
    expect(await use({ sub: user.id, role: "authenticated", api_token_id: "not-a-uuid" })).toMatchObject({ allowed: false });
    await db.client.query("update api_tokens set revoked_at = now() where id = $1", [id]);
    expect(await use({ sub: user.id, role: "authenticated", api_token_id: id })).toMatchObject({ allowed: false });
    expect((await db.client.query("select sim_window_count from api_tokens where id = $1", [id])).rows[0].sim_window_count).toBe(0);
    await db.client.query("begin");
    try {
      await db.client.query("set local role anon");
      await expect(db.client.query("select public.mcp_simulation_use()")).rejects.toThrow(/permission denied/);
    } finally {
      await db.client.query("rollback");
    }
  });
});
