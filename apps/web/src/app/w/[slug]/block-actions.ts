"use server";

import type { BlockRow } from "@transpera-flow/db";
import { parseBlockInput, type SaveBlockResult } from "@/lib/blocks/save";
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
