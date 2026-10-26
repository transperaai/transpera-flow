import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Pool } from "pg";
import type { Db } from "@transpera-flow/db";
import { createDb, rpcRows, type Claims } from "@transpera-flow/db/client";
import { hashApiToken, looksLikeApiToken } from "./tokens";
import { createMcpServer } from "./tools";

// The /api/mcp endpoint (docs/PRD.md §7.1, §10; docs/adr/0018-*). Stateless Streamable HTTP: every POST checks the caller's
// API token in app code (`public.mcp_token_lookup`, run as `anon`), then builds a fresh server whose database handle runs
// every query as the token's owner, under RLS, with the token's id in the claims. No credential that bypasses RLS is
// ever held here: the pool's role is switched to `authenticated` for every statement.

/** Who a token acts as: what the app builds the owner's claims from (apps/web/src/lib/db/claims.ts). */
export interface TokenUser {
  id: string;
  email: string;
  agencyAdmin: boolean;
}

export interface McpHandlerOptions {
  /** The app's pool (apps/web/src/lib/db/pool.ts `appPool()`), created with `createPool` so values parse as PostgREST once sent them. */
  pool: Pool;
  /** The one place claims are built (apps/web/src/lib/db/claims.ts `claimsFor`). */
  claimsFor: (user: TokenUser, extra: { apiTokenId: string }) => Claims | null;
  /** For tests: the current date. */
  now?: () => Date;
  /** Called with the token's db and the process id after `publish_process` made a version live (A46: AI analysis). */
  onPublished?: (db: Db, processId: string) => void;
}

function jsonRpcError(status: number, message: string, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

const unauthorized = (message: string) =>
  jsonRpcError(401, message, { "www-authenticate": 'Bearer realm="transpera-flow", error="invalid_token"' });

interface TokenUse {
  user_id: string;
  token_id: string;
  email: string | null;
  agency_admin: boolean;
  active_workspace_id: string | null;
  allowed: boolean;
  retry_after_seconds: number;
}

/** One call: resolves the token, stamps its last use and counts the request. No rows: unknown, revoked or its owner is banned. */
async function lookupToken(pool: Pool, hash: string): Promise<TokenUse | undefined> {
  // Not in the generated function types until they are regenerated, so the call is typed here.
  const call = rpcRows as unknown as (db: Db, name: string, args: { p_token_hash: string }) => Promise<TokenUse[]>;
  const rows = await call(createDb(pool, null), "mcp_token_lookup", { p_token_hash: hash });
  return rows[0];
}

export async function handleMcpRequest(request: Request, options: McpHandlerOptions): Promise<Response> {
  if (request.method !== "POST") {
    // Stateless server: no standalone SSE stream (GET) and no sessions to end (DELETE).
    return jsonRpcError(405, "Method not allowed", { allow: "POST" });
  }

  const auth = request.headers.get("authorization") ?? "";
  const token = /^Bearer\s+(\S+)$/i.exec(auth)?.[1];
  if (!token) return unauthorized("Missing bearer token. Create an API token in Transpera Flow under Settings → API tokens.");
  if (!looksLikeApiToken(token)) return unauthorized("Malformed API token");

  const tokenHash = hashApiToken(token);
  const use = await lookupToken(options.pool, tokenHash);
  if (!use) return unauthorized("Invalid or revoked API token");
  if (!use.allowed) {
    return jsonRpcError(429, "Rate limit exceeded for this API token", { "retry-after": String(use.retry_after_seconds || 60) });
  }

  const claims = options.claimsFor({ id: use.user_id, email: use.email ?? "", agencyAdmin: use.agency_admin }, { apiTokenId: use.token_id });
  if (!claims) throw new Error("claimsFor returned no claims for a signed-in token owner");
  const db = createDb(options.pool, claims);

  const server = createMcpServer({
    db,
    tokenHash,
    userId: use.user_id,
    activeWorkspaceId: use.active_workspace_id,
    today: (options.now?.() ?? new Date()).toISOString().slice(0, 10),
    ...(options.onPublished ? { onPublished: (processId: string) => options.onPublished!(db, processId) } : {}),
  });
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  try {
    await server.connect(transport);
    return await transport.handleRequest(request);
  } finally {
    await server.close();
  }
}
