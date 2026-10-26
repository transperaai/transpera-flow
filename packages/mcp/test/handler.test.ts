import { readdirSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateApiToken, hashApiToken, looksLikeApiToken, TOOL_NAMES } from "../src";
import { ENDPOINT, connect, createUser, issueToken, post, startTestDb, userClaims, type McpTestDb } from "./helpers";

// The endpoint's own behaviour against a throwaway database: the token check (app code calling public.mcp_token_lookup as
// `anon`), the status codes, and the claims every query runs under. Data access is covered end to end in end-to-end.test.ts.

let env: McpTestDb;
let admin: pg.Client;
let userId: string;

beforeAll(async () => {
  env = await startTestDb();
  admin = env.t.client;
  userId = await createUser(admin, "handler@example.com");
});

afterAll(async () => {
  await env?.close();
});

const tokenRow = async (token: string) =>
  (await admin.query("select * from api_tokens where token_hash = $1", [hashApiToken(token)])).rows[0] as {
    last_used_at: Date | null;
    rate_window_count: number;
    revoked_at: Date | null;
  };

describe("API tokens", () => {
  it("are tf_ + 32 random bytes, and hash to lowercase hex SHA-256", () => {
    const { token, hash } = generateApiToken();
    expect(looksLikeApiToken(token)).toBe(true);
    expect(hash).toBe(createHash("sha256").update(token).digest("hex"));
    expect(hashApiToken(token)).toMatch(/^[0-9a-f]{64}$/);
    expect(generateApiToken().token).not.toBe(token);
  });
});

