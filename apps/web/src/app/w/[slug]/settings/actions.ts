"use server";

import { refresh } from "next/cache";
import type { MarketFactorKey } from "@transpera-flow/engine";
import type { SaveOutcome } from "@/lib/fields/field-controller";
import { saveField, saveLinks } from "@/lib/fields/server";
import { isGrowth, isMonth, isMultiplier, parseLeadSourceField, parseNewLeadSource, type LeadSourceField } from "@/lib/demand";
import { copyName, parseChange, parseConditionField } from "@/lib/market";
import { parseNewRole, parseRoleField, type RoleField } from "@/lib/roles";
import {
  CLIENT_GROUP_FIELDS,
  isBenchmarkBound,
  isClientGroupField,
  newGroupDefaults,
  type ClientGroupField,
} from "@/lib/client-groups";
import { isTagList, parseNewService, parseServiceField, type ServiceField } from "@/lib/services";
import { createClient } from "@/lib/supabase/server";

// Writes from the workspace settings page. Every write runs as the signed-in
// user through RLS; these checks only reject malformed input early.

type Scalar = string | number | boolean | null;
type Check = (v: unknown) => boolean;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const isId = (v: unknown): v is string => typeof v === "string" && UUID.test(v);
const isDate = (v: unknown): v is string => typeof v === "string" && DATE.test(v) && !Number.isNaN(Date.parse(v));
const text: Check = (v) => typeof v === "string" && v.trim().length > 0 && v.length <= 200;
const optionalText: Check = (v) => v === null || (typeof v === "string" && v.length <= 2000);
const number: Check = (v) => typeof v === "number" && Number.isFinite(v);
const optionalNumber: Check = (v) => v === null || number(v);
const optionalDate: Check = (v) => v === null || isDate(v);
const boolean: Check = (v) => typeof v === "boolean";
/** A stored value to compare against: any number (the database may hold one outside what the form offers). */
const isFiniteNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

const PERSON_FIELDS = {
  name: text,
  email: optionalText,
  notes: optionalText,
  fte: number,
  capacity_hours_week: optionalNumber,
  cost_rate: optionalNumber,
  active: boolean,
  start_date: optionalDate,
  end_date: optionalDate,
} as const satisfies Record<string, Check>;

export type PersonField = keyof typeof PERSON_FIELDS;

const invalid = { status: "error", message: "That value isn't valid." } as const;
const isScalar = (v: unknown): v is Scalar => v === null || ["string", "number", "boolean"].includes(typeof v);

async function signedIn(): Promise<boolean> {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  return Boolean(data?.claims?.sub);
}

const signedOut = { status: "error", message: "Your session has ended. Sign in again." } as const;

export async function savePersonField(
  personId: string,
  field: PersonField,
  base: Scalar,
  value: Scalar,
): Promise<SaveOutcome<Scalar>> {
  const check: Check | undefined = Object.hasOwn(PERSON_FIELDS, field) ? PERSON_FIELDS[field] : undefined;
  if (!isId(personId) || !check || !check(value) || !isScalar(base)) return invalid;
  if (!(await signedIn())) return signedOut;
  return saveField("people", { id: personId }, field, base, typeof value === "string" ? value.trim() : value);
}

export async function savePersonSet(
  personId: string,
  workspaceId: string,
  set: "roles" | "skills",
  base: string[],
  next: string[],
): Promise<SaveOutcome<string[]>> {
  const ids = (v: unknown) => Array.isArray(v) && v.length <= 500 && v.every(isId);
  if (!isId(personId) || !isId(workspaceId) || !ids(base) || !ids(next)) return invalid;
  if (set !== "roles" && set !== "skills") return invalid;
  if (!(await signedIn())) return signedOut;
  return saveLinks(set === "roles" ? "person_roles" : "person_skills", { person_id: personId, workspace_id: workspaceId }, base, next);
}

