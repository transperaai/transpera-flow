"use server";

import { refresh } from "next/cache";
import { addTier, checkSetupValue, formatRamp, parseRamp, removeTier, setupFieldRule, type SetupTable } from "@transpera-flow/db";
import type { SaveOutcome } from "@/lib/fields/field-controller";
import { saveField, saveFields, saveLinks } from "@/lib/fields/server";
import { isId } from "@/lib/clients";
import { pgCode } from "@/app/action-db";
import { saveClientAssignment } from "../settings/client-actions";
import { getDb, getSessionUser } from "@/lib/auth/session";

// Writes from the Set up pages (Tiers & clients, People & roles): the capacity columns, tier counts and portfolios. Every write runs as the
// signed-in user through row-level security (the Owner and Agency admins change; a Viewer can't); these checks only reject malformed
// input early. Saves use the compare-and-set `save_fields`, so two people editing one field are asked which value to keep.

type Scalar = string | number | boolean | null;

const invalid = { status: "error", message: "That value isn't valid." } as const;
const signedOut = { status: "error", message: "Your session has ended. Sign in again." } as const;
const signedIn = async () => Boolean(await getSessionUser());
const isBase = (v: unknown): boolean => v === null || typeof v === "string" || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v));

/** The columns that identify a row, per table: every Set up save names its row by exactly these. */
const KEYS: Record<SetupTable, readonly string[][]> = {
  departments: [["id"]],
  tiers: [["id"]],
  services: [["id"]],
  clients: [["id"]],
  people: [["id"]],
  roles: [["id"]],
  person_portfolio: [["person_id", "service_id"]],
};

function validKey(table: SetupTable, key: Record<string, string>): boolean {
  const names = Object.keys(key).sort();
  return KEYS[table].some((k) => k.length === names.length && [...k].sort().every((n, i) => n === names[i])) && Object.values(key).every(isId);
}

/** One capacity field of one row: a column the Set up screens save (SETUP_FIELDS), if its stored value is still `base`. */
export async function saveSetupField(table: SetupTable, key: Record<string, string>, field: string, base: Scalar, value: Scalar): Promise<SaveOutcome<Scalar>> {
  if (!Object.hasOwn(KEYS, table) || !validKey(table, key) || !isBase(base)) return invalid;
  const rule = setupFieldRule(table, field);
  if (!rule || rule.type === "ramp") return invalid;
  const checked = checkSetupValue(rule, value);
  if (!checked.ok) return invalid;
  if (!(await signedIn())) return signedOut;
  const out = await saveField(table, key, field, base, checked.value as Scalar);
  return out;
}

/** A person's own ramp as typed ("40, 60, 80": percent of full capacity in each month), or blank for the workspace default. */
export async function savePersonRamp(personId: string, base: string | null, value: string | null): Promise<SaveOutcome<string | null>> {
  const b = parseRamp(base);
  const v = parseRamp(value);
  if (!isId(personId) || b === undefined || v === undefined) return invalid;
  if (!(await signedIn())) return signedOut;
  const out = await saveFields<Scalar | number[]>("people", { id: personId }, { ramp: b }, { ramp: v });
  if (out.status === "saved") return { status: "saved", value: formatRamp(v) };
  if (out.status === "conflict") return { status: "conflict", theirs: formatRamp((out.theirs.ramp ?? null) as number[] | null) };
  if (out.status === "not_found") return { status: "not_found" };
  return out;
}

/** The workspace's ramp default as typed, or null for the built-in one. */
export async function saveRampDefault(workspaceId: string, base: string | null, value: string | null): Promise<SaveOutcome<string | null>> {
  const b = parseRamp(base);
  const v = parseRamp(value);
  if (!isId(workspaceId) || b === undefined || v === undefined) return invalid;
  if (!(await signedIn())) return signedOut;
  const field = "settings.ramp_default";
  const out = await saveFields<Scalar | number[]>("workspaces", { id: workspaceId }, { [field]: b }, { [field]: v });
  if (out.status === "saved") return { status: "saved", value: formatRamp(v) };
  if (out.status === "conflict") return { status: "conflict", theirs: formatRamp((out.theirs[field] ?? null) as number[] | null) };
  if (out.status === "not_found") return { status: "not_found" };
  return out;
}

