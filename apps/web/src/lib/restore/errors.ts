// What the restore route says when `import_workspace_bundle` refuses or fails (issue #39, B10 2b). Pure, so the route and its
// tests agree. Never echoes SQL: the database's own words are shown only for a failure inside a section, and only when they
// read as a sentence about the data (the rules the triggers state in plain words), never as a statement, a relation or a column.

export const ROLE_MESSAGE = "Only owners, editors and agency admins can restore a backup.";
export const NOT_EMPTY_MESSAGE = "Backups restore only into an empty workspace. Ask an agency admin to create a new workspace, then restore it there.";
export const TOO_BIG_MESSAGE = "This backup is too big to restore in one go (the database ran out of time). Nothing was restored.";
export const REFUSED_PLAN_MESSAGE = "This backup can't be restored as it is.";
export const FAILED_MESSAGE = "The restore failed. Nothing was restored. Try again.";

/** The plan sections, in words ("Couldn't restore <words>"). */
const SECTION_WORDS: Record<string, string> = {
  settings: "the workspace settings", roles: "the roles", people: "the people", person_roles: "the role assignments", person_leave: "the leave entries",
  lead_sources: "the lead sources", seasonality: "the seasonality", demand_settings: "the demand settings", churn_drivers: "the churn drivers",
  market_conditions: "the market conditions", market_schedule: "the market schedule", lever_settings: "the lever settings", analysis_rules: "the analysis rules",
  clients: "the clients", sources: "the sources", processes: "the processes", scenarios: "the scenarios", blocks: "the blocks", issues: "the issues",
  steps: "the steps and edges", services: "the services", service_servicing: "the servicing rules", client_groups: "the client groups",
  client_services: "the client services", client_assignments: "the client assignments", person_skills: "the skills", source_links: "the source links",
  suggestions: "the pending suggestions", proposals: "the pending proposals", archive: "the archived processes", log: "the import log",
};

export function sectionInWords(section: string): string {
  return SECTION_WORDS[section] ?? "part of the backup";
}

/** Words that say the message is the database talking about itself (a statement, a table, a column, a constraint), not about the data. */
const SQLISH = /\b(select|insert|update|delete|violates|relation|column|constraint|syntax|function|schema|permission denied|invalid input|duplicate key|null value|foreign key|check|policy|row-level)\b|[_]{1}[a-z]+_[a-z]+|::|"|\$\d/i;

/** The database's own sentence for a failed section, or a plain one when it isn't fit to show. */
function databaseSentence(message: string): string {
  const after = message.split("could not be restored:").slice(1).join("could not be restored:").trim();
  const sentence = after.replace(/\.+$/, "");
  if (!sentence || sentence.length > 300 || SQLISH.test(sentence)) return "a row didn't fit this workspace's rules";
  return sentence;
}

/**
 * What to add when the database refused the plan's shape or size (22023). Only the limits sentence is plain enough to show; the
 * other refusals (a wrong format, a list that isn't one, an id that isn't a placeholder) are about the plan, not the person's file.
 */
function planDetail(message: string): string {
  const m = /the plan is (over a limit|too big) \((.+)\)$/.exec(message);
  return m ? ` It is over a limit of a restore (${m[2]}).` : "";
}

export interface RestoreFailure {
  status: number;
  message: string;
}

export function restoreFailure(error: { code?: string | null; message?: string | null; hint?: string | null }): RestoreFailure {
  const hint = error.hint ?? "";
  if (hint === "not_empty") return { status: 409, message: NOT_EMPTY_MESSAGE };
  if (error.code === "57014") return { status: 504, message: TOO_BIG_MESSAGE };
  if (hint.startsWith("section:")) {
    const words = sectionInWords(hint.slice("section:".length));
    return { status: 422, message: `Couldn't restore ${words}: ${databaseSentence(error.message ?? "")}. Nothing was restored.` };
  }
  if (error.code === "42501") return { status: 403, message: ROLE_MESSAGE };
  if (error.code === "22023") return { status: 400, message: `${REFUSED_PLAN_MESSAGE}${planDetail(error.message ?? "")}` };
  return { status: 500, message: FAILED_MESSAGE };
}