/** Minimum share of each week left for pipeline work; null restores the default. */
export async function saveAvailabilityFloor(
  workspaceId: string,
  base: number | null,
  value: number | null,
): Promise<SaveOutcome<number | null>> {
  const fraction = (v: unknown) => v === null || (number(v) && (v as number) >= 0 && (v as number) < 1);
  if (!isId(workspaceId) || !fraction(value) || !isScalar(base)) return invalid;
  if (!(await signedIn())) return signedOut;
  return saveField("workspaces", { id: workspaceId }, "settings.availability_floor", base, value);
}

/**
 * Overtime someone may work when client work exceeds their week, as a share
 * of it (docs/PRD.md §6.3.4, decision D7); null restores the default (none).
 */
export async function saveOvertimeCap(workspaceId: string, base: number | null, value: number | null): Promise<SaveOutcome<number | null>> {
  const share = (v: unknown) => v === null || (number(v) && (v as number) >= 0 && (v as number) <= 1);
  if (!isId(workspaceId) || !share(value) || !isScalar(base)) return invalid;
  if (!(await signedIn())) return signedOut;
  return saveField("workspaces", { id: workspaceId }, "settings.overtime_cap", base, value);
}

/**
 * A service's fallback ongoing load for one role: hours a month per client
 * while no servicing process is mapped (docs/PRD.md §6.3.4). Null clears it.
 */
export async function saveServiceFallback(
  serviceId: string,
  roleId: string,
  base: number | null,
  value: number | null,
): Promise<SaveOutcome<number | null>> {
  const hours = (v: unknown) => v === null || (number(v) && (v as number) >= 0 && (v as number) <= 1000);
  if (!isId(serviceId) || !isId(roleId) || !hours(value) || !(base === null || isFiniteNumber(base))) return invalid;
  if (!(await signedIn())) return signedOut;
  return saveField("services", { id: serviceId }, `fallback_ongoing_load.${roleId}`, base, value);
}

/**
 * One number of a service's client group (issue #120): how many clients, their fee, normal churn, typical stay or
 * starting health. A service with no group yet gets one on its first edit, starting from the service's own price,
 * churn and tenure.
 */
export async function saveClientGroupField(
  workspaceId: string,
  serviceId: string,
  field: ClientGroupField,
  base: number | null,
  value: number | null,
): Promise<SaveOutcome<number | null>> {
  if (!isId(workspaceId) || !isId(serviceId) || !isClientGroupField(field) || value === null || !CLIENT_GROUP_FIELDS[field](value)) return invalid;
  if (!(base === null || isFiniteNumber(base))) return invalid;
  if (!(await signedIn())) return signedOut;
  const supabase = await createClient();
  const { data: existing, error: readError } = await supabase.from("client_groups").select("id").eq("service_id", serviceId).maybeSingle();
  if (readError) return { status: "error", message: "Couldn't save. Try again." };
  if (existing) return saveField("client_groups", { service_id: serviceId }, field, base, value);
  const { data: service, error: serviceError } = await supabase
    .from("services")
    .select("price, churn_monthly_base, tenure_months")
    .eq("id", serviceId)
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (serviceError || !service) return { status: "not_found" };
  const { error } = await supabase
    .from("client_groups")
    .insert({ workspace_id: workspaceId, service_id: serviceId, ...newGroupDefaults(service), [field]: value });
  if (error) {
    // Someone set this group up a moment ago: ask for a fresh look rather than overwrite them.
    if (error.code === "23505") return { status: "error", message: "Someone just set this up. Reload to see it." };
    return { status: "error", message: error.code === "42501" ? "You don't have permission to change this." : "Couldn't save. Try again." };
  }
  return { status: "saved", value };
}