describe("handleMcpRequest", () => {
  it("lists every tool to an MCP client with a valid token, and stamps its last use", async () => {
    const token = await issueToken(admin, userId);
    expect((await tokenRow(token)).last_used_at).toBeNull();
    const client = await connect(token, env.options);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
    await client.close();
    const row = await tokenRow(token);
    expect(row.last_used_at).toBeInstanceOf(Date);
    expect(row.rate_window_count).toBeGreaterThan(0);
  });

  it("asks for a bearer token", async () => {
    const res = await post(env.options, {});
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toMatch(/^Bearer/);
  });

  it("rejects malformed tokens without calling the database", async () => {
    // A pool that fails on any use: the check must stop before it.
    const options = { ...env.options, pool: { connect: () => Promise.reject(new Error("the database was called")) } as unknown as pg.Pool };
    expect((await post(options, { authorization: "Bearer nope" })).status).toBe(401);
  });

  it("returns 401 for an unknown token", async () => {
    const res = await post(env.options, { authorization: `Bearer ${generateApiToken().token}` });
    expect(res.status).toBe(401);
    expect(await res.text()).toMatch(/Invalid or revoked/);
  });

  it("returns 401 for a revoked token, and for one whose owner is banned", async () => {
    const revoked = await issueToken(admin, userId);
    await admin.query("update api_tokens set revoked_at = now() where token_hash = $1", [hashApiToken(revoked)]);
    expect((await post(env.options, { authorization: `Bearer ${revoked}` })).status).toBe(401);
    // Refused without being counted: a revoked token's last use stays empty.
    expect((await tokenRow(revoked)).last_used_at).toBeNull();

    const bannedId = await createUser(admin, "banned@example.com");
    await admin.query("update auth.users set banned_until = now() + interval '1 day' where id = $1", [bannedId]);
    const banned = await issueToken(admin, bannedId);
    expect((await post(env.options, { authorization: `Bearer ${banned}` })).status).toBe(401);
    await admin.query("update auth.users set banned_until = now() - interval '1 day' where id = $1", [bannedId]);
    expect((await post(env.options, { authorization: `Bearer ${banned}` })).status).toBe(200);
  });

  it("rate-limits per token with 429 and Retry-After", async () => {
    const token = await issueToken(admin, userId);
    await admin.query("update api_tokens set rate_window_start = now(), rate_window_count = 120 where token_hash = $1", [hashApiToken(token)]);
    const res = await post(env.options, { authorization: `Bearer ${token}` });
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it("runs queries as the token's owner: authenticated claims that carry the token's id", async () => {
    const seen: unknown[] = [];
    const token = await issueToken(admin, userId);
    const options = {
      ...env.options,
      claimsFor: (user: Parameters<typeof env.options.claimsFor>[0], extra: { apiTokenId: string }) => {
        const claims = env.options.claimsFor(user, extra);
        seen.push(claims);
        return claims;
      },
    };
    expect((await post(options, { authorization: `Bearer ${token}` })).status).toBe(200);
    const id = (await admin.query("select id from api_tokens where token_hash = $1", [hashApiToken(token)])).rows[0].id;
    expect(seen).toEqual([expect.objectContaining({ sub: userId, role: "authenticated", email: "handler@example.com", api_token_id: id })]);
  });

  it("only accepts POST (stateless server)", async () => {
    const { handleMcpRequest } = await import("../src");
    const res = await handleMcpRequest(new Request(ENDPOINT, { method: "GET" }), env.options);
    expect(res.status).toBe(405);
  });
});

/** Run `fn` as the `anon` role, in a transaction that is rolled back. */
async function asAnon<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  await admin.query("begin");
  try {
    await admin.query("set local role anon");
    return await fn(admin);
  } finally {
    await admin.query("rollback");
  }
}

describe("the token lookup (public.mcp_token_lookup)", () => {
  it("is callable by anon, returns only what the claims need, and nothing for an unknown hash", async () => {
    const token = await issueToken(admin, userId);
    const lookup = (hash: string) => asAnon((c) => c.query("select * from public.mcp_token_lookup($1)", [hash]));
    const found = await lookup(hashApiToken(token));
    expect(found.rows).toEqual([
      expect.objectContaining({ user_id: userId, email: "handler@example.com", agency_admin: false, active_workspace_id: null, allowed: true }),
    ]);
    expect(Object.keys(found.rows[0]!).sort()).toEqual(
      ["active_workspace_id", "agency_admin", "allowed", "email", "retry_after_seconds", "token_id", "user_id"],
    );
    expect((await lookup("0".repeat(64))).rows).toEqual([]);
    expect((await lookup("not a hash")).rows).toEqual([]);
  });

  it("reports an agency admin, from the owner's app metadata", async () => {
    const agencyId = await createUser(admin, "agency@example.com", { agency_admin: true });
    const token = await issueToken(admin, agencyId);
    const found = await asAnon((c) => c.query("select agency_admin from public.mcp_token_lookup($1)", [hashApiToken(token)]));
    expect(found.rows).toEqual([{ agency_admin: true }]);
    // An agency admin sees every workspace.
    const client = await connect(token, env.options);
    const list = await client.callTool({ name: "list_workspaces", arguments: {} });
    expect(JSON.parse((list.content as { text: string }[])[0]!.text).data.length).toBeGreaterThan(0);
    await client.close();
  });

  it("is not executable by signed-in users: only the endpoint, as anon, checks tokens", async () => {
    await expect(env.t.as(userClaims(userId), (c) => c.query("select * from public.mcp_token_lookup($1)", ["0".repeat(64)]))).rejects.toMatchObject({
      code: "42501",
    });
  });
});

describe("never an RLS-bypassing credential (D12)", () => {
  it("builds claims for the authenticated role only, whatever the token's owner is", async () => {
    // claimsFor takes the user's identity and the token's id and nothing else: it has no way to ask for another role.
    const claims = env.options.claimsFor({ id: userId, email: "x@example.com", agencyAdmin: true }, { apiTokenId: "t" });
    expect(claims).toMatchObject({ sub: userId, role: "authenticated", api_token_id: "t" });
  });

  it("has no reference to a service-role or secret key anywhere in the MCP code path", () => {
    const roots = [new URL("../src/", import.meta.url), new URL("../../../apps/web/src/app/api/mcp/", import.meta.url)];
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = `${dir}/${name}`;
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.(ts|tsx)$/.test(name)) files.push(path);
      }
    };
    for (const root of roots) walk(root.pathname.replace(/\/$/, ""));
    expect(files.some((f) => f.endsWith("api/mcp/route.ts"))).toBe(true);
    const offenders = files.filter((f) => /service_?role|SECRET_KEY|SERVICE_KEY/i.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });
});
