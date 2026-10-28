"use server";

import { createProcessFromTemplate, PROCESS_TEMPLATES, ImportError } from "@transpera-flow/db/process-import";
import { isId } from "@/lib/editor/validate";
import type { LibraryCreateInput, LibraryCreateResult } from "@/lib/editor/library-create";
import { rpc } from "@transpera-flow/db/client";
import { getDb, getSessionUser } from "@/lib/auth/session";

// The process library's "New process" and templates (issue #164, B12). Each makes a new process, as the signed-in editor through
// RLS, with a draft to build on, and returns it; the Editor then places it by a link in the draft being edited, like any process
// from the library. The new process gets no card on the company map of its own (`create_library_process`): it sits where the
// person puts it. Nothing is published.

const MAX_NAME = 120;
const GENERIC = "Couldn't create it. Try again.";

export async function createLibraryProcess(workspaceId: string, input: LibraryCreateInput): Promise<LibraryCreateResult> {
  if (!isId(workspaceId) || !input || typeof input !== "object") return { error: GENERIC };
  const user = await getSessionUser();
  if (!user) return { error: "Your session has ended. Sign in again." };
  const userId = user.id;
  const db = await getDb();

  if (input.kind === "template") {
    if (typeof input.templateId !== "string" || !input.templateId) return { error: GENERIC };
    const template = PROCESS_TEMPLATES.find((x) => x.id === input.templateId);
    if (!template) return { error: GENERIC };
    // The template's name, or the first of "Name 2", "Name 3", ... that is free, unless one was given.
    const existing = await db.selectFrom("processes").select("name").where("workspace_id", "=", workspaceId).where("is_company", "=", false).where("archived_at", "is", null).execute().catch(() => []);
    const taken = new Set(existing.map((p) => p.name.trim().toLowerCase()));
    let name = typeof input.name === "string" && input.name.trim() ? input.name.trim().slice(0, MAX_NAME) : template.name;
    for (let n = 2; !input.name && taken.has(name.toLowerCase()) && n < 100; n++) name = `${template.name} ${n}`;
    try {
      const made = await createProcessFromTemplate({ db, userId }, workspaceId, template.id, name);
      return { process: { ...made, live: false } };
    } catch (e) {
      if (e instanceof ImportError) {
        if (e.code === "name_taken") return { error: "There is already a process with that name. Give it another name." };
        if (e.code === "forbidden") return { error: "Only Agency admins can add processes." };
      }
      return { error: GENERIC };
    }
  }

  if (input.kind !== "new") return { error: GENERIC };
  const name = typeof input.name === "string" ? input.name.trim() : "";
  const kind = input.processKind === "servicing" ? "servicing" : input.processKind === "pipeline" ? "pipeline" : null;
  if (!name || name.length > MAX_NAME) return { error: `Give it a name (up to ${MAX_NAME} characters).` };
  if (!kind) return { error: GENERIC };
  let r: { status: string; process_id?: string };
  try {
    r = (await rpc(db, "create_library_process", { p_workspace: workspaceId, p_name: name, p_kind: kind })) as unknown as { status: string; process_id?: string };
  } catch {
    return { error: GENERIC };
  }
  if (r.status === "name_taken") return { error: `There is already a process called '${name}'. Give it another name.` };
  if (r.status === "not_found") return { error: "Only Agency admins can add processes." };
  if (r.status !== "created" || !r.process_id) return { error: GENERIC };

  // A draft with a start and an end, joined, to build on (as a new servicing process gets).
  let draft: { status: string; revision_id?: string } | null = null;
  try {
    draft = (await rpc(db, "open_draft", { target_process: r.process_id })) as unknown as { status: string; revision_id?: string } | null;
  } catch {
    draft = null;
  }
  if (draft?.status === "ok" && draft.revision_id) {
    const start = crypto.randomUUID();
    const end = crypto.randomUUID();
    const base = { revision_id: draft.revision_id, workspace_id: workspaceId, process_id: r.process_id };
    try {
      await db
        .insertInto("steps")
        .values([
          { ...base, id: start, name: kind === "pipeline" ? "New lead" : "Task due", kind: "start", x: 60, y: 60 },
          { ...base, id: end, name: kind === "pipeline" ? "Won" : "Done", kind: "end", outcome: kind === "pipeline" ? "won" : "done", x: 520, y: 60 },
        ])
        .execute();
      await db.insertInto("edges").values({ ...base, from_step_id: start, to_step_id: end, probability: 1 }).execute().catch(() => undefined);
    } catch {
      // The process exists without its first steps; the editor opens it empty.
    }
  }
  return { process: { id: r.process_id, name, kind, live: false } };
}