/** One end of the client-health benchmark the People page compares against (0 to 100); null clears it. */
export async function saveClientHealthBenchmark(
  workspaceId: string,
  bound: "low" | "high",
  base: number | null,
  value: number | null,
): Promise<SaveOutcome<number | null>> {
  if (!isId(workspaceId) || (bound !== "low" && bound !== "high") || !isBenchmarkBound(value) || !(base === null || isFiniteNumber(base))) return invalid;
  if (!(await signedIn())) return signedOut;
  return saveField("workspaces", { id: workspaceId }, `settings.client_health_benchmark_${bound}`, base, value);
}

export interface ActionResult {
  error?: string;
}

const failure = (error: { code?: string } | null): ActionResult =>
  error?.code === "42501"
    ? { error: "You don't have permission to do that." }
    : error?.code === "23514"
      ? { error: "Some of those values aren't allowed." }
      : { error: "Couldn't save. Try again." };

export async function createPerson(workspaceId: string, _prev: ActionResult, form: FormData): Promise<ActionResult> {
  const name = String(form.get("name") ?? "").trim();
  const roleId = String(form.get("role_id") ?? "");
  if (!isId(workspaceId) || !text(name)) return { error: "Enter a name." };
  if (roleId && !isId(roleId)) return { error: "Pick a role." };
  const supabase = await createClient();
  const { data: person, error } = await supabase
    .from("people")
    .insert({ workspace_id: workspaceId, name })
    .select("id")
    .single();
  if (error) return failure(error);
  if (roleId) {
    const { error: roleError } = await supabase
      .from("person_roles")
      .insert({ person_id: person.id, role_id: roleId, workspace_id: workspaceId });
    if (roleError) return failure(roleError);
  }
  refresh();
  return {};
}

export async function addLeave(
  personId: string,
  workspaceId: string,
  _prev: ActionResult,
  form: FormData,
): Promise<ActionResult> {
  const start = String(form.get("start_date") ?? "");
  const end = String(form.get("end_date") ?? "") || start;
  const note = String(form.get("note") ?? "").trim() || null;
  if (!isId(personId) || !isId(workspaceId)) return { error: "Couldn't save. Try again." };
  if (!isDate(start) || !isDate(end)) return { error: "Enter the first and last day." };
  if (end < start) return { error: "The last day must be on or after the first." };
  const supabase = await createClient();
  const { error } = await supabase
    .from("person_leave")
    .insert({ person_id: personId, workspace_id: workspaceId, start_date: start, end_date: end, note });
  if (error) return failure(error);
  refresh();
  return {};
}

export async function removeLeave(leaveId: string): Promise<ActionResult> {
  if (!isId(leaveId)) return { error: "Couldn't remove it. Try again." };
  const supabase = await createClient();
  const { data, error } = await supabase.from("person_leave").delete().eq("id", leaveId).select("id");
  if (error) return failure(error);
  if (!data.length) return { error: "That leave was already removed, or you can't edit it." };
  refresh();
  return {};
}

// Services (issue #12). Owners and editors manage them; RLS enforces that.

export async function saveServiceField(
  serviceId: string,
  field: ServiceField,
  base: Scalar,
  value: Scalar,
): Promise<SaveOutcome<Scalar>> {
  const parsed = parseServiceField(serviceId, field, base, value);
  if (!parsed) return invalid;
  if (!(await signedIn())) return signedOut;
  return saveField("services", { id: parsed.serviceId }, parsed.field, parsed.base, parsed.value);
}

/** A service's path tags, saved as one list. */
export async function saveServiceTags(serviceId: string, base: string[], next: string[]): Promise<SaveOutcome<string[]>> {
  if (!isId(serviceId) || !isTagList(base) || !isTagList(next)) return invalid;
  if (!(await signedIn())) return signedOut;
  return saveField<string[]>("services", { id: serviceId }, "path_tags", base, next);
}

