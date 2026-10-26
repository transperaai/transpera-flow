import type { Json } from "./database.types";
import type { PersonLabels } from "./person-labels";
import type { Db } from "./queries";
import { columns } from "./columns";
import { pgCode } from "./pg-error";
import { FINDING_TYPES, type FindingCitation, type FindingRating, type FindingRow, type FindingStatus, type FindingType } from "./types";

// Findings storage (issue #175, B17; decision D40; migration 20261205000000). Reads and writes run as the signed-in user,
// so RLS decides: every member reads, owners and editors write, nobody deletes. The trigger stamps who and when, starts an
// AI finding proposed and one by hand accepted, and refuses an "AI" finding that no analysis of the caller's wrote.
// Connector proposals (B20, #197, migration 20261212000000): Claude connected over MCP proposes an AI finding with no
// analysis; the trigger stamps `proposed_via = 'connector'` from the API token's claims and the key, and refuses anything
// else over a token (no accepted finding, no update). `proposeConnectorFinding` is the one write.

export const FINDING_COLUMNS =
  "id, workspace_id, process_id, step_id, origin, status, rating, type, title, evidence, why, facts, person_labels, source_ids, ai_key, analysis_id, run_id, edited, proposed_via, created_by, created_at, updated_by, updated_at, decided_by, decided_at";

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
  const data = await db
    .selectFrom("findings")
    .select(columns(FINDING_COLUMNS))
    .where("workspace_id", "=", workspaceId)
    .where("status", "in", [...statuses])
    .orderBy("created_at", "asc")
    .execute();
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

const failed = (error: unknown): FindingWrite => {
  const code = pgCode(error);
  const message = error instanceof Error ? error.message : undefined;
  return code === "42501" ? { status: "forbidden" } : code === "23514" ? { status: "invalid", message: message ?? "That isn't allowed." } : { status: "error", message: "Couldn't save. Try again." };
};

/** Add a finding by hand (it starts accepted). */
export async function createManualFinding(db: Db, workspaceId: string, d: FindingDraft): Promise<FindingWrite> {
  const problem = findingDraftProblem(d);
  if (problem) return { status: "invalid", message: problem };
  try {
    const data = await db
      .insertInto("findings")
      .values({ workspace_id: workspaceId, origin: "manual", status: "accepted", ...draftColumns(d) })
      .returning(columns(FINDING_COLUMNS))
      .executeTakeFirstOrThrow();
    return { status: "saved", finding: data as unknown as FindingRow };
  } catch (e) {
    return failed(e);
  }
}

/** Edit a finding (AI or by hand), optionally deciding it in the same write: an edited proposal can be accepted at once. */
export async function updateFinding(db: Db, id: string, d: FindingDraft, status?: "accepted"): Promise<FindingWrite> {
  const problem = findingDraftProblem(d);
  if (problem) return { status: "invalid", message: problem };
  let data;
  try {
    data = await db
      .updateTable("findings")
      .set({ ...draftColumns(d), ...(status ? { status } : {}) })
      .where("id", "=", id)
      .returning(columns(FINDING_COLUMNS))
      .execute();
  } catch (e) {
    return failed(e);
  }
  if (!data.length) return { status: "forbidden" };
  return { status: "saved", finding: data[0] as unknown as FindingRow };
}

