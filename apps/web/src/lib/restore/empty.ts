// Whether a workspace is empty enough to restore a backup into (issue #39, B10 2b). A courtesy for the Overview card and the
// restore page: `import_workspace_bundle` is the judge and checks again under a lock. It asks the same questions through the
// signed-in user's own reads (row-level security shows a member everything it could hold).

import type { Db } from "@transpera-flow/db";

const TABLES = ["roles", "people", "services", "client_groups", "clients", "lead_sources", "churn_drivers", "market_schedule", "issues", "sources", "blocks", "solutions", "suggestions", "suggestion_proposals"] as const;

export async function workspaceIsEmpty(db: Db, workspaceId: string): Promise<boolean> {
  const has = async (table: (typeof TABLES)[number] | "processes" | "market_conditions", narrow?: { column: "is_company" | "preset"; isNull?: boolean; value?: boolean }) => {
    let q = db.selectFrom(table).select("id").where("workspace_id", "=", workspaceId);
    if (narrow?.column === "is_company") q = q.where("is_company" as never, "=", narrow.value as never);
    if (narrow?.column === "preset") q = q.where("preset" as never, "is", null);
    return (await q.limit(1).executeTakeFirst()) !== undefined;
  };
  if (await has("processes", { column: "is_company", value: false })) return false;
  if (await has("market_conditions", { column: "preset", isNull: true })) return false;
  for (const t of TABLES) if (await has(t)) return false;
  return true;
}