export async function createService(workspaceId: string, _prev: ActionResult, form: FormData): Promise<ActionResult> {
  if (!isId(workspaceId)) return { error: "Couldn't save. Try again." };
  const service = parseNewService(form);
  if ("error" in service) return service;
  const supabase = await createClient();
  // The first service takes every arrival; later ones start at a share of 0,
  // so adding one doesn't change the simulation until its share is set.
  const { count, error: countError } = await supabase
    .from("services")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", workspaceId);
  if (countError) return failure(countError);
  // The churn sensitivity starts at the PRD's estimated default (§6.3.5), so it is marked as an
  // estimate (the robustness check perturbs it, issue #79) rather than stamped entered.
  const provenance = { churn_health_sensitivity: { source: "estimated", at: new Date().toISOString(), note: "Default" } };
  const { error } = await supabase.from("services").insert({ workspace_id: workspaceId, ...service, mix_share: count ? 0 : 1, provenance });
  if (error) return failure(error);
  refresh();
  return {};
}

export async function removeService(serviceId: string): Promise<ActionResult> {
  if (!isId(serviceId)) return { error: "Couldn't remove it. Try again." };
  const supabase = await createClient();
  const { data, error } = await supabase.from("services").delete().eq("id", serviceId).select("id");
  if (error) return failure(error);
  if (!data.length) return { error: "That service was already removed, or you can't edit it." };
  refresh();
  return {};
}

// Roles (issue #88). Owners and editors manage them; RLS enforces that.

export async function saveRoleField(roleId: string, field: RoleField, base: Scalar, value: Scalar): Promise<SaveOutcome<Scalar>> {
  const parsed = parseRoleField(roleId, field, base, value);
  if (!parsed) return invalid;
  if (!(await signedIn())) return signedOut;
  const outcome = await saveField("roles", { id: parsed.roleId }, parsed.field, parsed.base, parsed.value);
  // People and service labels use role names.
  if (outcome.status === "saved") refresh();
  return outcome;
}

export async function createRole(workspaceId: string, _prev: ActionResult, form: FormData): Promise<ActionResult> {
  if (!isId(workspaceId)) return { error: "Couldn't save. Try again." };
  const role = parseNewRole(form);
  if ("error" in role) return role;
  const supabase = await createClient();
  const { error } = await supabase.from("roles").insert({ workspace_id: workspaceId, name: role.name });
  if (error) return error.code === "23505" ? { error: `There is already a role called '${role.name}'.` } : failure(error);
  refresh();
  return {};
}

export async function removeRole(roleId: string): Promise<ActionResult> {
  if (!isId(roleId)) return { error: "Couldn't remove it. Try again." };
  const supabase = await createClient();
  const { data, error } = await supabase.from("roles").delete().eq("id", roleId).select("id");
  if (error) {
    return error.code === "23503" ? { error: "That role is still used by steps, people, clients or a service's fallback load. Make it inactive instead." } : failure(error);
  }
  if (!data.length) return { error: "That role was already removed, or you can't edit it." };
  refresh();
  return {};
}

// Demand (issue #13): lead sources, seasonality and growth. Owners and editors
// manage them; RLS enforces that. Changing a value makes its provenance
// `entered` (a database trigger), and each save refreshes the page so the
// totals and provenance shown catch up.

export async function saveLeadSourceField(
  sourceId: string,
  field: LeadSourceField,
  base: Scalar,
  value: Scalar,
): Promise<SaveOutcome<Scalar>> {
  const parsed = parseLeadSourceField(sourceId, field, base, value);
  if (!parsed) return invalid;
  if (!(await signedIn())) return signedOut;
  const outcome = await saveField("lead_sources", { id: parsed.sourceId }, parsed.field, parsed.base, parsed.value);
  if (outcome.status === "saved") refresh();
  return outcome;
}

export async function createLeadSource(workspaceId: string, _prev: ActionResult, form: FormData): Promise<ActionResult> {
  if (!isId(workspaceId)) return { error: "Couldn't save. Try again." };
  const source = parseNewLeadSource(form);
  if ("error" in source) return source;
  const supabase = await createClient();
  const { error } = await supabase.from("lead_sources").insert({ workspace_id: workspaceId, ...source });
  if (error) return failure(error);
  refresh();
  return {};
}

