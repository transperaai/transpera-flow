"use server";

import { redirect } from "next/navigation";
import { isId } from "@/lib/editor/validate";
import { createClient } from "@/lib/supabase/server";

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
  const supabase = await createClient();
  const { data: claims } = await supabase.auth.getClaims();
  if (!claims?.claims?.sub) return { error: "Your session has ended. Sign in again." };

  // The company map isn't an ordinary process: its name doesn't count (the MCP server's import ignores it too). An archived
  // process keeps its name: restore it rather than make a second one.
  const { data: existing } = await supabase.from("processes").select("name, archived_at").eq("workspace_id", workspaceId).eq("is_company", false);
  const same = (existing ?? []).find((p) => p.name.trim().toLowerCase() === name.toLowerCase());
  if (same) return { error: same.archived_at ? `There is an archived process called '${name}'. Restore it from Processes (Archived), or choose another name.` : `There is already a process called '${name}'.` };

  const { data: proc, error } = await supabase
    .from("processes")
    .insert({ workspace_id: workspaceId, name, kind: chosen, entity_name: kind.entity, source: "manual" })
    .select("id")
    .single();
  if (error || !proc) {
    return { error: error?.code === "42501" ? "You don't have permission to add processes here." : "Couldn't create it. Try again." };
  }
  const { data: opened, error: openError } = await supabase.rpc("open_draft", { target_process: proc.id });
  const draft = opened as { status: string; revision_id?: string } | null;
  if (openError || draft?.status !== "ok" || !draft.revision_id) return { error: "Created it, but couldn't open a draft. Open it from the list." };

  // A start and an end, joined, to build on.
  const start = crypto.randomUUID();
  const end = crypto.randomUUID();
  const base = { revision_id: draft.revision_id, workspace_id: workspaceId, process_id: proc.id };
  const { error: stepError } = await supabase.from("steps").insert([
    { ...base, id: start, name: kind.start, kind: "start", x: 60, y: 60 },
    { ...base, id: end, name: kind.end, kind: "end", outcome: kind.outcome, x: 520, y: 60 },
  ]);
  if (!stepError) {
    await supabase.from("edges").insert({ ...base, from_step_id: start, to_step_id: end, probability: 1 });
  }
  redirect(`/w/${encodeURIComponent(slug)}/p/${proc.id}/edit`);
}
