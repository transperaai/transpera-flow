import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type pg from "pg";
import { createPool, type Claims } from "@transpera-flow/db/client";
import { claimsFor } from "../../../apps/web/src/lib/db/claims";
import { createTestDb, type TestDb, type TestDbOptions } from "../../db/test/harness";
import { generateApiToken, handleMcpRequest, hashApiToken, type McpHandlerOptions } from "../src";

export const ENDPOINT = "https://flow.test/api/mcp";

/** What a signed-in user's queries run as: Supabase-shaped claims, as the app's `claimsFor` builds them for a session. */
export function userClaims(sub: string, extra: Partial<Claims> = {}): Claims {
  return { sub, role: "authenticated", aud: "authenticated", app_metadata: {}, ...extra };
}

/** A throwaway database (every migration and the seed), a pool on it for the handler, and `dbAs` for direct queries. */
export interface McpTestDb {
  /** The harness: `client` runs as the database owner (no RLS), for setting up and checking rows. */
  t: TestDb;
  pool: pg.Pool;
  /** What `handleMcpRequest` takes: the pool, and the app's own `claimsFor`. */
  options: McpHandlerOptions;
  /** A `Db` acting as `claims`' user, as the web app's `getDb()` gives one (null: signed out). */
  dbAs: TestDb["dbAs"];
  close(): Promise<void>;
}

export async function startTestDb(testOptions: TestDbOptions = {}, handlerOptions: Partial<McpHandlerOptions> = {}): Promise<McpTestDb> {
  const t = await createTestDb(testOptions);
  const pool = createPool(t.url, { max: 6 });
  return {
    t,
    pool,
    // The web route re-checks the owner against the sign-in list (apps/web/test covers it); here the lookup's answer stands.
    options: { pool, claimsFor, checkUser: async (user) => user, ...handlerOptions },
    dbAs: (claims) => t.dbAs(claims),
    async close() {
      await pool.end();
      await t.close();
    },
  };
}

/** A user in auth.users, with the metadata `raw_app_meta_data` holds (`agency_admin` …). */
export async function createUser(admin: pg.Client, email: string, appMetadata: Record<string, unknown> = {}): Promise<string> {
  const id = randomUUID();
  await admin.query("insert into auth.users (id, email, raw_app_meta_data) values ($1, $2, $3)", [id, email, appMetadata]);
  return id;
}

/** A personal API token for a user, as Settings → API tokens makes one: only the hash is stored. */
export async function issueToken(admin: pg.Client, userId: string, label = "e2e"): Promise<string> {
  const { token, hash } = generateApiToken();
  await admin.query("insert into api_tokens (user_id, token_hash, label) values ($1, $2, $3)", [userId, hash, label]);
  return token;
}

/** Call the endpoint the way Claude Code does: MCP client, Streamable HTTP, bearer token. */
export async function connect(token: string, options: McpHandlerOptions): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(ENDPOINT), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
    fetch: (url, init) => handleMcpRequest(new Request(url, init), options),
  });
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(transport);
  return client;
}

/** The `{ok, data, assumptions}` payload of a tool call. */
export async function call<T = unknown>(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ ok: boolean; data: T; assumptions: string[]; error?: { code: string; message: string } }> {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as { type: string; text: string }[];
  return JSON.parse(content[0]!.text);
}

/** A raw JSON-RPC POST to the endpoint. */
export function post(options: McpHandlerOptions, headers: Record<string, string>, body: unknown = { jsonrpc: "2.0", id: 1, method: "tools/list" }) {
  return handleMcpRequest(
    new Request(ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
      body: JSON.stringify(body),
    }),
    options,
  );
}

/** The error a database call fails with (a `pg` error: `code` is its SQLSTATE), or null when it succeeds. */
export async function errorOf(run: () => Promise<unknown>): Promise<(Error & { code?: string }) | null> {
  try {
    await run();
    return null;
  } catch (e) {
    return e as Error & { code?: string };
  }
}

/**
 * A database handle for a user as an API token reaches it through the endpoint: their identity, as the app's `claimsFor` builds
 * it, with the token's id in the claims.
 */
export async function tokenDbFor(env: McpTestDb, userId: string, { agencyAdmin = false, email = "" } = {}) {
  const token = await issueToken(env.t.client, userId, "e2e");
  const tokenId = (await env.t.client.query("select id from api_tokens where token_hash = $1", [hashApiToken(token)])).rows[0].id as string;
  const claims = env.options.claimsFor({ id: userId, email, agencyAdmin }, { apiTokenId: tokenId });
  return { db: env.dbAs(claims), token, tokenId };
}
