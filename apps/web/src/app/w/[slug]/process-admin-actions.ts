"use server";

import { isId } from "@/lib/editor/validate";
import { cleanProcessName, type ProcessAdminResult, type ProcessKind } from "@/lib/processes/admin";
import { createClient } from "@/lib/supabase/server";

// Process admin from the Processes page (issue #182, B19 2/2; ADR 0014 "B19: archiving a process"): rename a process, change its
// kind, archive it (soft delete) and restore it. Each is an ordinary update of `processes` as the signed-in user, so RLS decides
// (owners, editors and agency admins write; viewers read), and the database does the rest: the company map follows a rename, a
// kind change, an archive and a restore as a system version, and archiving is refused, with a plain message naming the processes
// involved, for a process inside another ordinary process or one that holds others. Nothing here deletes a process.

const signedOut = { status: "error", message: "Your session has ended. Sign in again." } as const;
const forbidden = { status: "error", message: "Only owners and editors can change processes here." } as const;
const generic = { status: "error", message: "Couldn't save. Try again." } as const;

async function signedInClient() {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  return data?.claims?.sub ? supabase : null;
}

type Client = NonNullable<Awaited<ReturnType<typeof signedInClient>>>;

/** The process (never the company map), as the caller may read it; null when it isn't there or isn't visible. */
async function readProcess(supabase: Client, processId: string) {
  const { data } = await supabase.from("processes").select("id, workspace_id, name, kind, entity_name, archived_at, is_company").eq("id", processId).maybeSingle();
  return data && !data.is_company ? data : null;
}

/** An update of one process; zero rows back means RLS stopped it (a viewer). The database's own refusals are passed on. */
async function update(
  supabase: Client,
  processId: string,
  changes: { name?: string; kind?: ProcessKind; entity_name?: string; archived_at?: string | null },
): Promise<ProcessAdminResult> {
  const { data, error } = await supabase.from("processes").update(changes).eq("id", processId).eq("is_company", false).select("id");
  if (error) {
    if (error.code === "42501") return forbidden;
    // 55000: archiving refused (inside another process, holding others); 23514: a kind change refused (linked to services).
    if ((error.code === "55000" || error.code === "23514") && error.message) return { status: "error", message: error.message };
    return generic;
  }
  return data?.length ? { status: "ok" } : forbidden;
}

export async function renameProcess(processId: unknown, name: unknown): Promise<ProcessAdminResult> {
  const clean = cleanProcessName(name);
  if (!isId(processId)) return generic;
  if (!clean.ok) return { status: "error", message: clean.error };
  const supabase = await signedInClient();
  if (!supabase) return signedOut;
  const proc = await readProcess(supabase, processId);
  if (!proc) return { status: "error", message: "That process isn't there any more. Reload the page." };
  if (proc.name === clean.name) return { status: "ok" };
  const { data: others } = await supabase.from("processes").select("id, name").eq("workspace_id", proc.workspace_id).eq("is_company", false).neq("id", processId);
  if ((others ?? []).some((p) => p.name.trim().toLowerCase() === clean.name.toLowerCase())) return { status: "error", message: `There is already a process called '${clean.name}'.` };
  return update(supabase, processId, { name: clean.name });
}

export async function changeProcessKind(processId: unknown, kind: unknown): Promise<ProcessAdminResult> {
  if (!isId(processId) || (kind !== "pipeline" && kind !== "servicing")) return generic;
  const to = kind as ProcessKind;
  const supabase = await signedInClient();
  if (!supabase) return signedOut;
  const proc = await readProcess(supabase, processId);
  if (!proc) return { status: "error", message: "That process isn't there any more. Reload the page." };
  if (proc.kind === to) return { status: "ok" };
  if (to === "pipeline") {
    // The database refuses it too; say which services first.
    const { data: links } = await supabase.from("service_servicing").select("services(name)").eq("process_id", processId);
    const names = [...new Set((links ?? []).map((l) => (l.services as { name: string } | null)?.name).filter((n): n is string => !!n))].sort();
    if (names.length) return { status: "error", message: `${proc.name} is client work for ${names.join(", ")}. Unlink it from ${names.length === 1 ? "that service" : "those services"} in Settings, Services first.` };
  }
  // The word for what flows through it follows the kind, unless someone chose their own.
  const entity = proc.entity_name === "lead" || proc.entity_name === "task" || proc.entity_name === "item" ? (to === "pipeline" ? "lead" : "task") : proc.entity_name;
  return update(supabase, processId, { kind: to, entity_name: entity });
}

export async function archiveProcess(processId: unknown): Promise<ProcessAdminResult> {
  if (!isId(processId)) return generic;
  const supabase = await signedInClient();
  if (!supabase) return signedOut;
  // The database stamps when and by whom.
  return update(supabase, processId, { archived_at: new Date().toISOString() });
}

export async function restoreProcess(processId: unknown): Promise<ProcessAdminResult> {
  if (!isId(processId)) return generic;
  const supabase = await signedInClient();
  if (!supabase) return signedOut;
  return update(supabase, processId, { archived_at: null });
}
