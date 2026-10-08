import { randomUUID } from "node:crypto";
import type pg from "pg";
import { signJwt } from "./helpers";

// A workspace exactly as a new client leaves `create_workspace`: the company map, the agency admin's membership and the seeded
// scenarios, and nothing else (no roles, people, clients or processes). For the tests that pin the fresh-client path (issue #243).

export type FreshUser = "agency" | "owner" | "editor" | "member" | "viewer";

export interface FreshWorkspace {
  wsId: string;
  slug: string;
  companyId: string;
  users: Record<FreshUser, { id: string; jwt: string }>;
}

const MEMBERSHIPS = { owner: "owner", editor: "editor", member: "member", viewer: "viewer" } as const;

/**
 * Makes a user for each way of being in a workspace, has the agency admin create the workspace through `create_workspace` over SQL
 * (as that user, under RLS: the production path), and adds the other four. `secret` signs the users' JWTs for PostgREST.
 */
export async function createFreshWorkspace(admin: pg.Client, secret: string): Promise<FreshWorkspace> {
  const tag = randomUUID().slice(0, 8);
  const slug = `fresh-${tag}`;
  const ids = {} as Record<FreshUser, string>;
  for (const k of ["agency", "owner", "editor", "member", "viewer"] as const) {
    ids[k] = randomUUID();
    await admin.query("insert into auth.users (id, email, raw_app_meta_data) values ($1, $2, $3)", [
      ids[k],
      `fresh-${k}-${tag}@example.com`,
      k === "agency" ? { agency_admin: true } : {},
    ]);
  }
  const claims = (k: FreshUser) => ({ sub: ids[k], role: "authenticated", aud: "authenticated", app_metadata: k === "agency" ? { agency_admin: true } : {} });

  // The agency admin creates it: the function runs as the caller, so RLS checks both inserts.
  await admin.query("begin");
  let wsId: string;
  try {
    await admin.query("set local role authenticated");
    await admin.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims("agency"))]);
    wsId = (await admin.query("select public.create_workspace('Fresh Co', $1) as id", [slug])).rows[0].id as string;
    await admin.query("commit");
  } catch (e) {
    await admin.query("rollback");
    throw e;
  }
  for (const [k, role] of Object.entries(MEMBERSHIPS)) {
    await admin.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, $3)", [wsId, ids[k as keyof typeof MEMBERSHIPS], role]);
  }
  const companyId = (await admin.query("select id from processes where workspace_id = $1 and is_company", [wsId])).rows[0].id as string;
  const users = Object.fromEntries(
    (Object.keys(ids) as FreshUser[]).map((k) => [k, { id: ids[k], jwt: signJwt(claims(k), secret) }]),
  ) as FreshWorkspace["users"];
  return { wsId, slug, companyId, users };
}

/** Removes the workspace and the users `createFreshWorkspace` made, and nothing else. */
export async function removeFreshWorkspace(admin: pg.Client, fresh: FreshWorkspace): Promise<void> {
  await admin.query("delete from workspaces where id = $1", [fresh.wsId]);
  await admin.query("delete from audit_log where workspace_id = $1", [fresh.wsId]);
  await admin.query("delete from auth.users where id = any($1)", [Object.values(fresh.users).map((u) => u.id)]);
}
