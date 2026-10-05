import { handleMcpRequest } from "@transpera-flow/mcp";
import { supabaseEnv } from "@/lib/supabase/env";

// MCP endpoint (docs/PRD.md §7.1, §10). Authenticated by a personal API token
// (Authorization: Bearer tf_…) and run as that user under RLS; see
// docs/adr/0002-mcp-acts-as-user-via-pre-request.md. Uses only the
// publishable key.

// Server-side simulation can take a few seconds, and the robustness checks run
// for up to 120 s.
export const maxDuration = 300;

async function handle(request: Request): Promise<Response> {
  const env = supabaseEnv();
  if (!env) return Response.json({ error: "Supabase is not configured" }, { status: 503 });
  // AI analysis runs only when someone presses "Analyse" (B17), so a publish through MCP starts nothing.
  return handleMcpRequest(request, { supabaseUrl: env.url, supabaseKey: env.key });
}

export const POST = handle;
export const GET = handle;
export const DELETE = handle;
