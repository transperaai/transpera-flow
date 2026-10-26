"use server";

import { redirect } from "next/navigation";
import { isId } from "@/lib/editor/validate";
import { rpc } from "@transpera-flow/db/client";
import { pgCode } from "@/app/action-db";
import { getDb, getSessionUser } from "@/lib/auth/session";

// Creating a process from the app (issues #19, #76; the kind is chosen since B19, #182). The process row is
// written directly (processes aren't revisioned); its first steps go into a
// draft opened with open_draft, as every signed-in edit does (the database's
// edit_drafts_only trigger refuses the rest). It opens on the canvas in Draft
// view, unpublished until someone publishes it.

export interface CreateProcessResult {
  error?: string;
}

const MAX_NAME = 120;

const KINDS = { pipeline: { entity: "lead", start: "New lead", end: "Won", outcome: "won" }, servicing: { entity: "task", start: "Task due", end: "Done", outcome: "done" } } as const;

/** Make a process of the kind chosen (`kind`: pipeline or servicing) with a start and an end, and open it in a draft. */
export async function createProcess(workspaceId: string, slug: string, _prev: CreateProcessResult, form: FormData): Promise<CreateProcessResult> {
  const name = String(form.get("name") ?? "").trim();
  const chosen = form.get("kind");
  if (!isId(workspaceId) || typeof slug !== "string") return { error: "Couldn't create it. Try again." };
  if (!name || name.length > MAX_NAME) return { error: `Give it a name (up to ${MAX_NAME} characters).` };
  if (chosen !== "pipeline" && chosen !== "servicing") return { error: "Choose Sales pipeline or Client work." };
  const kind = KINDS[chosen];
  if (!(await getSessionUser())) return { error: "Your session has ended. Sign in again." };
  const db = await getDb();

  // The company map isn't an ordinary process: its name doesn't count (the MCP server's import ignores it too). Nor does an
  // archived one's (issue #182): names are unique among the processes in use, and restoring checks again.
  const existing = await db.selectFrom("processes").select("name").where("workspace_id", "=", workspaceId).where("is_company", "=", false).where("archived_at", "is", null).execute().catch(() => []);
  if (existing.some((p) => p.name.trim().toLowerCase() === name.toLowerCase())) return { error: `There is already a process called '${name}'.` };

  let proc: { id: string };
  try {
    proc = await db
      .insertInto("processes")
      .values({ workspace_id: workspaceId, name, kind: chosen, entity_name: kind.entity, source: "manual" })
      .returning("id")
      .executeTakeFirstOrThrow();
  } catch (e) {
    return { error: pgCode(e) === "42501" ? "You don't have permission to add processes here." : "Couldn't create it. Try again." };
  }
  let draft: { status: string; revision_id?: string } | null = null;
  try {
    draft = (await rpc(db, "open_draft", { target_process: proc.id })) as unknown as { status: string; revision_id?: string } | null;
  } catch {
    draft = null;
  }
  if (draft?.status !== "ok" || !draft.revision_id) return { error: "Created it, but couldn't open a draft. Open it from the list." };

  // A start and an end, joined, to build on.
  const start = crypto.randomUUID();
  const end = crypto.randomUUID();
  const base = { revision_id: draft.revision_id, workspace_id: workspaceId, process_id: proc.id };
  try {
    await db
      .insertInto("steps")
      .values([
        { ...base, id: start, name: kind.start, kind: "start", x: 60, y: 60 },
        { ...base, id: end, name: kind.end, kind: "end", outcome: kind.outcome, x: 520, y: 60 },
      ])
      .execute();
    await db.insertInto("edges").values({ ...base, from_step_id: start, to_step_id: end, probability: 1 }).execute().catch(() => undefined);
  } catch {
    // The process exists without its first steps; the editor opens it empty.
  }
  redirect(`/w/${encodeURIComponent(slug)}/p/${proc.id}/edit`);
}
