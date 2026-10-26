import { normalizeFirstPrinciples, oversizedParts, type FirstPrinciples } from "@transpera-flow/engine";
import type { Json } from "./db-types";
import type { Db } from "./queries";
import { columns } from "./columns";
import { pgCode } from "./pg-error";
import type { FirstPrinciplesRow } from "./types";

// First principles per process revision (issue #119, A54). One row per revision; edits go into the draft (the
// database refuses a published or superseded revision). Reads and writes run as the signed-in user, so RLS decides:
// every member reads, owners and editors write. What the answers mean, and the rule checks, are in the engine
// (packages/engine/src/first-principles.ts); this module only stores and finds them.

export const FIRST_PRINCIPLES_COLUMNS =
  "id, workspace_id, process_id, revision_id, job_who, job_progress, job_situation, job_done, statements, requirements, deletes, improvements, why_problem, why_chain, root_cause, measures, updated_at" as const;

/** A stored row as the app's shape (never throws: bad JSON reads as empty, see `normalizeFirstPrinciples`). */
export function firstPrinciplesFromRow(row: FirstPrinciplesRow): FirstPrinciples {
  return normalizeFirstPrinciples({
    job: { who: row.job_who, progress: row.job_progress, situation: row.job_situation, done: row.job_done },
    statements: row.statements,
    requirements: row.requirements,
    deletes: row.deletes,
    improvements: row.improvements,
    why: { problem: row.why_problem, chain: row.why_chain, root: row.root_cause },
    measures: row.measures,
  });
}

/** The columns to write for these answers (cleaned first, so what is stored is what `normalizeFirstPrinciples` returns). */
export function firstPrinciplesToColumns(doc: FirstPrinciples): Omit<FirstPrinciplesRow, "id" | "workspace_id" | "process_id" | "revision_id" | "updated_at"> {
  const d = normalizeFirstPrinciples(doc);
  return {
    job_who: d.job.who,
    job_progress: d.job.progress,
    job_situation: d.job.situation,
    job_done: d.job.done,
    statements: d.statements as unknown as Json,
    requirements: d.requirements as unknown as Json,
    deletes: d.deletes as unknown as Json,
    improvements: d.improvements as unknown as Json,
    why_problem: d.why.problem,
    why_chain: d.why.chain as unknown as Json,
    root_cause: d.why.root,
    measures: d.measures as unknown as Json,
  };
}

export interface ResolvedFirstPrinciples {
  /** The answers for the revision, or null when it and every earlier revision have none ("not started"). */
  doc: FirstPrinciples | null;
  /**
   * The revision's own row's `updated_at`, which a save must quote to prove it saw the latest. Null when the
   * revision has no row of its own (its answers, if any, are inherited), so the next save inserts one.
   */
  version: string | null;
  /** The number of the earlier revision the answers come from, when the revision has none of its own. */
  inheritedFrom: number | null;
}

/**
 * The first principles of a revision: its own row, else the row of the nearest earlier revision (a draft opened from
 * live starts with live's; a version published without a row of its own keeps the one before). Pure.
 */
export function resolveFirstPrinciples(
  revisions: readonly { id: string; number: number }[],
  rows: readonly Pick<FirstPrinciplesRow, "revision_id" | "updated_at" | "job_who" | "job_progress" | "job_situation" | "job_done" | "statements" | "requirements" | "deletes" | "improvements" | "why_problem" | "why_chain" | "root_cause" | "measures">[],
  revisionId: string,
): ResolvedFirstPrinciples {
  const own = rows.find((r) => r.revision_id === revisionId);
  const full = (r: (typeof rows)[number]) => firstPrinciplesFromRow(r as FirstPrinciplesRow);
  if (own) return { doc: full(own), version: own.updated_at, inheritedFrom: null };
  const here = revisions.find((r) => r.id === revisionId);
  if (!here) return { doc: null, version: null, inheritedFrom: null };
  const number = new Map(revisions.map((r) => [r.id, r.number]));
  const earlier = rows
    .filter((r) => (number.get(r.revision_id) ?? Infinity) < here.number)
    .sort((a, b) => number.get(b.revision_id)! - number.get(a.revision_id)!)[0];
  return earlier ? { doc: full(earlier), version: null, inheritedFrom: number.get(earlier.revision_id)! } : { doc: null, version: null, inheritedFrom: null };
}

