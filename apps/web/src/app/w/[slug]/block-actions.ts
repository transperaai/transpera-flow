"use server";

import { loadSolutions, type BlockRow } from "@transpera-flow/db";
import { readBlock } from "@/lib/blocks/blocks";
import { blockUsers, usedInSentence } from "@/lib/blocks/rows";
import { MAX_NAME, parseBlockInput, type SaveBlockResult } from "@/lib/blocks/save";
import { isId } from "@/lib/sources/validate";
import { jsonb, pgCode } from "@/app/action-db";
import { getDb, getSessionUser } from "@/lib/auth/session";

// Saving a block to the library (issue #116). The write runs as the signed-in user through row-level security (owners and
// editors may write; everyone in the workspace may read). The checks in lib/blocks/save.ts only reject malformed input
// early; the table checks the name, type and bundle again.

const signedOut = { status: "error", message: "Your session has ended. Sign in again." } as const;
const forbidden = { status: "error", message: "You don't have permission to change the block library here." } as const;
const invalid = { status: "error", message: "That block isn't valid." } as const;

/** Save a block into the workspace's library. Blocks saved by hand are "manual". */
export async function createBlock(workspaceId: unknown, input: unknown): Promise<SaveBlockResult> {
  if (!isId(workspaceId)) return invalid;
  const parsed = parseBlockInput(input);
  if (!parsed.ok) return { status: "error", message: parsed.error };
  if (!(await getSessionUser())) return signedOut;
  const db = await getDb();
  const { name, description, bundle } = parsed.value;
  try {
    const data = await db
      .insertInto("blocks")
      .values({ workspace_id: workspaceId, name, description, type: "manual", steps: jsonb(bundle) })
      .returning(["id", "workspace_id", "name", "description", "type", "steps", "created_at", "updated_at"])
      .executeTakeFirstOrThrow();
    return { status: "ok", block: data as unknown as BlockRow };
  } catch (e) {
    const code = pgCode(e);
    if (code === "42501") return forbidden;
    if (code === "23514") return { status: "error", message: "Some of those values aren't allowed." };
    return { status: "error", message: "Couldn't save the block. Try again." };
  }
}

const COLUMNS = ["id", "workspace_id", "name", "description", "type", "steps", "created_at", "updated_at"] as const;
const gone = { status: "error", message: "That block no longer exists." } as const;

export type BlockOpResult = { status: "ok"; block?: BlockRow } | { status: "error"; message: string };

function failed(e: unknown): { status: "error"; message: string } {
  const code = pgCode(e);
  if (code === "42501") return forbidden;
  if (code === "23514") return { status: "error", message: "Some of those values aren't allowed." };
  return { status: "error", message: "Couldn't change the block. Try again." };
}

/**
 * Write an edited block back to the library (Q15): its name, description and bundle. Nothing else changes: the type and creator stay,
 * and the solutions that hold a copy of it keep their `provenance.block` stamps (they point at the block's id, which stays).
 */
export async function updateBlock(workspaceId: unknown, blockId: unknown, input: unknown): Promise<SaveBlockResult> {
  if (!isId(workspaceId) || !isId(blockId)) return invalid;
  const parsed = parseBlockInput(input);
  if (!parsed.ok) return { status: "error", message: parsed.error };
  if (!(await getSessionUser())) return signedOut;
  const db = await getDb();
  const { name, description, bundle } = parsed.value;
  try {
    const data = await db
      .updateTable("blocks")
      .set({ name, description, steps: jsonb(bundle) })
      .where("id", "=", blockId)
      .where("workspace_id", "=", workspaceId)
      .returning([...COLUMNS])
      .executeTakeFirst();
    // Row-level security hides a row the caller may not change, so no row back means missing or not allowed.
    if (!data) return { status: "error", message: "That block no longer exists, or you don't have permission to change it." };
    return { status: "ok", block: data as unknown as BlockRow };
  } catch (e) {
    return failed(e);
  }
}

/** Rename a block. */
export async function renameBlock(workspaceId: unknown, blockId: unknown, name: unknown): Promise<BlockOpResult> {
  if (!isId(workspaceId) || !isId(blockId)) return invalid;
  const next = typeof name === "string" ? name.trim() : "";
  if (!next) return { status: "error", message: "Name the block first." };
  if (next.length > MAX_NAME) return { status: "error", message: `Keep the name under ${MAX_NAME} characters.` };
  if (!(await getSessionUser())) return signedOut;
  const db = await getDb();
  try {
    const data = await db.updateTable("blocks").set({ name: next }).where("id", "=", blockId).where("workspace_id", "=", workspaceId).returning([...COLUMNS]).executeTakeFirst();
    return data ? { status: "ok", block: data as unknown as BlockRow } : gone;
  } catch (e) {
    return failed(e);
  }
}

/** Copy a block as "<name> (copy)" (same steps, same description). The copy is not used anywhere yet. */
export async function duplicateBlock(workspaceId: unknown, blockId: unknown): Promise<BlockOpResult> {
  if (!isId(workspaceId) || !isId(blockId)) return invalid;
  if (!(await getSessionUser())) return signedOut;
  const db = await getDb();
  try {
    const src = await db.selectFrom("blocks").select([...COLUMNS]).where("id", "=", blockId).where("workspace_id", "=", workspaceId).executeTakeFirst();
    if (!src) return gone;
    const name = `${src.name} (copy)`.slice(0, MAX_NAME);
    const data = await db
      .insertInto("blocks")
      .values({ workspace_id: workspaceId, name, description: src.description, type: src.type, steps: jsonb(readBlock(src.steps)) })
      .returning([...COLUMNS])
      .executeTakeFirstOrThrow();
    return { status: "ok", block: data as unknown as BlockRow };
  } catch (e) {
    return failed(e);
  }
}

/**
 * Delete a block, unless a solution holds a copy of it (then the answer says which). The check here gives the message; the database
 * enforces the rule (`private.refuse_used_block_delete`, 20270203000100), so a solution saved between the check and the delete still
 * stops it.
 */
export async function deleteBlock(workspaceId: unknown, blockId: unknown): Promise<BlockOpResult> {
  if (!isId(workspaceId) || !isId(blockId)) return invalid;
  if (!(await getSessionUser())) return signedOut;
  const db = await getDb();
  const inUse = async () => {
    const users = blockUsers(await loadSolutions(db, workspaceId))[blockId] ?? [];
    return users.length ? ({ status: "error", message: `This block can't be deleted. ${usedInSentence(users)}` } as const) : null;
  };
  try {
    const used = await inUse();
    if (used) return used;
    const removed = await db.deleteFrom("blocks").where("id", "=", blockId).where("workspace_id", "=", workspaceId).returning("id").executeTakeFirst();
    return removed ? { status: "ok" } : { status: "error", message: "That block no longer exists, or you don't have permission to delete it." };
  } catch (e) {
    if (pgCode(e) === "23503" && /^block is used by a solution/.test((e as { message?: string } | null)?.message ?? "")) {
      return (await inUse().catch(() => null)) ?? { status: "error", message: "This block can't be deleted: a solution holds a copy of it." };
    }
    return failed(e);
  }
}
