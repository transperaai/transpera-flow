// Narration with the `narrations` table as record and cache (issue #29;
// docs/PRD.md §7.3: "Cached per run/comparison in `narrations`. On demand
// only, never per run"; docs/adr/0011-narration.md). Everything runs as the
// caller under RLS (the web user, or an API token's user through MCP).
//
// - A cached narration is reused only after it passes the number check again
//   against today's facts, so a hand-edited row can't smuggle in a figure.
// - A cached fallback for figures the model invented twice is reused too
//   (redrafting costs money and would likely fail the same way) unless the
//   caller asks to regenerate; a fallback for a timeout or an API error is
//   retried next time.
// - A daily cap per workspace bounds the cost.

import type { Db, Json } from "@transpera-flow/db";
import { editCheck, type NarrationInput } from "./facts";
import { checkText, narrate, type NarrationModel, type NarrationOutcome } from "./narrate";

/** Narrations (new drafts, not cache hits) a workspace may make in 24 hours. */
export const NARRATION_DAILY_LIMIT = 60;

export interface StoredNarration extends NarrationOutcome {
  /** The `narrations` row, or null when it couldn't be written. */
  id: string | null;
  /** Served from the cache: no API call. */
  cached: boolean;
  /** When the text was drafted. */
  at: string;
  editedBy: string | null;
  editedAt: string | null;
}

export interface NarrationRequest {
  workspaceId: string;
  /** The saved run the text describes. */
  targetId: string;
  input: NarrationInput;
  model: NarrationModel | null;
  /** Ignore the cache and draft again. */
  regenerate?: boolean;
  now?: () => Date;
  budgetMs?: number;
}

const paragraphsOf = (text: string) =>
  text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);

type Row = {
  id: string;
  text: string;
  validated: boolean;
  fallback: boolean;
  fallback_kind: string | null;
  fallback_reason: string | null;
  model: string | null;
  rejected: Json;
  usage: Json;
  edited_by_name: string | null;
  edited_at: string | null;
  updated_at: string;
  created_at: string;
};

const COLUMNS = ["id", "text", "validated", "fallback", "fallback_kind", "fallback_reason", "model", "rejected", "usage", "edited_by_name", "edited_at", "updated_at", "created_at"] as const;

/** The cached row for this input, if any. */
export async function findNarration(db: Db, workspaceId: string, targetId: string, input: NarrationInput): Promise<Row | null> {
  const data = await db
    .selectFrom("narrations")
    .select(COLUMNS)
    .where("workspace_id", "=", workspaceId)
    .where("target", "=", "run")
    .where("target_id", "=", targetId)
    .where("purpose", "=", input.purpose)
    .where("input_hash", "=", input.hash)
    .executeTakeFirst();
  return (data as Row | undefined) ?? null;
}

/** A cached row as an outcome, if it can be used as it is. */
export function fromCache(row: Row, input: NarrationInput): StoredNarration | null {
  const base = {
    id: row.id,
    cached: true,
    at: row.created_at,
    model: row.model,
    rejected: (Array.isArray(row.rejected) ? row.rejected : []) as unknown as NarrationOutcome["rejected"],
    usage: [],
    editedBy: row.edited_by_name,
    editedAt: row.edited_at,
  };
  if (row.validated) {
    const paragraphs = paragraphsOf(row.text);
    const check = checkText(paragraphs, editCheck(input));
    if (!check.ok) return null;
    return { ...base, source: "narration", paragraphs, validated: true, fallback: false, fallbackKind: null, reason: null, checked: check.numbers.length };
  }
  if (row.fallback_kind === "invalid") {
    return { ...base, source: "template", paragraphs: input.template, validated: false, fallback: true, fallbackKind: "invalid", reason: row.fallback_reason, checked: 0 };
  }
  return null;
}

async function draftsToday(db: Db, workspaceId: string, now: Date): Promise<number> {
  const since = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  try {
    const r = await db
      .selectFrom("narrations")
      .select((eb) => eb.fn.countAll<number>().as("count"))
      .where("workspace_id", "=", workspaceId)
      .where("updated_at", ">=", since)
      .executeTakeFirstOrThrow();
    return Number(r.count);
  } catch {
    return 0;
  }
}

/** Narration for `input`: from the cache, or drafted, checked and recorded. Never throws for model problems. */
export async function cachedNarration(db: Db, req: NarrationRequest): Promise<StoredNarration> {
  const now = req.now ?? (() => new Date());
  if (!req.regenerate) {
    const row = await findNarration(db, req.workspaceId, req.targetId, req.input);
    const hit = row ? fromCache(row, req.input) : null;
    if (hit) return hit;
  }
  let outcome: NarrationOutcome;
  if (req.model && (await draftsToday(db, req.workspaceId, now())) >= NARRATION_DAILY_LIMIT) {
    outcome = {
      source: "template",
      paragraphs: req.input.template,
      validated: false,
      fallback: true,
      fallbackKind: "unavailable",
      reason: `this workspace has used its ${NARRATION_DAILY_LIMIT} narrations for the day`,
      model: null,
      rejected: [],
      checked: 0,
      usage: [],
    };
  } else {
    outcome = await narrate(req.input, req.model, req.budgetMs ? { budgetMs: req.budgetMs } : {});
  }
  const at = now().toISOString();
  const values = {
    workspace_id: req.workspaceId,
    target: "run",
    target_id: req.targetId,
    purpose: req.input.purpose,
    input_hash: req.input.hash,
    model: outcome.model,
    text: outcome.paragraphs.join("\n\n"),
    validated: outcome.validated,
    fallback: outcome.fallback,
    fallback_kind: outcome.fallbackKind,
    fallback_reason: outcome.reason?.slice(0, 2000) ?? null,
    checked: outcome.checked,
    // jsonb parameters go as JSON text.
    rejected: JSON.stringify(outcome.rejected) as unknown as Json,
    usage: JSON.stringify(outcome.usage) as unknown as Json,
    edited_by: null,
    edited_by_name: null,
    edited_at: null,
    created_at: at,
  };
  let id: string | null = null;
  try {
    const row = await db
      .insertInto("narrations")
      .values(values)
      .onConflict((oc) => oc.columns(["workspace_id", "target", "target_id", "purpose", "input_hash"]).doUpdateSet(values))
      .returning("id")
      .executeTakeFirst();
    id = row?.id ?? null;
  } catch {
    // The text is still shown; it just isn't cached.
  }
  return { ...outcome, id, cached: false, at, editedBy: null, editedAt: null };
}
