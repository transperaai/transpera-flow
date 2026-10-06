import "server-only";
import type { Json } from "@transpera-flow/db";
import type { HealthSetting } from "@/lib/servicing";
import { createClient } from "@/lib/supabase/server";
import type { SaveOutcome } from "./field-controller";

// Server half of per-field saves (docs/adr/0001-per-field-saves.md). Calls the
// database's save_fields / save_links as the signed-in user, so RLS decides
// what may be written. Server Actions validate their inputs, then call these.

/** Tables `save_fields` accepts. Keep in sync with the migration's allow-list. */
export type EditableTable =
  | "workspaces"
  | "roles"
  | "people"
  | "person_leave"
  | "processes"
  | "steps"
  | "edges"
  | "services"
  | "lead_sources"
  | "seasonality"
  | "demand_settings"
  | "issues"
  | "sources"
  | "clients"
  | "client_assignments"
  | "client_groups"
  | "service_servicing";

/** Link tables `save_links` accepts, and their member column. */
export const LINK_MEMBERS = { person_roles: "role_id", person_skills: "step_id", client_services: "service_id" } as const;
export type LinkTable = keyof typeof LINK_MEMBERS;

interface FieldsResult {
  status: "saved" | "conflict" | "not_found";
  row?: Record<string, Json>;
  conflicts?: Record<string, Json>;
}

interface LinksResult {
  status: "saved" | "conflict" | "not_found";
  members?: string[];
}

/** Read `column` or `column.key` (a key inside a jsonb column) from a row. */
function readField(row: Record<string, Json> | undefined, field: string): Json {
  const [col, sub] = field.split(".", 2) as [string, string | undefined];
  const value = row?.[col] ?? null;
  if (sub === undefined) return value;
  return value && typeof value === "object" && !Array.isArray(value) ? (value[sub] ?? null) : null;
}

function errorOutcome(error: { code?: string; message: string }): SaveOutcome<never> {
  // Check constraints (e.g. FTE above 1.5, an end date before the start date).
  if (error.code === "23514") return { status: "error", message: "That value isn't allowed here." };
  if (error.code === "42501") return { status: "error", message: "You don't have permission to change this." };
  // A rename onto a name another row of the workspace already has (roles).
  if (error.code === "23505") return { status: "error", message: "That name is already taken." };
  return { status: "error", message: "Couldn't save. Try again." };
}

/**
 * Save one field of one row if its stored value is still `base`.
 * `field` is a column, or `column.key` for one key of a jsonb column. A
 * string array is a text[] column's value (e.g. a service's path tags).
 */
export async function saveField<T extends string | number | boolean | null | string[]>(
  target: EditableTable,
  key: Record<string, string>,
  field: string,
  base: T,
  value: T,
): Promise<SaveOutcome<T>> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("save_fields", {
    target,
    key,
    base: { [field]: base },
    changes: { [field]: value },
  });
  if (error) return errorOutcome(error);
  const result = data as unknown as FieldsResult;
  if (result.status === "not_found") return { status: "not_found" };
  if (result.status === "conflict" && result.conflicts && field in result.conflicts) {
    return { status: "conflict", theirs: result.conflicts[field] as T };
  }
  return { status: "saved", value: readField(result.row, field) as T };
}

/**
 * Save one Client health rule (a `settings.<key>` of the workspace) if its stored value is still `base`. Owners and editors may
 * (`save_health_rules`, a SECURITY DEFINER function that writes nothing but those four keys; `save_fields('workspaces')` is
 * owner-only). `value` is a number from 0 to 100, or null to restore the estimated default.
 */
export async function saveHealthRule(workspaceId: string, key: HealthSetting, base: number | null, value: number | null): Promise<SaveOutcome<number | null>> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("save_health_rules", { ws: workspaceId, base: { [key]: base }, changes: { [key]: value } });
  if (error) return errorOutcome(error);
  const result = data as unknown as FieldsResult;
  if (result.status === "not_found") return { status: "not_found" };
  const field = `settings.${key}`;
  if (result.status === "conflict" && result.conflicts && key in result.conflicts) {
    return { status: "conflict", theirs: result.conflicts[key] as number | null };
  }
  return { status: "saved", value: readField(result.row, field) as number | null };
}

export type Scalar = string | number | boolean | null;

export type FieldsOutcome<V = Scalar> =
  | { status: "saved" }
  /** Fields someone else changed since `base`, with their stored values. The other fields were saved. */
  | { status: "conflict"; theirs: Record<string, V> }
  | { status: "not_found" }
  | { status: "error"; message: string };

/**
 * Save several fields of one row in one call, each checked against its own
 * base, as `saveField` does for one. Used where one edit changes fields that
 * must move together, such as a step's kind and outcome.
 */
export async function saveFields<V extends Scalar | object = Scalar>(
  target: EditableTable,
  key: Record<string, string>,
  base: Record<string, V>,
  changes: Record<string, V>,
): Promise<FieldsOutcome<V>> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("save_fields", { target, key, base: base as Json, changes: changes as Json });
  if (error) return errorOutcome(error);
  const result = data as unknown as FieldsResult;
  if (result.status === "not_found") return { status: "not_found" };
  const conflicts = result.conflicts ?? {};
  if (result.status === "conflict" && Object.keys(conflicts).length) {
    return { status: "conflict", theirs: conflicts as Record<string, V> };
  }
  return { status: "saved" };
}

/** Replace a set held in a link table (e.g. a person's roles) if it is still `base`. */
export async function saveLinks(
  target: LinkTable,
  owner: Record<string, string> & { workspace_id: string },
  base: readonly string[],
  next: readonly string[],
): Promise<SaveOutcome<string[]>> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("save_links", {
    target,
    owner,
    member: LINK_MEMBERS[target],
    base: [...base],
    next: [...next],
  });
  if (error) return errorOutcome(error);
  const result = data as unknown as LinksResult;
  if (result.status === "not_found") return { status: "not_found" };
  const members = result.members ?? [];
  return result.status === "conflict" ? { status: "conflict", theirs: members } : { status: "saved", value: members };
}