export async function removeLeadSource(sourceId: string): Promise<ActionResult> {
  if (!isId(sourceId)) return { error: "Couldn't remove it. Try again." };
  const supabase = await createClient();
  const { data, error } = await supabase.from("lead_sources").delete().eq("id", sourceId).select("id");
  if (error) return failure(error);
  if (!data.length) return { error: "That lead source was already removed, or you can't edit it." };
  refresh();
  return {};
}

/**
 * Save a value held in a row that may not exist yet: a month of the
 * seasonality curve (no row means 1) or the growth (no row means 0). With no
 * row the stored value is that default, so compare-and-set still holds: a
 * base equal to it inserts the row, any other base is a conflict (someone
 * reset it). An insert that loses a race to another one saves against it.
 */
async function saveOrInsert(
  save: () => Promise<SaveOutcome<number>>,
  insert: () => PromiseLike<{ error: { code?: string } | null }>,
  fallback: number,
  base: number,
  value: number,
): Promise<SaveOutcome<number>> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const outcome = await save();
    if (outcome.status !== "not_found") return outcome;
    if (base !== fallback) return { status: "conflict", theirs: fallback };
    const { error } = await insert();
    if (!error) return { status: "saved", value };
    // A viewer, or a workspace the user can't edit: as for an update.
    if (error.code === "42501") return { status: "not_found" };
    // 23505: another insert got there first; loop to save against it.
    if (error.code !== "23505") return { status: "error", message: "Couldn't save. Try again." };
  }
  return { status: "error", message: "Couldn't save. Try again." };
}

/** One month's seasonality multiplier (1 = January). */
export async function saveSeasonality(
  workspaceId: string,
  month: number,
  base: number | null,
  value: number | null,
): Promise<SaveOutcome<number | null>> {
  if (!isId(workspaceId) || !isMonth(month) || !isFiniteNumber(base) || !isMultiplier(value)) return invalid;
  if (!(await signedIn())) return signedOut;
  const supabase = await createClient();
  const outcome = await saveOrInsert(
    () => saveField<number>("seasonality", { workspace_id: workspaceId, month: String(month) }, "multiplier", base, value),
    () => supabase.from("seasonality").insert({ workspace_id: workspaceId, month, multiplier: value }),
    1,
    base,
    value,
  );
  if (outcome.status === "saved") refresh();
  return outcome;
}

/** Remove the seasonality curve: every month back to 1. */
export async function resetSeasonality(workspaceId: string): Promise<ActionResult> {
  if (!isId(workspaceId)) return { error: "Couldn't reset it. Try again." };
  const supabase = await createClient();
  const { error } = await supabase.from("seasonality").delete().eq("workspace_id", workspaceId);
  if (error) return failure(error);
  refresh();
  return {};
}

/** Monthly growth in demand, as a fraction (0.02 is +2% a month). */
export async function saveGrowth(workspaceId: string, base: number | null, value: number | null): Promise<SaveOutcome<number | null>> {
  if (!isId(workspaceId) || !isFiniteNumber(base) || !isGrowth(value)) return invalid;
  if (!(await signedIn())) return signedOut;
  const supabase = await createClient();
  const outcome = await saveOrInsert(
    () => saveField<number>("demand_settings", { workspace_id: workspaceId }, "growth_monthly", base, value),
    () => supabase.from("demand_settings").insert({ workspace_id: workspaceId, growth_monthly: value }),
    0,
    base,
    value,
  );
  if (outcome.status === "saved") refresh();
  return outcome;
}

// Market conditions (A57). Owners and editors manage them; RLS enforces that, and the four presets are read-only.

export interface MarketActionResult extends ActionResult {
  /** The condition just created, so the screen can select it. */
  id?: string;
}

