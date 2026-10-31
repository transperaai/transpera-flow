"use server";

import { checkCapacityChange, cleanCapacityChange, type CapacityChangeInput, type CapacityChangeRow } from "@transpera-flow/db";
import { jsonb, pgCode } from "@/app/action-db";
import { getDb, getSessionUser } from "@/lib/auth/session";
import { isId } from "@/lib/sources/validate";

// The Sandbox's list of changes (capacity build P7): add, edit and remove an automation or augmentation. The write runs as the signed-in user
// through row-level security (the Owner and Agency admins write; everyone in the workspace reads). The checks here only reject malformed input
// early, in plain words; the table checks every column again.

export type SaveChangeResult = { status: "ok"; change: CapacityChangeRow } | { status: "error"; message: string };
export type DeleteChangeResult = { status: "ok" } | { status: "error"; message: string };

const signedOut = { status: "error", message: "Your session has ended. Sign in again." } as const;
const forbidden = { status: "error", message: "Only Agency admins and the Owner can change the list of changes." } as const;
const invalid = { status: "error", message: "That change isn't valid." } as const;

const COLUMNS = ["id", "name", "kind", "effects", "adoption", "ramp_months", "tiers", "cost_monthly", "issue_id", "source", "provenance"] as const;

function failure(e: unknown): { status: "error"; message: string } {
  const code = pgCode(e);
  if (code === "42501") return forbidden;
  if (code === "23505") return { status: "error", message: "A change with that name already exists. Choose another name." };
  if (code === "23514" || code === "22P02") return { status: "error", message: "Some of those values aren't allowed." };
  return { status: "error", message: "Couldn't save the change. Try again." };
}

const asRow = (r: Record<string, unknown>): CapacityChangeRow => ({
  id: String(r.id),
  name: String(r.name),
  kind: r.kind as CapacityChangeRow["kind"],
  effects: (Array.isArray(r.effects) ? r.effects : []) as CapacityChangeRow["effects"],
  adoption: Number(r.adoption),
  ramp_months: Number(r.ramp_months),
  tiers: (r.tiers as string[] | null) ?? null,
  cost_monthly: r.cost_monthly === null || r.cost_monthly === undefined ? null : Number(r.cost_monthly),
  issue_id: (r.issue_id as string | null) ?? null,
  source: r.source as CapacityChangeRow["source"],
  provenance: (r.provenance ?? {}) as Record<string, unknown>,
});

/** Add a change (`id` null) or save edits to one. */
export async function saveCapacityChange(workspaceId: unknown, id: unknown, input: unknown): Promise<SaveChangeResult> {
  if (!isId(workspaceId) || (id !== null && !isId(id)) || typeof input !== "object" || input === null) return invalid;
  const clean = cleanCapacityChange(input as CapacityChangeInput);
  const problem = checkCapacityChange(clean);
  if (problem) return { status: "error", message: problem };
  if (!(await getSessionUser())) return signedOut;
  const db = await getDb();
  const values = {
    name: clean.name,
    kind: clean.kind,
    effects: jsonb(clean.effects),
    adoption: clean.adoption,
    ramp_months: clean.ramp_months,
    tiers: clean.tiers,
    cost_monthly: clean.cost_monthly,
    issue_id: clean.issue_id,
    source: clean.source,
  };
  try {
    const row =
      id === null
        ? await db.insertInto("capacity_changes").values({ workspace_id: workspaceId, ...values }).returning([...COLUMNS]).executeTakeFirstOrThrow()
        : await db.updateTable("capacity_changes").set(values).where("id", "=", id).where("workspace_id", "=", workspaceId).returning([...COLUMNS]).executeTakeFirst();
    // An update that touches no row: not theirs to change, or gone.
    if (!row) return forbidden;
    return { status: "ok", change: asRow(row as unknown as Record<string, unknown>) };
  } catch (e) {
    return failure(e);
  }
}

/** Remove a change. */
export async function deleteCapacityChange(workspaceId: unknown, id: unknown): Promise<DeleteChangeResult> {
  if (!isId(workspaceId) || !isId(id)) return invalid;
  if (!(await getSessionUser())) return signedOut;
  const db = await getDb();
  try {
    const r = await db.deleteFrom("capacity_changes").where("id", "=", id).where("workspace_id", "=", workspaceId).executeTakeFirst();
    if (!r.numDeletedRows) return forbidden;
    return { status: "ok" };
  } catch (e) {
    return failure(e);
  }
}
