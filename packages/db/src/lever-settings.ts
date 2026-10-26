import type { Db } from "./queries";
import { pgCode } from "./pg-error";

// Which levers a workspace shows (issue #123, A58): one row per workspace holding the ids of the lever kinds it
// has switched off. No row means every lever is shown. Reads and writes run as the signed-in user, so RLS decides:
// every member reads, owners and editors write. The ids are checked by the app, which knows the lever kinds
// (apps/web/src/lib/scenarios/lever-catalogue.ts); this module only stores the list.

export interface LeverSettings {
  /** Ids of the lever kinds switched off. */
  hidden: string[];
  /** The row's `updated_at`, which a save must quote to prove it saw the latest; null when there is no row yet. */
  version: string | null;
}

const MAX_HIDDEN = 100;

/** The workspace's lever settings: nothing hidden when there is no row. */
export async function loadLeverSettings(db: Db, workspaceId: string): Promise<LeverSettings> {
  const data = await db.selectFrom("lever_settings").select(["hidden", "updated_at"]).where("workspace_id", "=", workspaceId).executeTakeFirst();
  if (!data) return { hidden: [], version: null };
  return { hidden: data.hidden, version: data.updated_at };
}

export type SaveLeverSettingsOutcome =
  | { status: "saved"; settings: LeverSettings }
  /** Someone saved since `version`: their list, to merge or overwrite. */
  | { status: "conflict"; settings: LeverSettings }
  /** No permission (viewers and members can't change levers). */
  | { status: "forbidden" }
  | { status: "invalid"; message: string }
  | { status: "error"; message: string };

/**
 * Save the whole list. `version` is what the caller last loaded: the save goes through only if no one has saved
 * since (compare-and-set on `updated_at`), so two people editing at once are told instead of one silently undoing
 * the other.
 */
export async function saveLeverSettings(db: Db, workspaceId: string, hidden: readonly string[], version: string | null): Promise<SaveLeverSettingsOutcome> {
  if (hidden.length > MAX_HIDDEN || hidden.some((h) => typeof h !== "string" || h.length === 0 || h.length > 100)) {
    return { status: "invalid", message: "That list of levers isn't valid." };
  }
  const list = [...new Set(hidden)];

  const conflict = async (): Promise<SaveLeverSettingsOutcome> => {
    let data;
    try {
      data = await db.selectFrom("lever_settings").select(["hidden", "updated_at"]).where("workspace_id", "=", workspaceId).executeTakeFirst();
    } catch {
      return { status: "error", message: "Couldn't save. Try again." };
    }
    // No row to compare against and the write didn't go through: the user can't write here.
    if (!data) return { status: "forbidden" };
    if (data.updated_at === version) return { status: "forbidden" };
    return { status: "conflict", settings: { hidden: data.hidden, version: data.updated_at } };
  };

  if (version === null) {
    try {
      const data = await db
        .insertInto("lever_settings")
        .values({ workspace_id: workspaceId, hidden: list })
        .returning(["hidden", "updated_at"])
        .executeTakeFirstOrThrow();
      return { status: "saved", settings: { hidden: data.hidden, version: data.updated_at } };
    } catch (e) {
      const code = pgCode(e);
      if (code === "23505") return conflict();
      if (code === "42501") return { status: "forbidden" };
      return { status: "error", message: "Couldn't save. Try again." };
    }
  }

  let data;
  try {
    data = await db
      .updateTable("lever_settings")
      .set({ hidden: list })
      .where("workspace_id", "=", workspaceId)
      .where("updated_at", "=", version)
      .returning(["hidden", "updated_at"])
      .execute();
  } catch (e) {
    return pgCode(e) === "42501" ? { status: "forbidden" } : { status: "error", message: "Couldn't save. Try again." };
  }
  const row = data[0];
  if (!row) return conflict();
  return { status: "saved", settings: { hidden: row.hidden, version: row.updated_at } };
}
