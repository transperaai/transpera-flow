// Whether a workspace is empty enough to restore a backup into (issue #39, B10 2b). A courtesy for the Overview card and the
// restore page: `import_workspace_bundle` is the judge and checks again under a lock. It asks the same questions through the
// signed-in user's own reads (row-level security shows a member everything it could hold).

import type { Db } from "@transpera-flow/db";

const TABLES = ["roles", "people", "services", "client_groups", "clients", "lead_sources", "churn_drivers", "market_schedule", "issues", "sources", "blocks", "solutions"] as const;

/**
 * One statement for all the questions: the Overview asks this on every load for editors, and each statement outside a
 * transaction costs three round trips (ClaimsDriver), so asking table by table was dozens of round trips to Neon.
 */
export async function workspaceIsEmpty(db: Db, workspaceId: string): Promise<boolean> {
  const row = await db
    .selectNoFrom((eb) =>
      eb
        .or([
          eb.exists(eb.selectFrom("processes").select("id").where("workspace_id", "=", workspaceId).where("is_company", "=", false)),
          eb.exists(eb.selectFrom("market_conditions").select("id").where("workspace_id", "=", workspaceId).where("preset", "is", null)),
          ...TABLES.map((t) => eb.exists(eb.selectFrom(t).select("id").where("workspace_id", "=", workspaceId))),
        ])
        .as("busy"),
    )
    .executeTakeFirstOrThrow();
  return row.busy !== true;
}
