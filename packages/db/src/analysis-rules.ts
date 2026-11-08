import { parseAnalysisSettings, type AnalysisSettings } from "@transpera-flow/engine";
import type { Db } from "./queries";
import { pgCode } from "./pg-error";

// A workspace's analysis rules (issue #109, docs/analysis-rules.md): one row
// per workspace holding the sparse settings document that
// `toRatingConfig` (the engine) turns into the rating config. No row means
// all defaults. Reads and writes run as the signed-in user, so RLS decides:
// every member reads, owners and editors write.

export interface AnalysisRules {
  settings: AnalysisSettings;
  /** The row's `updated_at`, which a save must quote to prove it saw the latest; null when there is no row yet. */
  version: string | null;
}

/** The workspace's rules, tolerant of anything in the stored document (invalid parts fall back to the defaults). */
export async function loadAnalysisRules(db: Db, workspaceId: string): Promise<AnalysisRules> {
  const data = await db.selectFrom("analysis_rules").select(["settings", "updated_at"]).where("workspace_id", "=", workspaceId).executeTakeFirst();
  if (!data) return { settings: {}, version: null };
  return { settings: parseAnalysisSettings(data.settings).value, version: data.updated_at };
}

export type SaveAnalysisRulesOutcome =
  | { status: "saved"; rules: AnalysisRules }
  | { status: "invalid"; errors: string[] }
  /** Someone saved since `version`: their rules, to merge or overwrite. */
  | { status: "conflict"; rules: AnalysisRules }
  /** No permission (viewers and members can't change rules). */
  | { status: "forbidden" }
  | { status: "error"; message: string };

/**
 * Save the whole document. `version` is what the caller last loaded: the save
 * goes through only if no one has saved since (compare-and-set on
 * `updated_at`), so two people editing at once are told instead of one
 * silently undoing the other.
 */
export async function saveAnalysisRules(
  db: Db,
  workspaceId: string,
  settings: unknown,
  version: string | null,
): Promise<SaveAnalysisRulesOutcome> {
  const parsed = parseAnalysisSettings(settings);
  if (!parsed.ok) return { status: "invalid", errors: parsed.errors };
  const doc = parsed.value;
  const stored = JSON.parse(JSON.stringify(doc)) as never;

  const conflict = async (): Promise<SaveAnalysisRulesOutcome> => {
    let data;
    try {
      data = await db.selectFrom("analysis_rules").select(["settings", "updated_at"]).where("workspace_id", "=", workspaceId).executeTakeFirst();
    } catch {
      return { status: "error", message: "Couldn't save. Try again." };
    }
    // No row to compare against and the write didn't go through: the user can't write here.
    if (!data) return { status: "forbidden" };
    if (data.updated_at === version) return { status: "forbidden" };
    return { status: "conflict", rules: { settings: parseAnalysisSettings(data.settings).value, version: data.updated_at } };
  };

  if (version === null) {
    try {
      const data = await db
        .insertInto("analysis_rules")
        .values({ workspace_id: workspaceId, settings: stored })
        .returning(["settings", "updated_at"])
        .executeTakeFirstOrThrow();
      return { status: "saved", rules: { settings: parseAnalysisSettings(data.settings).value, version: data.updated_at } };
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
      .updateTable("analysis_rules")
      .set({ settings: stored })
      .where("workspace_id", "=", workspaceId)
      .where("updated_at", "=", version)
      .returning(["settings", "updated_at"])
      .execute();
  } catch (e) {
    return pgCode(e) === "42501" ? { status: "forbidden" } : { status: "error", message: "Couldn't save. Try again." };
  }
  const row = data[0];
  if (!row) return conflict();
  return { status: "saved", rules: { settings: parseAnalysisSettings(row.settings).value, version: row.updated_at } };
}
