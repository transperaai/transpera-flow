"use server";

import { isId } from "@/lib/editor/validate";
import { cleanProcessName, type ProcessAdminResult, type ProcessKind } from "@/lib/processes/admin";
import type { Db } from "@transpera-flow/db";
import { pgCode } from "@/app/action-db";
import { getDb, getSessionUser } from "@/lib/auth/session";

// Process admin from the Processes page (issue #182, B19 2/2; ADR 0014 "B19: archiving a process"): rename a process, change its
// kind, archive it (soft delete) and restore it. Each is an ordinary update of `processes` as the signed-in user, so RLS decides
// (owners, editors and agency admins write; viewers read), and the database does the rest: the company map follows a rename, a
// kind change, an archive and a restore as a system version, and archiving is refused, with a plain message naming the processes
// involved, for a process inside another ordinary process or one that holds others. Nothing here deletes a process.

const signedOut = { status: "error", message: "Your session has ended. Sign in again." } as const;
const forbidden = { status: "error", message: "Only owners and editors can change processes here." } as const;
const generic = { status: "error", message: "Couldn't save. Try again." } as const;

async function signedInClient(): Promise<Db | null> {
  return (await getSessionUser()) ? getDb() : null;
}

/** The process (never the company map), as the caller may read it; null when it isn't there or isn't visible. */
async function readProcess(db: Db, processId: string) {
  const data = await db
    .selectFrom("processes")
    .select(["id", "workspace_id", "name", "kind", "entity_name", "archived_at", "is_company"])
    .where("id", "=", processId)
    .executeTakeFirst()
    .catch(() => undefined);
  return data && !data.is_company ? data : null;
}

/** An update of one process; zero rows back means RLS stopped it (a viewer). The database's own refusals are passed on. */
async function update(
  db: Db,
  processId: string,
  changes: { name?: string; kind?: ProcessKind; entity_name?: string; archived_at?: string | null },
): Promise<ProcessAdminResult> {
  try {
    const data = await db.updateTable("processes").set(changes).where("id", "=", processId).where("is_company", "=", false).returning("id").execute();
    return data.length ? { status: "ok" } : forbidden;
  } catch (e) {
    const code = pgCode(e);
    if (code === "42501") return forbidden;
    // 55000: archiving refused (inside another process, holding others); 23514: a kind change refused (linked to services).
    const message = (e as { message?: string }).message;
    if ((code === "55000" || code === "23514") && message) return { status: "error", message };
    return generic;
  }
}

export async function renameProcess(processId: unknown, name: unknown): Promise<ProcessAdminResult> {
  const clean = cleanProcessName(name);
  if (!isId(processId)) return generic;
  if (!clean.ok) return { status: "error", message: clean.error };
  const db = await signedInClient();
  if (!db) return signedOut;
  const proc = await readProcess(db, processId);
  if (!proc) return { status: "error", message: "That process isn't there any more. Reload the page." };
  if (proc.name === clean.name) return { status: "ok" };
  // Names are unique among the processes in use (an archived one gives its name up; restoring it checks again).
  const others = await db
    .selectFrom("processes")
    .select(["id", "name"])
    .where("workspace_id", "=", proc.workspace_id)
    .where("is_company", "=", false)
    .where("archived_at", "is", null)
    .where("id", "<>", processId)
    .execute()
    .catch(() => []);
  if (others.some((p) => p.name.trim().toLowerCase() === clean.name.toLowerCase())) return { status: "error", message: `There is already a process called '${clean.name}'.` };
  return update(db, processId, { name: clean.name });
}

export async function changeProcessKind(processId: unknown, kind: unknown): Promise<ProcessAdminResult> {
  if (!isId(processId) || (kind !== "pipeline" && kind !== "servicing")) return generic;
  const to = kind as ProcessKind;
  const db = await signedInClient();
  if (!db) return signedOut;
  const proc = await readProcess(db, processId);
  if (!proc) return { status: "error", message: "That process isn't there any more. Reload the page." };
  if (proc.kind === to) return { status: "ok" };
  if (to === "pipeline") {
    // The database refuses it too; say which services first.
    const links = await db
      .selectFrom("service_servicing")
      .leftJoin("services", "services.id", "service_servicing.service_id")
      .select("services.name as name")
      .where("service_servicing.process_id", "=", processId)
      .execute()
      .catch(() => []);
    const names = [...new Set(links.map((l) => l.name).filter((n): n is string => !!n))].sort();
    if (names.length) return { status: "error", message: `${proc.name} is client work for ${names.join(", ")}. Unlink it from ${names.length === 1 ? "that service" : "those services"} in Settings, Services first.` };
  }
  // The word for what flows through it follows the kind, unless someone chose their own.
  const entity = proc.entity_name === "lead" || proc.entity_name === "task" || proc.entity_name === "item" ? (to === "pipeline" ? "lead" : "task") : proc.entity_name;
  return update(db, processId, { kind: to, entity_name: entity });
}

export async function archiveProcess(processId: unknown): Promise<ProcessAdminResult> {
  if (!isId(processId)) return generic;
  const db = await signedInClient();
  if (!db) return signedOut;
  // The database stamps when and by whom.
  return update(db, processId, { archived_at: new Date().toISOString() });
}

export async function restoreProcess(processId: unknown): Promise<ProcessAdminResult> {
  if (!isId(processId)) return generic;
  const db = await signedInClient();
  if (!db) return signedOut;
  return update(db, processId, { archived_at: null });
}