/** Add a condition: a copy of `sourceId` (to customise a preset), or a fresh one starting from Stable. */
export async function createMarketCondition(workspaceId: string, sourceId: string | null): Promise<MarketActionResult> {
  if (!isId(workspaceId) || (sourceId !== null && !isId(sourceId))) return { error: "Couldn't save. Try again." };
  if (!(await signedIn())) return { error: signedOut.message };
  const supabase = await createClient();
  const query = supabase
    .from("market_conditions")
    .select("name, leads, conv, cycle, price, churn, hire, pay")
    .eq("workspace_id", workspaceId);
  const { data: from, error: readError } = await (sourceId ? query.eq("id", sourceId) : query.eq("preset", "stable")).maybeSingle();
  if (readError) return failure(readError);
  if (!from) return { error: "That market is gone. Reload the page." };
  const { name, ...values } = from;
  const { data, error } = await supabase
    .from("market_conditions")
    .insert({ workspace_id: workspaceId, ...values, name: sourceId ? copyName({ name }) : copyName(undefined) })
    .select("id")
    .single();
  if (error) return failure(error);
  refresh();
  return { id: data.id };
}

/** Save one column of one of your own conditions: its name, or a factor as a whole percent. The last save wins. */
export async function saveMarketField(conditionId: string, field: string, value: string | number): Promise<SaveOutcome<string | number>> {
  const parsed = parseConditionField(conditionId, field, value);
  if (!parsed) return invalid;
  if (!(await signedIn())) return signedOut;
  const supabase = await createClient();
  const { data, error } = await supabase.from("market_conditions").update({ [parsed.field]: parsed.value } as { name?: string } & Partial<Record<MarketFactorKey, number>>).eq("id", parsed.id).select("id, workspace_id");
  if (error) {
    return { status: "error", message: error.code === "42501" ? "You don't have permission to change this." : "Couldn't save. Try again." };
  }
  // A preset, or a row you can't edit, matches no row for an update.
  if (!data.length) return { status: "not_found" };
  refresh();
  return { status: "saved", value: parsed.value };
}

export async function removeMarketCondition(conditionId: string): Promise<ActionResult> {
  if (!isId(conditionId)) return { error: "Couldn't remove it. Try again." };
  if (!(await signedIn())) return { error: signedOut.message };
  const supabase = await createClient();
  const { data, error } = await supabase.from("market_conditions").delete().eq("id", conditionId).select("id");
  if (error) {
    // 23503: the schedule refers to it.
    if (error.code === "23503") return { error: "This market is on your schedule. Remove it from the schedule first." };
    return failure(error);
  }
  if (!data.length) return { error: "That market was already removed, or it is a preset, or you can't edit it." };
  refresh();
  return {};
}

export async function addMarketChange(workspaceId: string, _prev: ActionResult, form: FormData): Promise<ActionResult> {
  const parsed = parseChange(workspaceId, form.get("condition_id"), Number(form.get("from_month")), Number(form.get("to_month")));
  if ("error" in parsed) return parsed;
  if (!(await signedIn())) return { error: signedOut.message };
  const supabase = await createClient();
  const { error } = await supabase
    .from("market_schedule")
    .insert({ workspace_id: parsed.workspaceId, condition_id: parsed.conditionId, from_month: parsed.from, to_month: parsed.to });
  // 23P01: the months overlap another change (the table's trigger).
  if (error) return error.code === "23P01" ? { error: "Those months overlap another change. Remove it first, or pick other months." } : failure(error);
  refresh();
  return {};
}

export async function removeMarketChange(changeId: string): Promise<ActionResult> {
  if (!isId(changeId)) return { error: "Couldn't remove it. Try again." };
  if (!(await signedIn())) return { error: signedOut.message };
  const supabase = await createClient();
  const { data, error } = await supabase.from("market_schedule").delete().eq("id", changeId).select("id, workspace_id");
  if (error) return failure(error);
  if (!data.length) return { error: "That change was already removed, or you can't edit it." };
  refresh();
  return {};
}
