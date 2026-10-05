import type { Json } from "./database.types";
import type { Db } from "./queries";
import { FINDING_TYPES, type FindingCitation, type FindingRating, type FindingRow, type FindingStatus, type FindingType } from "./types";

// Findings storage (issue #175, B17; decision D40; migration 20261205000000). Reads and writes run as the signed-in user,
// so RLS decides: every member reads, owners and editors write, nobody deletes. The trigger stamps who and when, starts an
// AI finding proposed and one by hand accepted, and refuses an "AI" finding that no analysis of the caller's wrote.

export const FINDING_COLUMNS =
  "id, workspace_id, process_id, step_id, origin, status, rating, type, title, evidence, why, facts, source_ids, ai_key, analysis_id, created_by, created_at, updated_by, updated_at, decided_by, decided_at";

export const FINDING_LIMITS = { title: 200, evidence: 2000, why: 2000, facts: 30, sources: 20 } as const;

/** The key an issue acknowledged from a finding carries (`issues.detected_key`), which matches the shape that column checks. */
export const findingKey = (f: Pick<FindingRow, "id" | "origin">): string => `finding:${f.origin === "ai" ? "ai" : "by_hand"}:${f.id}`;

/** The finding id in an issue's `detected_key`, if it came from a finding. */
export function findingIdOfKey(key: string | null | undefined): string | null {
  const m = /^finding:(?:ai|by_hand):([0-9a-f-]{36})$/i.exec(key ?? "");
  return m ? m[1]!.toLowerCase() : null;
}

/** Citations stored on a finding, read forgivingly: anything not the right shape is left out. */
export function readCitations(json: Json | unknown): FindingCitation[] {
  if (!Array.isArray(json)) return [];
  const out: FindingCitation[] = [];
  for (const c of json) {
    if (!c || typeof c !== "object" || Array.isArray(c)) continue;
    const o = c as Record<string, unknown>;
    const kind = o.kind === "quote" ? "quote" : o.kind === "fact" ? "fact" : null;
    if (!kind || typeof o.key !== "string" || typeof o.text !== "string" || !o.text.trim()) continue;
    out.push({ kind, key: o.key.slice(0, 300), text: o.text.slice(0, 1000) });
  }
  return out.slice(0, FINDING_LIMITS.facts);
}

/** Every finding of a workspace that a page may show or review (dismissed and superseded ones stay in the table, unread). */
export async function loadFindings(db: Db, workspaceId: string, statuses: readonly FindingStatus[] = ["proposed", "accepted"]): Promise<FindingRow[]> {
  const { data, error } = await db
    .from("findings")
    .select(FINDING_COLUMNS)
    .eq("workspace_id", workspaceId)
    .in("status", [...statuses])
    .order("created_at", { ascending: true });
  if (error) throw error;
  return data as unknown as FindingRow[];
}

/** What a person writes on a finding (adding one by hand, or editing any). */
export interface FindingDraft {
  processId: string | null;
  stepId: string | null;
  rating: FindingRating;
  type: FindingType;
  title: string;
  evidence: string;
  why: string;
  sourceIds?: string[];
}

/** Why a draft can't be saved, in words; null when it can. */
export function findingDraftProblem(d: FindingDraft): string | null {
  if (!d.title.trim()) return "Give the finding a title.";
  if (d.title.trim().length > FINDING_LIMITS.title) return `Keep the title under ${FINDING_LIMITS.title} characters.`;
  if (d.evidence.length > FINDING_LIMITS.evidence || d.why.length > FINDING_LIMITS.why) return `Keep the evidence and why it matters under ${FINDING_LIMITS.evidence} characters each.`;
  if (!["risk", "bad", "good", "great"].includes(d.rating)) return "Pick a rating.";
  if (!(FINDING_TYPES as readonly string[]).includes(d.type)) return "Pick a kind.";
  if ((d.sourceIds?.length ?? 0) > FINDING_LIMITS.sources) return `Cite at most ${FINDING_LIMITS.sources} sources.`;
  return null;
}

const draftColumns = (d: FindingDraft) => ({
  process_id: d.processId,
  step_id: d.stepId,
  rating: d.rating,
  type: d.type,
  title: d.title.trim(),
  evidence: d.evidence.trim(),
  why: d.why.trim(),
  ...(d.sourceIds ? { source_ids: d.sourceIds } : {}),
});

export type FindingWrite = { status: "saved"; finding: FindingRow } | { status: "invalid"; message: string } | { status: "forbidden" } | { status: "error"; message: string };

const failed = (error: { code?: string; message?: string }): FindingWrite =>
  error.code === "42501" ? { status: "forbidden" } : error.code === "23514" ? { status: "invalid", message: error.message ?? "That isn't allowed." } : { status: "error", message: "Couldn't save. Try again." };

