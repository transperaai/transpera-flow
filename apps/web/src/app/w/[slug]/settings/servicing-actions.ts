"use server";

import { refresh } from "next/cache";
import { MAX_SLA_HOURS, parseRecurrence, type Json, type RecurrenceJson } from "@transpera-flow/db";
import type { SaveOutcome } from "@/lib/fields/field-controller";
import { saveField, saveFields, saveHealthRule } from "@/lib/fields/server";
import { HEALTH_SETTINGS, type HealthSetting } from "@/lib/servicing";
import { isId } from "@/lib/services";
import { createClient } from "@/lib/supabase/server";

// Client servicing settings (issue #19): which servicing processes each
// service's clients run, how often and within what SLA, and the workspace's
// health rules. Owners and editors change links (RLS); health rules are
// workspace settings, which owners and editors change (`save_health_rules`). Every write runs as the signed-in
// user; these checks only reject malformed input early.

const invalid = { status: "error", message: "That value isn't valid." } as const;
const signedOut = { status: "error", message: "Your session has ended. Sign in again." } as const;

async function signedIn() {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  return data?.claims?.sub ? supabase : null;
}

export interface LinkResult {
  error?: string;
}

const failure = (error: { code?: string } | null): LinkResult =>
  error?.code === "42501"
    ? { error: "You don't have permission to do that." }
    : error?.code === "23505"
      ? { error: "That service already runs this process." }
      : error?.code === "23514"
        ? { error: "Only a servicing process can be linked, with a valid recurrence and SLA." }
        : { error: "Couldn't save. Try again." };

/** Link a servicing process to a service: monthly, on time within a working week, until changed. */
export async function linkServicingProcess(workspaceId: string, serviceId: string, processId: string): Promise<LinkResult> {
  if (!isId(workspaceId) || !isId(serviceId) || !isId(processId)) return { error: "Couldn't save. Try again." };
  const supabase = await signedIn();
  if (!supabase) return { error: signedOut.message };
  const { error } = await supabase.from("service_servicing").insert({ workspace_id: workspaceId, service_id: serviceId, process_id: processId });
  if (error) return failure(error);
  refresh();
  return {};
}

export async function unlinkServicingProcess(linkId: string): Promise<LinkResult> {
  if (!isId(linkId)) return { error: "Couldn't remove it. Try again." };
  const supabase = await signedIn();
  if (!supabase) return { error: signedOut.message };
  const { data, error } = await supabase.from("service_servicing").delete().eq("id", linkId).select("id");
  if (error) return failure(error);
  if (!data.length) return { error: "That link was already removed, or you can't edit it." };
  refresh();
  return {};
}

/** How often a link's clients get a task, if the stored value is still `base`. */
export async function saveServicingRecurrence(linkId: string, base: RecurrenceJson, next: RecurrenceJson): Promise<SaveOutcome<string>> {
  const b = parseRecurrence(base);
  const n = parseRecurrence(next);
  if (!isId(linkId) || !b || !n) return invalid;
  if (!(await signedIn())) return signedOut;
  const r = await saveFields<Json>("service_servicing", { id: linkId }, { recurrence: b as Json }, { recurrence: n as Json });
  if (r.status === "saved") return { status: "saved", value: JSON.stringify(n) };
  if (r.status === "conflict") return { status: "conflict", theirs: JSON.stringify(r.theirs.recurrence ?? null) };
  return r;
}

/** A link's SLA in working hours. */
export async function saveServicingSla(linkId: string, base: number | null, value: number | null): Promise<SaveOutcome<number | null>> {
  const ok = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v > 0 && v <= MAX_SLA_HOURS;
  if (!isId(linkId) || !ok(value) || !(base === null || typeof base === "number")) return invalid;
  if (!(await signedIn())) return signedOut;
  return saveField("service_servicing", { id: linkId }, "sla_hours", base, value);
}

/** One of the workspace's health rules (a `settings` key); null restores the estimated default. */
export async function saveHealthSetting(
  workspaceId: string,
  key: HealthSetting,
  base: number | null,
  value: number | null,
): Promise<SaveOutcome<number | null>> {
  const rule = Object.hasOwn(HEALTH_SETTINGS, key) ? HEALTH_SETTINGS[key] : undefined;
  const ok = (v: unknown) => v === null || (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= (rule?.max ?? 0));
  if (!isId(workspaceId) || !rule || !ok(value) || !(base === null || typeof base === "number")) return invalid;
  if (!(await signedIn())) return signedOut;
  return saveHealthRule(workspaceId, key, base, value);
}
