import "server-only";
import { cache } from "react";
import { headers } from "next/headers";
import { createDb } from "@transpera-flow/db/client";
import { claimsFor, type ClaimsUser } from "@/lib/db/claims";
import { appPool, authPool } from "@/lib/db/pool";
import { authEnv } from "./env";
import { getAuth } from "./server";

export interface SessionUser extends ClaimsUser {
  /** The profile name Google or Microsoft gave, or null. */
  name: string | null;
}

/**
 * The signed-in user, or null (also in demo mode). Cached for the request. The session cookie is validated against the
 * database by Better Auth, and the user's access is checked again here, so removing someone from the access list ends their
 * session at the next request, not only at the next sign-in. The agency-admin flag is read from `auth.users`, where the
 * sign-in sync keeps it.
 */
export const getSessionUser = cache(async (): Promise<SessionUser | null> => {
  const env = authEnv();
  if (!env) return null;
  const session = await getAuth().api.getSession({ headers: await headers() });
  if (!session) return null;
  const { rows } = await authPool().query(
    `select u.email,
            coalesce((u.raw_app_meta_data ->> 'agency_admin')::boolean, false) as agency_admin,
            private.deployment_role(u.email, u.email_confirmed_at is not null, $2::text[]) as role
     from auth.users u where u.id = $1`,
    [session.user.id, env.adminEmails],
  );
  const row = rows[0];
  if (!row || !row.role) return null;
  return {
    id: session.user.id,
    email: String(row.email),
    agencyAdmin: row.agency_admin === true,
    name: session.user.name?.trim() || null,
  };
});

/**
 * A database handle that runs every query as the signed-in user (or `anon`), under the same RLS the Supabase client used. Call
 * sites switch to it in steps 3c and 3d; until then they use `lib/supabase/server.ts`.
 */
export async function getDb(): Promise<ReturnType<typeof createDb>> {
  return createDb(appPool(), claimsFor(await getSessionUser()));
}
