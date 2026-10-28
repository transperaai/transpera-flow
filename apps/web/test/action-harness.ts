import { randomUUID } from "node:crypto";
import { redirect } from "next/navigation";
import { claimsFor } from "@/lib/db/claims";
import { createTestDb, createUser, type TestDb } from "../../../packages/db/test/harness";

// Shared by the Server Action tests. They run against a throwaway Postgres with the real migrations (RLS applies, as the app's
// getDb() gives it), and mock only `@/lib/auth/session`:
//
//   vi.mock("@/lib/auth/session", async () => (await import("./action-harness")).sessionMock);
//
// then `await signInAs(world, "editor")` (or `signOut()`) picks who the next action runs as. Seed with `world.tdb.client`, the
// owner connection (no RLS).

export interface TestUser {
  id: string;
  email: string;
  agencyAdmin: boolean;
}

const session: { db: ReturnType<TestDb["dbAs"]> | null; user: (TestUser & { name: string | null; guest: boolean }) | null } = { db: null, user: null };

/** What the mocked `@/lib/auth/session` module exports. */
export const sessionMock = {
  // As the real getDb(): signed out, it redirects to /login rather than querying as anon.
  getDb: async () => {
    if (!session.db) throw new Error("action-harness: call signInAs() or signOut() first");
    if (!session.user) redirect("/login");
    return session.db;
  },
  // The share link's page and its Send action, and the logo route: as the signed-in user, or anon.
  getVisitorDb: async () => {
    if (!session.db) throw new Error("action-harness: call signInAs() or signOut() first");
    return session.db;
  },
  getSessionUser: async () => session.user,
};

export interface World {
  tdb: TestDb;
  workspaceId: string;
  slug: string;
  users: Record<"owner" | "editor" | "member" | "viewer" | "admin" | "stranger", TestUser>;
}

/**
 * The world's actors keep four labels from before the three roles (migration 20270103000000), and the memberships they get are
 * the two that exist: `owner` and `editor` are Agency admins (an `owner` membership), `member` and `viewer` are Viewers.
 * `admin` is the Owner (the agency-admin flag).
 */
const ROLES = ["owner", "editor", "member", "viewer"] as const;

/** A database with one workspace (`slug`), a user in each role, an agency admin (a member as `agency_admin`) and a stranger. */
export async function createWorld(slug = "acme"): Promise<World> {
  const tdb = await createTestDb();
  const workspaceId = (await tdb.client.query("insert into workspaces (name, slug) values ($1, $2) returning id", ["Acme", slug])).rows[0].id as string;
  const users = {} as World["users"];
  for (const role of ROLES) {
    const u = await createUser(tdb, `${role}@${slug}.example.com`);
    await tdb.client.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, (case $3::text when 'editor' then 'owner' when 'member' then 'viewer' else $3::text end)::membership_role)", [workspaceId, u.id, role]);
    users[role] = { id: u.id, email: `${role}@${slug}.example.com`, agencyAdmin: false };
  }
  const admin = await createUser(tdb, `admin@${slug}.example.com`, { agency_admin: true });
  await tdb.client.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, 'owner')", [workspaceId, admin.id]);
  users.admin = { id: admin.id, email: `admin@${slug}.example.com`, agencyAdmin: true };
  const stranger = await createUser(tdb, `stranger@${slug}.example.com`);
  users.stranger = { id: stranger.id, email: `stranger@${slug}.example.com`, agencyAdmin: false };
  return { tdb, workspaceId, slug, users };
}

/** A new user who is a member of `workspaceId` with `role` (optionally linked to a person), for databases not made by createWorld. */
export async function addMember(tdb: TestDb, workspaceId: string, role: string, personId: string | null = null, appMetadata: Record<string, unknown> = {}): Promise<TestUser> {
  const email = `${role}-${randomUUID().slice(0, 8)}@example.com`;
  const u = await createUser(tdb, email, appMetadata);
  await tdb.client.query("insert into memberships (workspace_id, user_id, role, person_id) values ($1, $2, (case $3::text when 'editor' then 'owner' when 'member' then 'viewer' else $3::text end)::public.membership_role, $4)", [workspaceId, u.id, role, personId]);
  return { id: u.id, email, agencyAdmin: appMetadata.agency_admin === true };
}

/** The next action runs as this user (RLS applies), or as the signed-out `anon` role. */
export function signInAs(world: { tdb: TestDb; users?: World["users"] }, who: keyof World["users"] | TestUser): void {
  const user = typeof who === "string" ? world.users![who] : who;
  session.user = { ...user, name: null, guest: false };
  session.db = world.tdb.dbAs(claimsFor(user));
}

/**
 * Signed in as far as the app can tell (getSessionUser returns the user), but the database handle runs as `anon`: every query
 * that needs a signed-in role fails. For the paths where a database error must produce the action's generic message.
 */
export function signInWithBrokenDb(world: { tdb: TestDb; users?: World["users"] }, who: keyof World["users"] | TestUser): void {
  signInAs(world, who);
  session.db = world.tdb.dbAs(null);
}

export function signOut(world: { tdb: TestDb }): void {
  session.user = null;
  session.db = world.tdb.dbAs(null);
}

export const uuid = () => randomUUID();
