import "server-only";
import { getDb } from "@/lib/auth/session";
import type { DepartmentLaneInput } from "@/lib/overview/department-lanes";

/**
 * What the company map's department lanes and the process page's Department field need (Q4): the workspace's departments in their
 * order, its tier services (the services that are a tier of a department) and the servicing links between processes and services. As the
 * signed-in user, so row-level security decides what is visible; a workspace that can't be read gives an empty input (one lane).
 */
export async function loadDepartmentLaneInput(workspaceId: string): Promise<DepartmentLaneInput> {
  const db = await getDb();
  try {
    const [departments, services, links] = await Promise.all([
      db.selectFrom("departments").select(["id", "name", "sort"]).where("workspace_id", "=", workspaceId).orderBy("sort").orderBy("name").execute(),
      db.selectFrom("services").select(["id", "department_id", "tier_id"]).where("workspace_id", "=", workspaceId).where("tier_id", "is not", null).execute(),
      db.selectFrom("service_servicing").select(["process_id", "service_id"]).where("workspace_id", "=", workspaceId).execute(),
    ]);
    return { departments, services, links };
  } catch {
    return { departments: [], services: [], links: [] };
  }
}
