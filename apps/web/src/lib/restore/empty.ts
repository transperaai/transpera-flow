// Whether a workspace is empty enough to restore a backup into (issue #39, B10 2b). A courtesy for the Overview card and the
// restore page: `import_workspace_bundle` is the judge and checks again under a lock. It asks the same questions through the
// signed-in user's own reads (row-level security shows a member everything it could hold).

import type { SupabaseClient } from "@supabase/supabase-js";

const TABLES = ["roles", "people", "services", "client_groups", "clients", "lead_sources", "churn_drivers", "market_schedule", "issues", "sources", "blocks", "solutions", "suggestions", "suggestion_proposals"] as const;

export async function workspaceIsEmpty(supabase: SupabaseClient, workspaceId: string): Promise<boolean> {
  const has = async (table: string, narrow?: (q: ReturnType<typeof base>) => ReturnType<typeof base>) => {
    const { count } = await (narrow ?? ((q) => q))(base(table)).limit(1);
    return (count ?? 0) > 0;
  };
  const base = (table: string) => supabase.from(table).select("id", { count: "exact", head: true }).eq("workspace_id", workspaceId);
  if (await has("processes", (q) => q.eq("is_company", false))) return false;
  if (await has("market_conditions", (q) => q.is("preset", null))) return false;
  for (const t of TABLES) if (await has(t)) return false;
  return true;
}