/** Add a finding by hand (it starts accepted). */
export async function createManualFinding(db: Db, workspaceId: string, d: FindingDraft): Promise<FindingWrite> {
  const problem = findingDraftProblem(d);
  if (problem) return { status: "invalid", message: problem };
  const { data, error } = await db
    .from("findings")
    .insert({ workspace_id: workspaceId, origin: "manual", status: "accepted", ...draftColumns(d) })
    .select(FINDING_COLUMNS)
    .single();
  if (error) return failed(error);
  return { status: "saved", finding: data as unknown as FindingRow };
}

/** Edit a finding (AI or by hand), optionally deciding it in the same write: an edited proposal can be accepted at once. */
export async function updateFinding(db: Db, id: string, d: FindingDraft, status?: "accepted"): Promise<FindingWrite> {
  const problem = findingDraftProblem(d);
  if (problem) return { status: "invalid", message: problem };
  const { data, error } = await db
    .from("findings")
    .update({ ...draftColumns(d), ...(status ? { status } : {}) })
    .eq("id", id)
    .select(FINDING_COLUMNS);
  if (error) return failed(error);
  if (!data.length) return { status: "forbidden" };
  return { status: "saved", finding: data[0] as unknown as FindingRow };
}

/** Accept or dismiss a finding (or accept a dismissed one again). */
export async function setFindingStatus(db: Db, id: string, status: "accepted" | "dismissed"): Promise<FindingWrite> {
  const { data, error } = await db.from("findings").update({ status }).eq("id", id).select(FINDING_COLUMNS);
  if (error) return failed(error);
  if (!data.length) return { status: "forbidden" };
  return { status: "saved", finding: data[0] as unknown as FindingRow };
}

/** One AI finding as an analysis proposes it. */
export interface ProposedFinding {
  aiKey: string;
  processId: string | null;
  stepId: string | null;
  rating: FindingRating;
  type: FindingType;
  title: string;
  evidence: string;
  why: string;
  facts: FindingCitation[];
}

/**
 * Store what an analysis proposed (issue #175): each new finding as proposed, citing the analysis. A finding already
 * there with the same key (proposed, accepted or dismissed: a person's decision stands, D38) is left as it is. The earlier
 * proposals of the same scope that this analysis didn't make again are superseded, so the review list holds only what the
 * latest analysis says. `scope` is the process the analysis is stored against (the company map's process for the whole company). Returns how many were added and superseded.
 */
export async function storeProposedFindings(
  db: Db,
  input: { workspaceId: string; analysisId: string; scope: string; findings: readonly ProposedFinding[]; skipKeys?: ReadonlySet<string> },
): Promise<{ added: number; superseded: number } | { error: string }> {
  const keys = input.findings.map((f) => f.aiKey);
  const existing = await db.from("findings").select("id, ai_key, process_id, status, analysis_id").eq("workspace_id", input.workspaceId).eq("origin", "ai");
  if (existing.error) return { error: existing.error.message };
  const known = new Set(existing.data.map((r) => `${r.process_id ?? ""}|${r.ai_key}`));
  const fresh = input.findings.filter((f) => !known.has(`${f.processId ?? ""}|${f.aiKey}`) && !input.skipKeys?.has(f.aiKey));
  if (fresh.length) {
    const { error } = await db.from("findings").insert(
      fresh.map((f) => ({
        workspace_id: input.workspaceId,
        process_id: f.processId,
        step_id: f.stepId,
        origin: "ai",
        status: "proposed",
        rating: f.rating,
        type: f.type,
        title: f.title.slice(0, FINDING_LIMITS.title),
        evidence: f.evidence.slice(0, FINDING_LIMITS.evidence),
        why: f.why.slice(0, FINDING_LIMITS.why),
        facts: f.facts.slice(0, FINDING_LIMITS.facts) as unknown as Json,
        ai_key: f.aiKey,
        analysis_id: input.analysisId,
      })),
    );
    if (error) return { error: error.message };
  }
  // Earlier proposals of this scope (made by an analysis of the same process, or of the company) not proposed again.
  const scopeAnalyses = await db.from("ai_analyses").select("id").eq("workspace_id", input.workspaceId).eq("process_id", input.scope);
  const stale = existing.data.filter(
    (r) => r.status === "proposed" && r.analysis_id && r.analysis_id !== input.analysisId && !keys.includes(r.ai_key ?? "") && (scopeAnalyses.data ?? []).some((a) => a.id === r.analysis_id),
  );
  if (stale.length) {
    const { error } = await db.from("findings").update({ status: "superseded" }).in("id", stale.map((r) => r.id));
    if (error) return { error: error.message };
  }
  return { added: fresh.length, superseded: stale.length };
}
