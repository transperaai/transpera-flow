import type { Json } from "./database.types";
import type { Db } from "./queries";
import { FINDING_TYPES, type FindingCitation, type FindingRating, type FindingRow, type FindingStatus, type FindingType } from "./types";

// Findings storage (issue #175, B17; decision D40; migration 20261205000000). Reads and writes run as the signed-in user,
// so RLS decides: every member reads, owners and editors write, nobody deletes. The trigger stamps who and when, starts an
// AI finding proposed and one by hand accepted, and refuses an "AI" finding that no analysis of the caller's wrote.

export const FINDING_COLUMNS =
  "id, workspace_id, process_id, step_id, origin, status, rating, type, title, evidence, why, facts, source_ids, ai_key, analysis_id, run_id, edited, created_by, created_at, updated_by, updated_at, decided_by, decided_at";

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
 * Store what one run of an analysis proposed (issue #175). A finding new to this place is added as proposed, citing the
 * analysis and the run. One already there with the same key that is still proposed, or was superseded, is proposed again
 * with what this run wrote; one a person decided (accepted or dismissed: their decision stands, D38) is left as it is.
 * Then the proposals of the same scope that an earlier run made and this one didn't make again are superseded, so the
 * review list holds only what the latest run says. Runs, not analyses, tell them apart: an analysis is kept one per
 * version, so a second run on the same version keeps its id. `scope` is the process the analysis is stored against (the
 * company map's process for the whole company). Reads only the rows with the keys proposed now and the proposals still
 * open in this scope, never the whole table.
 */
export async function storeProposedFindings(
  db: Db,
  input: { workspaceId: string; analysisId: string; runId: string; scope: string; findings: readonly ProposedFinding[]; skipKeys?: ReadonlySet<string> },
): Promise<{ added: number; renewed: number; superseded: number } | { error: string }> {
  const wanted = input.findings.filter((f) => !input.skipKeys?.has(f.aiKey));
  const keys = [...new Set(wanted.map((f) => f.aiKey))];
  const where = (processId: string | null, key: string) => `${processId ?? ""}|${key}`;
  const known = new Map<string, { id: string; status: FindingStatus }>();
  if (keys.length) {
    const same = await db.from("findings").select("id, ai_key, process_id, status").eq("workspace_id", input.workspaceId).eq("origin", "ai").in("ai_key", keys);
    if (same.error) return { error: same.error.message };
    for (const r of same.data) known.set(where(r.process_id, r.ai_key ?? ""), { id: r.id, status: r.status as FindingStatus });
  }
  const content = (f: ProposedFinding) => ({
    step_id: f.stepId,
    rating: f.rating,
    type: f.type,
    title: f.title.slice(0, FINDING_LIMITS.title),
    evidence: f.evidence.slice(0, FINDING_LIMITS.evidence),
    why: f.why.slice(0, FINDING_LIMITS.why),
    facts: f.facts.slice(0, FINDING_LIMITS.facts) as unknown as Json,
    analysis_id: input.analysisId,
    run_id: input.runId,
    status: "proposed",
  });
  const fresh = wanted.filter((f) => !known.has(where(f.processId, f.aiKey)));
  const again = wanted.flatMap((f) => {
    const r = known.get(where(f.processId, f.aiKey));
    return r && (r.status === "proposed" || r.status === "superseded") ? [{ id: r.id, f }] : [];
  });
  if (fresh.length) {
    const { error } = await db.from("findings").insert(fresh.map((f) => ({ workspace_id: input.workspaceId, process_id: f.processId, origin: "ai", ai_key: f.aiKey, ...content(f) })));
    if (error) return { error: error.message };
  }
  for (const { id, f } of again) {
    const { error } = await db.from("findings").update(content(f)).eq("id", id);
    if (error) return { error: error.message };
  }
  // The proposals still open in this scope (made by an analysis stored against it) that an earlier run made.
  const open = await db
    .from("findings")
    .select("id, run_id, ai_analyses!inner(process_id)")
    .eq("workspace_id", input.workspaceId)
    .eq("origin", "ai")
    .eq("status", "proposed")
    .eq("ai_analyses.process_id", input.scope);
  if (open.error) return { error: open.error.message };
  const stale = open.data.filter((r) => r.run_id !== input.runId).map((r) => r.id);
  if (stale.length) {
    const { error } = await db.from("findings").update({ status: "superseded" }).in("id", stale);
    if (error) return { error: error.message };
  }
  return { added: fresh.length, renewed: again.length, superseded: stale.length };
}
