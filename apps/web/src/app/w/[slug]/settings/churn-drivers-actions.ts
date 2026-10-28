"use server";

import { CHURN_DRIVER_SPECS, CUSTOM_DRIVER_VALUE, type BuiltinChurnDriverId } from "@transpera-flow/engine";
import { MAX_CUSTOM_DRIVERS, NEW_DRIVER_NAME, parseDriverPatch } from "@/lib/churn-drivers";
import { isId } from "@/lib/services";
import { pgCode } from "@/app/action-db";
import { getDb, getSessionUser } from "@/lib/auth/session";

// Writes from Settings, Churn drivers (A56). Every write runs as the signed-in user through RLS: owners and
// editors write, everyone else is refused; these checks only reject malformed input early. A driver is saved as a
// whole row (the last save wins, as for market conditions), and a built-in's row is created the first time it is
// changed: until then it is at its default.

export type DriverResult = { status: "saved"; rowId: string } | { status: "error"; message: string };

const failed = (e: unknown): DriverResult => ({
  status: "error",
  message:
    pgCode(e) === "42501"
      ? "You don't have permission to change this."
      : pgCode(e) === "23514"
        ? "That isn't allowed. A workspace can have up to 25 drivers of its own, and each value has a range."
        : "Couldn't save. Try again.",
});

async function signedIn(): Promise<boolean> {
  return Boolean(await getSessionUser());
}

const invalid: DriverResult = { status: "error", message: "That value isn't valid." };
const signedOut: DriverResult = { status: "error", message: "Your session has ended. Sign in again." };

/**
 * Change a driver: `key` is a built-in's key or the id of one of your own. Returns the id of its row, which is
 * new the first time a built-in is changed.
 */
export async function saveChurnDriver(workspaceId: string, key: string, patch: unknown): Promise<DriverResult> {
  const parsed = parseDriverPatch(key, patch);
  if (!isId(workspaceId) || !parsed) return invalid;
  if (!(await signedIn())) return signedOut;
  const db = await getDb();

  const { effectMonths, ...rest } = parsed;
  const columns = { ...rest, ...(effectMonths !== undefined ? { effect_months: effectMonths } : {}) };
  const update = async (id: string): Promise<DriverResult> => {
    let data;
    try {
      data = await db.updateTable("churn_drivers").set(columns).where("id", "=", id).where("workspace_id", "=", workspaceId).returning("id").execute();
    } catch (e) {
      return failed(e);
    }
    return data.length ? { status: "saved", rowId: id } : { status: "error", message: "That driver was removed, or you can't change it." };
  };

  if (isId(key)) return update(key);

  const builtin = key as BuiltinChurnDriverId;
  const existing = async () => {
    try {
      const data = await db.selectFrom("churn_drivers").select("id").where("workspace_id", "=", workspaceId).where("driver", "=", builtin).executeTakeFirst();
      return { id: data?.id ?? null, error: null as unknown };
    } catch (error) {
      return { id: null, error };
    }
  };
  const found = await existing();
  if (found.error) return failed(found.error);
  if (found.id) return update(found.id);

  // First change: the row starts from the default for everything the edit doesn't set.
  const spec = CHURN_DRIVER_SPECS[builtin];
  try {
    const data = await db
      .insertInto("churn_drivers")
      .values({
        workspace_id: workspaceId,
        driver: builtin,
        weight: parsed.weight ?? 1,
        enabled: parsed.enabled ?? spec.defaultEnabled,
        value: parsed.value !== undefined ? parsed.value : spec.defaultValue,
        month: builtin === "price" ? (parsed.month ?? 1) : null,
        chance: parsed.chance ?? null,
        effect: parsed.effect ?? null,
        effect_months: parsed.effectMonths ?? null,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    return { status: "saved", rowId: data.id };
  } catch (error) {
    // Someone set it up a moment ago: apply this edit to their row.
    if (pgCode(error) === "23505") {
      const again = await existing();
      return again.id ? update(again.id) : failed(error);
    }
    return failed(error);
  }
}

/** Add a driver of your own, starting as "New driver" at weight 1 with 20% extra churn; the person renames it. */
export async function addChurnDriver(workspaceId: string): Promise<DriverResult> {
  if (!isId(workspaceId)) return invalid;
  if (!(await signedIn())) return signedOut;
  const db = await getDb();
  let count: number;
  try {
    const counted = await db
      .selectFrom("churn_drivers")
      .select((eb) => eb.fn.countAll<number>().as("count"))
      .where("workspace_id", "=", workspaceId)
      .where("driver", "is", null)
      .executeTakeFirstOrThrow();
    count = Number(counted.count);
  } catch (e) {
    return failed(e);
  }
  if (count >= MAX_CUSTOM_DRIVERS) return { status: "error", message: `You can have up to ${MAX_CUSTOM_DRIVERS} drivers of your own.` };
  try {
    const data = await db
      .insertInto("churn_drivers")
      .values({ workspace_id: workspaceId, name: NEW_DRIVER_NAME, weight: 1, enabled: true, value: CUSTOM_DRIVER_VALUE.default })
      .returning("id")
      .executeTakeFirstOrThrow();
    return { status: "saved", rowId: data.id };
  } catch (e) {
    return failed(e);
  }
}

/** Remove a driver of your own. */
export async function removeChurnDriver(workspaceId: string, rowId: string): Promise<DriverResult> {
  if (!isId(workspaceId) || !isId(rowId)) return invalid;
  if (!(await signedIn())) return signedOut;
  const db = await getDb();
  let data;
  try {
    data = await db.deleteFrom("churn_drivers").where("id", "=", rowId).where("workspace_id", "=", workspaceId).where("driver", "is", null).returning("id").execute();
  } catch (e) {
    return failed(e);
  }
  return data.length ? { status: "saved", rowId } : { status: "error", message: "That driver was already removed, or you can't change it." };
}
