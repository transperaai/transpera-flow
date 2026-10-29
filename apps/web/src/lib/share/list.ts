import "server-only";
import { loadMemberNames } from "@/lib/data";
import { shareStatus, type ShareStatus } from "@/lib/share/format";
import { getDb } from "@/lib/auth/session";

/** One row of the Share links page. Never the link itself or its copy: those aren't readable through the API. */
export interface ShareLinkRow {
  id: string;
  kind: "overview" | "process" | "issue" | "solution" | "scenario";
  /** A play link lets visitors try levers; nothing they do is saved (B4). */
  mode: "view" | "play";
  /** What it shows: "The Overview", a process's name, "Issue #12", a solution's name; null when it has since been deleted. */
  what: string | null;
  label: string | null;
  showPeople: boolean;
  showFinancials: boolean;
  emails: string[];
  expiresAt: string | null;
  snapshotAt: string;
  createdAt: string;
  madeBy: string;
  opens: number;
  lastOpenedAt: string | null;
  status: ShareStatus;
}

const COLUMNS = ["id", "kind", "mode", "target_id", "show_people", "show_financials", "allowed_emails", "expires_at", "label", "snapshot_at", "created_by", "created_at", "revoked_at", "opens", "last_opened_at"] as const;

/** The workspace's share links, newest first, as an Agency admin sees them (RLS decides: nobody else reads any). */
export async function loadShareLinks(workspaceId: string): Promise<ShareLinkRow[]> {
  const db = await getDb();
  const data = await db.selectFrom("share_links").select(COLUMNS).where("workspace_id", "=", workspaceId).orderBy("created_at", "desc").orderBy("id").execute();
  const ids = (kind: string) => [...new Set(data.filter((l) => l.kind === kind && l.target_id).map((l) => l.target_id!))];
  const [processes, issues, solutions, scenarios, members] = await Promise.all([
    ids("process").length ? db.selectFrom("processes").select(["id", "name"]).where("id", "in", ids("process")).execute() : ([] as { id: string; name: string }[]),
    ids("issue").length ? db.selectFrom("issues").select(["id", "number"]).where("id", "in", ids("issue")).execute() : ([] as { id: string; number: number | null }[]),
    ids("solution").length ? db.selectFrom("solutions").select(["id", "name"]).where("id", "in", ids("solution")).execute() : ([] as { id: string; name: string }[]),
    ids("scenario").length ? db.selectFrom("sandbox_scenarios").select(["id", "name"]).where("id", "in", ids("scenario")).execute() : ([] as { id: string; name: string }[]),
    loadMemberNames(workspaceId),
  ]);
  const scenarioName = new Map(scenarios.map((s) => [s.id, s.name]));
  const processName = new Map(processes.map((p) => [p.id, p.name]));
  const issueNumber = new Map(issues.map((i) => [i.id, i.number]));
  const solutionName = new Map(solutions.map((s) => [s.id, s.name]));
  const now = new Date();
  return data.map((l) => {
    const kind = l.kind as ShareLinkRow["kind"];
    const what =
      kind === "overview"
        ? "The Overview"
        : kind === "process"
          ? (processName.get(l.target_id ?? "") ?? null)
          : kind === "issue"
            ? issueNumber.has(l.target_id ?? "")
              ? `Issue #${issueNumber.get(l.target_id ?? "")}`
              : null
            : kind === "scenario"
              ? (scenarioName.get(l.target_id ?? "") ?? null)
              : (solutionName.get(l.target_id ?? "") ?? null);
    return {
      id: l.id,
      kind,
      mode: l.mode === "play" ? "play" : "view",
      what,
      label: l.label,
      showPeople: l.show_people,
      showFinancials: l.show_financials,
      emails: l.allowed_emails,
      expiresAt: l.expires_at,
      snapshotAt: l.snapshot_at,
      createdAt: l.created_at,
      madeBy: (l.created_by && members[l.created_by]) || "Someone on the team",
      opens: l.opens,
      lastOpenedAt: l.last_opened_at,
      status: shareStatus({ revokedAt: l.revoked_at, expiresAt: l.expires_at }, now),
    };
  });
}
