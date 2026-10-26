import { handleMcpRequest } from "@transpera-flow/mcp";
import { claimsFor } from "@/lib/db/claims";
import { appPool, authPool } from "@/lib/db/pool";
import { currentAccess } from "@/lib/auth/access";
import { authEnv } from "@/lib/auth/env";

// MCP endpoint (docs/PRD.md §7.1, §10). Authenticated by a personal API token (Authorization: Bearer tf_…), checked in app
// code, and run as that user under RLS; see docs/adr/0018-mcp-tokens-checked-in-app-code.md.

// Server-side simulation can take a few seconds, and the robustness checks run
// for up to 120 s.
export const maxDuration = 300;

async function handle(request: Request): Promise<Response> {
  const env = authEnv();
  if (!env) return Response.json({ error: "The database is not configured" }, { status: 503 });
  // AI analysis runs only when someone presses "Analyse" (B17), so a publish through MCP starts nothing.
  return handleMcpRequest(request, {
    pool: appPool(),
    claimsFor,
    // The token's owner is checked against the sign-in list on every request, as a browser session is (lib/auth/session.ts).
    checkUser: async (user) => {
      const access = await currentAccess(authPool(), user.id, env.adminEmails);
      return access ? { id: user.id, ...access } : null;
    },
  });
}

export const POST = handle;
export const GET = handle;
export const DELETE = handle;
