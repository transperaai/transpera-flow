"use server";

import { createProcessFromTemplate, PROCESS_TEMPLATES, ToolError } from "@transpera-flow/mcp";
import { isId } from "@/lib/editor/validate";
import type { LibraryCreateInput, LibraryCreateResult } from "@/lib/editor/library-create";
import { createClient } from "@/lib/supabase/server";

// The process library's "New process" and templates (issue #164, B12). Each makes a new process, as the signed-in editor through
// RLS, with a draft to build on, and returns it; the Editor then places it by a link in the draft being edited, like any process
// from the library. The new process gets no card on the company map of its own (`create_library_process`): it sits where the
// person puts it. Nothing is published.

const MAX_NAME = 120;
const GENERIC = "Couldn't create it. Try again.";

export async function createLibraryProcess(workspaceId: string, input: LibraryCreateInput): Promise<LibraryCreateResult> {
  if (!isId(workspaceId) || !input || typeof input !== "object") return { error: GENERIC };
  const supabase = await createClient();
  const { data: claims } = await supabase.auth.getClaims();
  const userId = claims?.claims?.sub;
  if (!userId) return { error: "Your session has ended. Sign in again." };

  if (input.kind === "template") {
    if (typeof input.templateId !== "string" || !input.templateId) return { error: GENERIC };
    const template = PROCESS_TEMPLATES.find((x) => x.id === input.templateId);
    if (!template) return { error: GENERIC };
    // The template's name, or the first of "Name 2", "Name 3", ... that is free, unless one was given.
    const { data: existing } = await supabase.from("processes").select("name").eq("workspace_id", workspaceId).eq("is_company", false).is("archived_at", null);
    const taken = new Set((existing ?? []).map((p) => p.name.trim().toLowerCase()));
    let name = typeof input.name === "string" && input.name.trim() ? input.name.trim().slice(0, MAX_NAME) : template.name;
    for (let n = 2; !input.name && taken.has(name.toLowerCase()) && n < 100; n++) name = `${template.name} ${n}`;
    try {
      const made = await createProcessFromTemplate({ db: supabase, tokenHash: "", userId, activeWorkspaceId: workspaceId, today: new Date().toISOString().slice(0, 10) }, workspaceId, template.id, name);
      return { process: { ...made, live: false } };
    } catch (e) {
      if (e instanceof ToolError) {
        if (e.code === "name_taken") return { error: "There is already a process with that name. Give it another name." };
        if (e.code === "forbidden") return { error: "Only editors and owners can add processes." };
      }
      return { error: GENERIC };
    }
  }

  if (input.kind !== "new") return { error: GENERIC };
  const name = typeof input.name === "string" ? input.name.trim() : "";
  const kind = input.processKind === "servicing" ? "servicing" : input.processKind === "pipeline" ? "pipeline" : null;
  if (!name || name.length > MAX_NAME) return { error: `Give it a name (up to ${MAX_NAME} characters).` };
  if (!kind) return { error: GENERIC };
  const { data, error } = await supabase.rpc("create_library_process", { p_workspace: workspaceId, p_name: name, p_kind: kind });
  if (error) return { error: GENERIC };
  const r = data as { status: string; process_id?: string };
  if (r.status === "name_taken") return { error: `There is already a process called '${name}'. Give it another name.` };
  if (r.status === "not_found") return { error: "Only editors and owners can add processes." };
  if (r.status !== "created" || !r.process_id) return { error: GENERIC };

  // A draft with a start and an end, joined, to build on (as a new servicing process gets).
  const { data: opened, error: openError } = await supabase.rpc("open_draft", { target_process: r.process_id });
  const draft = opened as { status: string; revision_id?: string } | null;
  if (!openError && draft?.status === "ok" && draft.revision_id) {
    const start = crypto.randomUUID();
    const end = crypto.randomUUID();
    const base = { revision_id: draft.revision_id, workspace_id: workspaceId, process_id: r.process_id };
    const { error: stepError } = await supabase.from("steps").insert([
      { ...base, id: start, name: kind === "pipeline" ? "New lead" : "Task due", kind: "start", x: 60, y: 60 },
      { ...base, id: end, name: kind === "pipeline" ? "Won" : "Done", kind: "end", outcome: kind === "pipeline" ? "won" : "done", x: 520, y: 60 },
    ]);
    if (!stepError) await supabase.from("edges").insert({ ...base, from_step_id: start, to_step_id: end, probability: 1 });
  }
  return { process: { id: r.process_id, name, kind, live: false } };
}
