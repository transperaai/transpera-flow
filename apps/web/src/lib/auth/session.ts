import "server-only";
import { cache } from "react";
import { headers } from "next/headers";
import { createDb } from "@transpera-flow/db/client";
import { claimsFor, type ClaimsUser } from "@/lib/db/claims";
import { appPool, authPool } from "@/lib/db/pool";
import { currentAccess } from "./access";
import { authEnv } from "./env";
import { getAuth } from "./server";

export interface SessionUser extends ClaimsUser {
  /** The profile name Google or Microsoft gave, or null. */
  name: string | null;
  /** Signed in only for a restricted share link (B3): no memberships, so RLS shows them no workspace. */
  guest: boolean;
}

/**
 * The signed-in user, or null (also in demo mode). Cached for the request. The session cookie is validated against the
 * database by Better Auth, and the user's access is checked again here, so removing someone from the access list ends their
 * session at the next request, not only at the next sign-in. The agency-admin flag is read from `auth.users`, where the
 * sign-in sync keeps it, and counts only while the list still says admin: a demotion takes effect at the next request too.
 */
export const getSessionUser = cache(async (): Promise<SessionUser | null> => {
  const env = authEnv();
  if (!env) return null;
  return onceForRequest(await headers(), async (h) => {
    const session = await getAuth().api.getSession({ headers: h });
    if (!session) return null;
    const access = await currentAccess(authPool(), session.user.id, env.adminEmails);
    if (!access) return null;
    return {
      id: session.user.id,
      ...access,
      name: session.user.name?.trim() || null,
    };
  });
});

// React's `cache` memoizes only inside a render: in a Server Action or a Route Handler it calls through every time, and nearly
// every action asks `getSessionUser()` and then `getDb()`, which asks again (a Better Auth session read and the access check,
// each a database round trip). Keyed on the request's own headers object, which `headers()` hands back for the whole request.
const perRequest = new WeakMap<object, Promise<SessionUser | null>>();

/** `load(h)` once per request headers object; a failed load isn't kept. Exported for tests. */
export function onceForRequest(h: Headers, load: (h: Headers) => Promise<SessionUser | null>): Promise<SessionUser | null> {
  let found = perRequest.get(h);
  if (!found) {
    found = load(h);
    perRequest.set(h, found);
    found.catch(() => perRequest.delete(h));
  }
  return found;
}

/**
 * A database handle that runs every query as the signed-in user (or `anon`),, under RLS.
 */
export async function getDb(): Promise<ReturnType<typeof createDb>> {
  return createDb(appPool(), claimsFor(await getSessionUser()));
}
