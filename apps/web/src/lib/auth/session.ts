import "server-only";
import { cache } from "react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { createDb } from "@transpera-flow/db/client";
import { claimsFor, type ClaimsUser } from "@/lib/db/claims";
import { appPool, authPool } from "@/lib/db/pool";
import { ACCESS_DENIED_CODE, currentAccess } from "./access";
import { authEnv } from "./env";
import { getAuth } from "./server";

export interface SessionUser extends ClaimsUser {
  /** The profile name Google or Microsoft gave, or null. */
  name: string | null;
}

/** Who the request's session cookie names, and, when nobody, whether a live session was refused by the access list. */
export interface SessionLookup {
  user: SessionUser | null;
  /** A valid session whose owner may no longer sign in (taken off the access list). */
  refused: boolean;
}

const NOBODY: SessionLookup = { user: null, refused: false };

const lookupSession = cache(async (): Promise<SessionLookup> => {
  const env = authEnv();
  if (!env) return NOBODY;
  return onceForRequest(await headers(), async (h) => {
    const session = await getAuth().api.getSession({ headers: h });
    if (!session) return NOBODY;
    const access = await currentAccess(authPool(), session.user.id, env.adminEmails);
    if (!access) return { user: null, refused: true };
    return {
      user: { id: session.user.id, ...access, name: session.user.name?.trim() || null },
      refused: false,
    };
  });
});

/**
 * The signed-in user, or null (also in demo mode). Cached for the request. The session cookie is validated against the
 * database by Better Auth, and the user's access is checked again here, so removing someone from the access list ends their
 * session at the next request, not only at the next sign-in. The agency-admin flag is read from `auth.users`, where the
 * sign-in sync keeps it, and counts only while the list still says admin: a demotion takes effect at the next request too.
 */
export const getSessionUser = cache(async (): Promise<SessionUser | null> => (await lookupSession()).user);

// React's `cache` memoizes only inside a render: in a Server Action or a Route Handler it calls through every time, and nearly
// every action asks `getSessionUser()` and then `getDb()`, which asks again (a Better Auth session read and the access check,
// each a database round trip). Keyed on the request's own headers object, which `headers()` hands back for the whole request.
const perRequest = new WeakMap<object, Promise<unknown>>();

/** `load(h)` once per request headers object; a failed load isn't kept. Exported for tests. */
export function onceForRequest<T>(h: Headers, load: (h: Headers) => Promise<T>): Promise<T> {
  let found = perRequest.get(h) as Promise<T> | undefined;
  if (!found) {
    found = load(h);
    perRequest.set(h, found);
    found.catch(() => perRequest.delete(h));
  }
  return found;
}

/** Where someone with no usable session goes: /login, saying why when the access list refused a live session. */
export function signInPath(lookup: SessionLookup): string {
  return lookup.refused ? `/login?error=${ACCESS_DENIED_CODE}` : "/login";
}

/**
 * A database handle that runs every query as the signed-in user, under RLS: the data access layer of every signed-in page,
 * action and route. With nobody signed in it redirects to /login instead. The proxy only checks that a session cookie is
 * there, so an expired session, or one whose owner was taken off the access list, reaches the page; querying as `anon`
 * there fails (anon may read no table) and showed an error page. Pages open to signed-out visitors use `getVisitorDb()`.
 */
export async function getDb(): Promise<ReturnType<typeof createDb>> {
  const lookup = await lookupSession();
  // Demo mode has no database: appPool() throws, as it always did.
  if (!lookup.user && authEnv()) redirect(signInPath(lookup));
  return createDb(appPool(), claimsFor(lookup.user));
}

/**
 * For the few places open to signed-out visitors (a share link's page and its Send action, a workspace's logo): a handle as
 * the signed-in user, or as `anon` when there is none. They read only through SECURITY DEFINER functions anon may call.
 */
export async function getVisitorDb(): Promise<ReturnType<typeof createDb>> {
  return createDb(appPool(), claimsFor(await getSessionUser()));
}
