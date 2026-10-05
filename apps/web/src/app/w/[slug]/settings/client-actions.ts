"use server";

import { refresh } from "next/cache";
import type { SaveOutcome } from "@/lib/fields/field-controller";
import { saveField, saveLinks } from "@/lib/fields/server";
import { CLIENT_FIELDS, isBase, isClientField, isId, parseNewClient, type ClientField } from "@/lib/clients";
import { createClient } from "@/lib/supabase/server";

// Clients by hand (issue #182, B19). Every write runs as the signed-in user through row-level security: owners and editors
// change clients, viewers can't. A client is never deleted (the database refuses it): they are made inactive. These checks
// only reject malformed input early.

type Scalar = string | number | boolean | null;

const invalid = { status: "error", message: "That value isn't valid." } as const;
const signedOut = { status: "error", message: "Your session has ended. Sign in again." } as const;

async function signedIn(): Promise<boolean> {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  return Boolean(data?.claims?.sub);
}

export interface AddClientResult {
  error?: string;
}

/** Add a client from the form: a name, and optionally MRR and a start date. */
export async function addClient(workspaceId: string, _prev: AddClientResult, form: FormData): Promise<AddClientResult> {
  if (!isId(workspaceId)) return { error: "Couldn't save. Try again." };
  const parsed = parseNewClient({ name: form.get("name"), mrr: form.get("mrr"), start_date: form.get("start_date") });
  if (!parsed.ok) return { error: parsed.error };
  if (!(await signedIn())) return { error: signedOut.message };
  const supabase = await createClient();
  const { error } = await supabase.from("clients").insert({ workspace_id: workspaceId, ...parsed.value });
  if (error) return { error: error.code === "42501" ? "You don't have permission to add clients." : "Couldn't save. Try again." };
  refresh();
  return {};
}

/** One field of a client: its name, MRR, start date, or whether it is active. */
export async function saveClientField(clientId: string, field: ClientField, base: Scalar, value: Scalar): Promise<SaveOutcome<Scalar>> {
  if (!isId(clientId) || !isClientField(field) || !CLIENT_FIELDS[field](value) || !isBase(base)) return invalid;
  if (!(await signedIn())) return signedOut;
  const out = await saveField("clients", { id: clientId }, field, base, typeof value === "string" ? value.trim() : value);
  // Active and inactive clients are listed apart: show it in the right place.
  if (field === "active" && out.status === "saved") refresh();
  return out;
}

/** The services a client takes, saved as one set. */
export async function saveClientServices(clientId: string, workspaceId: string, base: string[], next: string[]): Promise<SaveOutcome<string[]>> {
  const ids = (v: unknown) => Array.isArray(v) && v.length <= 200 && v.every(isId);
  if (!isId(clientId) || !isId(workspaceId) || !ids(base) || !ids(next)) return invalid;
  if (!(await signedIn())) return signedOut;
  return saveLinks("client_services", { client_id: clientId, workspace_id: workspaceId }, base, next);
}

/**
 * Who looks after a client in one role (null: nobody named, the role's people share it). Saved only if it is still `base`
 * when it is written; otherwise the person now stored is returned as a conflict.
 */
export async function saveClientAssignment(
  clientId: string,
  workspaceId: string,
  roleId: string,
  base: string | null,
  next: string | null,
): Promise<SaveOutcome<string | null>> {
  if (!isId(clientId) || !isId(workspaceId) || !isId(roleId)) return invalid;
  if (!(base === null || isId(base)) || !(next === null || isId(next))) return invalid;
  if (!(await signedIn())) return signedOut;
  const supabase = await createClient();
  const { data: rows, error: readError } = await supabase
    .from("client_assignments")
    .select("person_id")
    .eq("client_id", clientId)
    .eq("role_id", roleId)
    .eq("workspace_id", workspaceId);
  if (readError) return { status: "error", message: "Couldn't save. Try again." };
  const stored = rows[0]?.person_id ?? null;
  if (stored === next) return { status: "saved", value: next };
  if (stored !== base) return { status: "conflict", theirs: stored };
  const failed = (code?: string): SaveOutcome<string | null> =>
    code === "42501" ? { status: "error", message: "You don't have permission to change this." } : { status: "error", message: "Couldn't save. Try again." };
  if (next === null) {
    const { data, error } = await supabase.from("client_assignments").delete().eq("client_id", clientId).eq("role_id", roleId).eq("person_id", base!).select("person_id");
    if (error) return failed(error.code);
    if (!data.length) return { status: "not_found" };
  } else if (base === null) {
    const { error } = await supabase.from("client_assignments").insert({ client_id: clientId, role_id: roleId, person_id: next, workspace_id: workspaceId });
    if (error) return error.code === "23505" ? { status: "error", message: "Someone just changed this. Reload to see it." } : failed(error.code);
  } else {
    const r = await saveField("client_assignments", { client_id: clientId, role_id: roleId }, "person_id", base, next);
    return r;
  }
  return { status: "saved", value: next };
}