/** Whether two revisions' resolved answers differ (an empty one counts as none): a change between a draft and live. */
export function firstPrinciplesDiffer(a: ResolvedFirstPrinciples, b: ResolvedFirstPrinciples): boolean {
  return JSON.stringify(a.doc) !== JSON.stringify(b.doc);
}

/** Load the first principles of several revisions of a process (each own or inherited), in one read. */
export async function loadFirstPrinciplesFor(db: Db, processId: string, revisionIds: readonly string[]): Promise<Record<string, ResolvedFirstPrinciples>> {
  const [revisions, rows] = await Promise.all([
    db.selectFrom("process_revisions").select(["id", "number"]).where("process_id", "=", processId).execute(),
    db.selectFrom("first_principles").select(columns(FIRST_PRINCIPLES_COLUMNS)).where("process_id", "=", processId).execute(),
  ]);
  return Object.fromEntries(revisionIds.map((id) => [id, resolveFirstPrinciples(revisions, rows as unknown as FirstPrinciplesRow[], id)]));
}

/** Load the first principles of one revision of a process (own or inherited). */
export async function loadFirstPrinciples(db: Db, processId: string, revisionId: string): Promise<ResolvedFirstPrinciples> {
  return (await loadFirstPrinciplesFor(db, processId, [revisionId]))[revisionId]!;
}

export interface FirstPrinciplesOwner {
  workspaceId: string;
  processId: string;
  revisionId: string;
}

export type SaveFirstPrinciplesOutcome =
  | { status: "saved"; version: string }
  /** Someone saved since `version`: their answers, to merge or overwrite. */
  | { status: "conflict"; doc: FirstPrinciples; version: string }
  /** No permission (viewers and members can't write). */
  | { status: "forbidden" }
  /** The revision isn't a draft any more (it was published or discarded). */
  | { status: "not_draft" }
  /** Too large to store (see `oversizedParts`). */
  | { status: "invalid"; message: string }
  | { status: "error"; message: string };

/**
 * Save the whole document to a revision. `version` is the revision's own row's `updated_at` as last loaded, or null
 * when it had no row: the save goes through only if no one has saved since (compare-and-set), so two people editing
 * at once are told instead of one silently undoing the other.
 */
export async function saveFirstPrinciples(db: Db, owner: FirstPrinciplesOwner, doc: FirstPrinciples, version: string | null): Promise<SaveFirstPrinciplesOutcome> {
  const big = oversizedParts(normalizeFirstPrinciples(doc));
  if (big.length) return { status: "invalid", message: "That is too much text to save. Shorten the longer answers." };
  const cols = firstPrinciplesToColumns(doc);
  const fail = (error: unknown): SaveFirstPrinciplesOutcome => {
    const code = pgCode(error);
    if (code === "42501") return { status: "forbidden" };
    if (code === "55000") return { status: "not_draft" };
    return { status: "error", message: "Couldn't save. Try again." };
  };
  const conflict = async (): Promise<SaveFirstPrinciplesOutcome> => {
    let data;
    try {
      data = await db.selectFrom("first_principles").select(columns(FIRST_PRINCIPLES_COLUMNS)).where("revision_id", "=", owner.revisionId).executeTakeFirst();
    } catch {
      return { status: "error", message: "Couldn't save. Try again." };
    }
    // Nothing to compare against and the write didn't go through: the user can't write here.
    if (!data || data.updated_at === version) return { status: "forbidden" };
    return { status: "conflict", doc: firstPrinciplesFromRow(data as unknown as FirstPrinciplesRow), version: data.updated_at };
  };

  if (version === null) {
    try {
      const data = await db
        .insertInto("first_principles")
        .values({ workspace_id: owner.workspaceId, process_id: owner.processId, revision_id: owner.revisionId, ...cols })
        .returning("updated_at")
        .executeTakeFirstOrThrow();
      return { status: "saved", version: data.updated_at };
    } catch (e) {
      if (pgCode(e) === "23505") return conflict();
      return fail(e);
    }
  }

  let data;
  try {
    data = await db
      .updateTable("first_principles")
      .set(cols)
      .where("revision_id", "=", owner.revisionId)
      .where("updated_at", "=", version)
      .returning("updated_at")
      .execute();
  } catch (e) {
    return fail(e);
  }
  const row = data[0];
  if (!row) return conflict();
  return { status: "saved", version: row.updated_at };
}