/** Accept or dismiss a finding (or accept a dismissed one again). */
export async function setFindingStatus(db: Db, id: string, status: "accepted" | "dismissed"): Promise<FindingWrite> {
  let data;
  try {
    data = await db.updateTable("findings").set({ status }).where("id", "=", id).returning(columns(FINDING_COLUMNS)).execute();
  } catch (e) {
    return failed(e);
  }
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
  /** The labels its title, evidence, why and facts use, and the person each stands for (B1 2b). */
  personLabels: PersonLabels;
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
  // supabase-js returned `{ error }`; this function reports a failed statement as `{ error: message }` too.
  const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
  try {
  if (keys.length) {
    const same = await db
      .selectFrom("findings")
      .select(["id", "ai_key", "process_id", "status"])
      .where("workspace_id", "=", input.workspaceId)
      .where("origin", "=", "ai")
      .where("ai_key", "in", keys)
      .execute();
    for (const r of same) known.set(where(r.process_id, r.ai_key ?? ""), { id: r.id, status: r.status as FindingStatus });
  }
  const content = (f: ProposedFinding) => ({
    step_id: f.stepId,
    rating: f.rating,
    type: f.type,
    title: f.title.slice(0, FINDING_LIMITS.title),
    evidence: f.evidence.slice(0, FINDING_LIMITS.evidence),
    why: f.why.slice(0, FINDING_LIMITS.why),
    facts: f.facts.slice(0, FINDING_LIMITS.facts) as unknown as Json,
    person_labels: f.personLabels as unknown as Json,
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
    await db
      .insertInto("findings")
      .values(fresh.map((f) => ({ workspace_id: input.workspaceId, process_id: f.processId, origin: "ai", ai_key: f.aiKey, ...content(f) })))
      .execute();
  }
  for (const { id, f } of again) {
    await db.updateTable("findings").set(content(f)).where("id", "=", id).execute();
  }
  // The proposals still open in this scope (made by an analysis stored against it) that an earlier run made.
  const open = await db
    .selectFrom("findings")
    .innerJoin("ai_analyses", "ai_analyses.id", "findings.analysis_id")
    .select(["findings.id", "findings.run_id"])
    .where("findings.workspace_id", "=", input.workspaceId)
    .where("findings.origin", "=", "ai")
    .where("findings.status", "=", "proposed")
    .where("ai_analyses.process_id", "=", input.scope)
    .execute();
  const stale = open.filter((r) => r.run_id !== input.runId).map((r) => r.id);
  if (stale.length) {
    await db.updateTable("findings").set({ status: "superseded" }).where("id", "in", stale).execute();
  }
  return { added: fresh.length, renewed: again.length, superseded: stale.length };
  } catch (e) {
    return { error: message(e) };
  }
}

/** What Claude proposes over the connector (B20): a finding with its place, words, the facts and sources it cites, and the labels it uses. */
export interface ConnectorFindingInput {
  workspaceId: string;
  processId: string | null;
  stepId: string | null;
  rating: FindingRating;
  type: FindingType;
  title: string;
  evidence: string;
  why: string;
  facts: FindingCitation[];
  sourceIds: string[];
  /** The labels its title, evidence, why and facts use, and the person each stands for (B1 2b). */
  personLabels: PersonLabels;
}

export type ConnectorFindingWrite = FindingWrite | { status: "duplicate" } | { status: "limit"; message: string };

/**
 * Propose a finding over the connector (B20, #197): an AI finding that starts proposed with no analysis. Call it with the
 * API token's client: the database stamps `proposed_via` and the key from the token, and refuses anything but a proposal.
 * The same place and title twice is `duplicate` (the unique key, even if a person has since accepted or dismissed it);
 * the workspace's caps are `limit`.
 */
export async function proposeConnectorFinding(db: Db, input: ConnectorFindingInput): Promise<ConnectorFindingWrite> {
  const problem = findingDraftProblem({ ...input, sourceIds: input.sourceIds });
  if (problem) return { status: "invalid", message: problem };
  // Never drop a citation silently: a finding rests on what it says it rests on.
  if (input.facts.length > FINDING_LIMITS.facts) return { status: "invalid", message: `A finding can rest on at most ${FINDING_LIMITS.facts} facts and quotes together.` };
  try {
    const data = await db
      .insertInto("findings")
      .values({
      workspace_id: input.workspaceId,
      process_id: input.processId,
      step_id: input.stepId,
      origin: "ai",
      status: "proposed",
      rating: input.rating,
      type: input.type,
      title: input.title.trim(),
      evidence: input.evidence.trim(),
      why: input.why.trim(),
      facts: input.facts as unknown as Json,
      source_ids: input.sourceIds,
      person_labels: input.personLabels as unknown as Json,
    })
      .returning(columns(FINDING_COLUMNS))
      .executeTakeFirstOrThrow();
    return { status: "saved", finding: data as unknown as FindingRow };
  } catch (e) {
    const code = pgCode(e);
    if (code === "23505") return { status: "duplicate" };
    if (code === "54000") return { status: "limit", message: (e instanceof Error ? e.message : "").replace(/^findings: /, "") };
    return failed(e);
  }
}