/** Whether DLER counts leadership's salary (`settings.dler_includes_leadership`; unset means yes). */
export async function saveDlerIncludesLeadership(workspaceId: string, base: boolean, value: boolean): Promise<SaveOutcome<boolean>> {
  if (!isId(workspaceId) || typeof base !== "boolean" || typeof value !== "boolean") return invalid;
  if (!(await signedIn())) return signedOut;
  // Unset reads as true, so a base of true matches an unset key too.
  const field = "settings.dler_includes_leadership";
  const db = await getDb();
  let stored: boolean;
  try {
    const row = await db.selectFrom("workspaces").select("settings").where("id", "=", workspaceId).executeTakeFirst();
    if (!row) return { status: "not_found" };
    stored = (row.settings as Record<string, unknown>).dler_includes_leadership !== false;
  } catch {
    return { status: "error", message: "Couldn't save. Try again." };
  }
  if (stored !== base) return { status: "conflict", theirs: stored };
  const storedRaw = ((await db.selectFrom("workspaces").select("settings").where("id", "=", workspaceId).executeTakeFirst())?.settings as Record<string, unknown> | undefined)?.dler_includes_leadership;
  const out = await saveFields<Scalar>("workspaces", { id: workspaceId }, { [field]: (storedRaw ?? null) as Scalar }, { [field]: value });
  if (out.status === "saved") return { status: "saved", value };
  if (out.status === "conflict") return { status: "conflict", theirs: out.theirs[field] !== false };
  if (out.status === "not_found") return { status: "not_found" };
  return out;
}

export interface TierResult {
  error?: string;
}

/** + Add a tier: the next key (T4), a copy of the last tier's values for each department, counts at 0. */
export async function addTierAction(workspaceId: string): Promise<TierResult> {
  if (!isId(workspaceId)) return { error: "Couldn't save. Try again." };
  if (!(await signedIn())) return { error: signedOut.message };
  const out = await addTier(await getDb(), workspaceId);
  if (!out.ok) return { error: out.message };
  refresh();
  return {};
}

/** Remove a tier; refused in plain words while clients, a portfolio or servicing steps still use it. */
export async function removeTierAction(tierId: string): Promise<TierResult> {
  if (!isId(tierId)) return { error: "Couldn't save. Try again." };
  if (!(await signedIn())) return { error: signedOut.message };
  const out = await removeTier(await getDb(), tierId);
  if (!out.ok) return { error: out.message };
  refresh();
  return {};
}

/**
 * A person's counted clients on one service (a tier of a department), if it is still `base`. A person with no row for the service has 0;
 * the first count creates it, and 0 over a row keeps the row (so who held what stays in the audit log).
 */
export async function savePortfolioCount(workspaceId: string, personId: string, serviceId: string, base: number, next: number): Promise<SaveOutcome<number>> {
  const rule = setupFieldRule("person_portfolio", "client_count")!;
  if (!isId(workspaceId) || !isId(personId) || !isId(serviceId) || !checkSetupValue(rule, base).ok || !checkSetupValue(rule, next).ok) return invalid;
  if (!(await signedIn())) return signedOut;
  const db = await getDb();
  let stored: number | null;
  try {
    const row = await db.selectFrom("person_portfolio").select("client_count").where("person_id", "=", personId).where("service_id", "=", serviceId).executeTakeFirst();
    stored = row ? Number(row.client_count) : null;
  } catch {
    return { status: "error", message: "Couldn't save. Try again." };
  }
  if (stored === null) {
    if (base !== 0) return { status: "conflict", theirs: 0 };
    if (next === 0) return { status: "saved", value: 0 };
    try {
      await db.insertInto("person_portfolio").values({ person_id: personId, service_id: serviceId, workspace_id: workspaceId, client_count: next }).execute();
    } catch (e) {
      return pgCode(e) === "42501" ? { status: "error", message: "You don't have permission to change this." } : pgCode(e) === "23505" ? { status: "error", message: "Someone just changed this. Reload to see it." } : { status: "error", message: "Couldn't save. Try again." };
    }
    refresh();
    return { status: "saved", value: next };
  }
  const out = await saveField("person_portfolio", { person_id: personId, service_id: serviceId }, "client_count", base, next);
  if (out.status === "saved") refresh();
  return out as SaveOutcome<number>;
}

