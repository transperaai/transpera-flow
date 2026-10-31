"use server";

import { refresh } from "next/cache";
import type { SaveOutcome } from "@/lib/fields/field-controller";
import { saveField, saveLinks } from "@/lib/fields/server";
import { CLIENT_FIELDS, isBase, isClientField, isId, type ClientField } from "@/lib/clients";
import { pgCode } from "@/app/action-db";
import { getDb, getSessionUser } from "@/lib/auth/session";

// Clients by hand (issue #182, B19). Every write runs as the signed-in user through row-level security: Agency admins
// change clients, viewers can't. A client is never deleted (the database refuses it): they are made inactive. These checks
// only reject malformed input early.

type Scalar = string | number | boolean | null;

const invalid = { status: "error", message: "That value isn't valid." } as const;
const signedOut = { status: "error", message: "Your session has ended. Sign in again." } as const;

async function signedIn(): Promise<boolean> {
  return Boolean(await getSessionUser());
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
  const db = await getDb();
  let rows;
  try {
    rows = await db
      .selectFrom("client_assignments")
      .select("person_id")
      .where("client_id", "=", clientId)
      .where("role_id", "=", roleId)
      .where("workspace_id", "=", workspaceId)
      .execute();
  } catch {
    return { status: "error", message: "Couldn't save. Try again." };
  }
  const stored = rows[0]?.person_id ?? null;
  if (stored === next) return { status: "saved", value: next };
  if (stored !== base) return { status: "conflict", theirs: stored };
  const failed = (code?: string): SaveOutcome<string | null> =>
    code === "42501" ? { status: "error", message: "You don't have permission to change this." } : { status: "error", message: "Couldn't save. Try again." };
  if (next === null) {
    let data;
    try {
      data = await db.deleteFrom("client_assignments").where("client_id", "=", clientId).where("role_id", "=", roleId).where("person_id", "=", base!).returning("person_id").execute();
    } catch (e) {
      return failed(pgCode(e));
    }
    if (!data.length) return { status: "not_found" };
  } else if (base === null) {
    try {
      await db.insertInto("client_assignments").values({ client_id: clientId, role_id: roleId, person_id: next, workspace_id: workspaceId }).execute();
    } catch (e) {
      return pgCode(e) === "23505" ? { status: "error", message: "Someone just changed this. Reload to see it." } : failed(pgCode(e));
    }
  } else {
    const r = await saveField("client_assignments", { client_id: clientId, role_id: roleId }, "person_id", base, next);
    return r;
  }
  return { status: "saved", value: next };
}
