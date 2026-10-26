import { handleMcpRequest } from "@transpera-flow/mcp";
import { claimsFor } from "@/lib/db/claims";
import { appPool } from "@/lib/db/pool";
import { authEnv } from "@/lib/auth/env";

// MCP endpoint (docs/PRD.md §7.1, §10). Authenticated by a personal API token (Authorization: Bearer tf_…), checked in app
// code, and run as that user under RLS; see docs/adr/0018-mcp-tokens-checked-in-app-code.md.

// Server-side simulation can take a few seconds, and the robustness checks run
// for up to 120 s.
export const maxDuration = 300;

async function handle(request: Request): Promise<Response> {
  if (!authEnv()) return Response.json({ error: "The database is not configured" }, { status: 503 });
  // AI analysis runs only when someone presses "Analyse" (B17), so a publish through MCP starts nothing.
  return handleMcpRequest(request, { pool: appPool(), claimsFor });
}

export const POST = handle;
export const GET = handle;
export const DELETE = handle;