/** The tiers a person can serve, saved as one set. */
export async function savePersonTiers(personId: string, workspaceId: string, base: string[], next: string[]): Promise<SaveOutcome<string[]>> {
  const ids = (v: unknown) => Array.isArray(v) && v.length <= 100 && v.every(isId);
  if (!isId(personId) || !isId(workspaceId) || !ids(base) || !ids(next)) return invalid;
  if (!(await signedIn())) return signedOut;
  const out = await saveLinks("person_tiers", { person_id: personId, workspace_id: workspaceId }, base, next);
  if (out.status === "saved") refresh();
  return out;
}

export interface NamedClientResult {
  error?: string;
  id?: string;
}

/** + Add a client: a name, on one tier of one department (its service). Everything else starts blank and uses the tier's values. */
export async function addNamedClient(workspaceId: string, serviceId: string, name: string): Promise<NamedClientResult> {
  const clean = typeof name === "string" ? name.trim() : "";
  if (!isId(workspaceId) || !isId(serviceId)) return { error: "Couldn't save. Try again." };
  if (clean.length === 0 || clean.length > 200) return { error: "Enter the client's name." };
  if (!(await signedIn())) return { error: signedOut.message };
  const db = await getDb();
  try {
    const service = await db.selectFrom("services").select("id").where("id", "=", serviceId).where("workspace_id", "=", workspaceId).executeTakeFirst();
    if (!service) return { error: "Pick a tier first." };
    const client = await db.insertInto("clients").values({ workspace_id: workspaceId, name: clean }).returning("id").executeTakeFirstOrThrow();
    await db.insertInto("client_services").values({ client_id: client.id, service_id: serviceId, workspace_id: workspaceId }).execute();
    refresh();
    return { id: client.id };
  } catch (e) {
    return { error: pgCode(e) === "42501" ? "You don't have permission to add clients." : "Couldn't save. Try again." };
  }
}

/**
 * Who looks after a named client: the person, in their client-facing role of the client's department. Moves the client from the
 * previous person (a role that may differ) to the new one; each step is compare-and-set. `from` and `to` are null for nobody.
 */
export async function saveClientLookedAfter(
  clientId: string,
  workspaceId: string,
  from: { roleId: string; personId: string } | null,
  to: { roleId: string; personId: string } | null,
): Promise<SaveOutcome<string | null>> {
  const ok = (v: { roleId: string; personId: string } | null) => v === null || (isId(v.roleId) && isId(v.personId));
  if (!isId(clientId) || !isId(workspaceId) || !ok(from) || !ok(to)) return invalid;
  if (!(await signedIn())) return signedOut;
  if (from && to && from.roleId === to.roleId) return saveClientAssignment(clientId, workspaceId, to.roleId, from.personId, to.personId);
  if (from) {
    const cleared = await saveClientAssignment(clientId, workspaceId, from.roleId, from.personId, null);
    if (cleared.status !== "saved") return cleared;
  }
  if (to) return saveClientAssignment(clientId, workspaceId, to.roleId, null, to.personId);
  return { status: "saved", value: null };
}
