import "server-only";
import { loadMemberNames } from "@/lib/data";
import { shareStatus, type ShareStatus } from "@/lib/share/format";
import { createClient } from "@/lib/supabase/server";

/** One row of the Share links page. Never the link itself or its copy: those aren't readable through the API. */
export interface ShareLinkRow {
  id: string;
  kind: "overview" | "process" | "issue" | "solution";
  /** A play link lets visitors try levers and send ideas (B4). */
  mode: "view" | "play";
  /** Ideas sent from a play link, all time: those still in Suggestions and those dealt with. Null for a view link. */
  ideas: number | null;
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

const COLUMNS = "id, kind, mode, target_id, show_people, show_financials, allowed_emails, expires_at, label, snapshot_at, created_by, created_at, revoked_at, opens, last_opened_at" as const;

/** The workspace's share links, newest first, as an owner or editor sees them (RLS decides: nobody else reads any). */
export async function loadShareLinks(workspaceId: string): Promise<ShareLinkRow[]> {
  const db = await createClient();
  const { data, error } = await db.from("share_links").select(COLUMNS).eq("workspace_id", workspaceId).order("created_at", { ascending: false }).order("id");
  if (error) throw error;
  const ids = (kind: string) => [...new Set(data.filter((l) => l.kind === kind && l.target_id).map((l) => l.target_id!))];
  const playIds = data.filter((l) => l.mode === "play").map((l) => l.id);
  const [processes, issues, solutions, members, sent] = await Promise.all([
    ids("process").length ? db.from("processes").select("id, name").in("id", ids("process")) : { data: [] as { id: string; name: string }[] },
    ids("issue").length ? db.from("issues").select("id, number").in("id", ids("issue")) : { data: [] as { id: string; number: number | null }[] },
    ids("solution").length ? db.from("solutions").select("id, name").in("id", ids("solution")) : { data: [] as { id: string; name: string }[] },
    loadMemberNames(workspaceId),
    // Ideas sent from each play link: one query for the page.
    playIds.length ? db.from("suggestion_proposals").select("share_link_id").eq("workspace_id", workspaceId).in("share_link_id", playIds).limit(5000) : { data: [] as { share_link_id: string | null }[] },
  ]);
  const ideasOf = new Map<string, number>();
  for (const r of sent.data ?? []) if (r.share_link_id) ideasOf.set(r.share_link_id, (ideasOf.get(r.share_link_id) ?? 0) + 1);
  const processName = new Map((processes.data ?? []).map((p) => [p.id, p.name]));
  const issueNumber = new Map((issues.data ?? []).map((i) => [i.id, i.number]));
  const solutionName = new Map((solutions.data ?? []).map((s) => [s.id, s.name]));
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
            : (solutionName.get(l.target_id ?? "") ?? null);
    return {
      id: l.id,
      kind,
      mode: l.mode === "play" ? "play" : "view",
      ideas: l.mode === "play" ? (ideasOf.get(l.id) ?? 0) : null,
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
