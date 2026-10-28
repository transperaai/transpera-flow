// Deployment access at sign-in (docs/plans/supabase-exit-brief.md, step 2). The rules live in SQL (`private.deployment_role`,
// `private.sync_deployment_access`, migrations 20261228000000 and 20270103000000); this file only calls them. They run on Better
// Auth's owner pool, never as a signed-in user.
//
// Three roles (docs/plans/cut-list.md item 9): `owner` (Austin: the agency-admin flag in the JWT, `agencyAdmin` in code), `agency_admin`
// (the client's founder and head of CS: an `owner` membership in every workspace) and `viewer`.

export type DeploymentRole = "owner" | "agency_admin" | "viewer";
/** A deployment role, or `guest`: an outsider listed on a live restricted share link, with no role anywhere (B3). */
export type SignInRole = DeploymentRole | "guest";

/** What the login page shows when nothing on the access list matches. */
export const ACCESS_DENIED_CODE = "not_on_access_list";
export const ACCESS_DENIED_MESSAGE = "Your account isn't on this workspace's access list";

export interface Queryable {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

/** A provider account's claims worth keeping in `auth.identities`. */
export interface IdentityInput {
  provider: "google" | "microsoft";
  provider_id: string;
  email?: string;
  /** Google's hosted-domain claim (absent for personal accounts). */
  hd?: string;
  /** Microsoft's tenant id. */
  tid?: string;
}

/** The role an address signs in with (`guest` included), or null when it may not sign in. Used before the user exists. */
export async function signInRole(
  db: Queryable,
  email: string | null | undefined,
  emailVerified: boolean,
  adminEmails: string[],
): Promise<SignInRole | null> {
  if (!email) return null;
  const { rows } = await db.query("select private.may_sign_in($1, $2, $3::text[]) as role", [email, emailVerified, adminEmails]);
  return (rows[0]?.role as SignInRole | null) ?? null;
}

/**
 * Once per sign-in: decides the role again, and in one transaction records the provider identities, sets the Owner flag, and (not
 * for a guest) makes the user's membership in every workspace match the list: an Agency admin's or a Viewer's, raised or lowered.
 * Returns null, changing nothing, when the user may no longer sign in.
 */
export async function syncSignIn(
  db: Queryable,
  userId: string,
  adminEmails: string[],
  identities: IdentityInput[],
): Promise<SignInRole | null> {
  const { rows } = await db.query("select private.sync_deployment_access($1, $2::text[], $3::jsonb) as role", [
    userId,
    adminEmails,
    JSON.stringify(identities),
  ]);
  return (rows[0]?.role as SignInRole | null) ?? null;
}

/**
 * The claims in a JWT's payload. The signature isn't checked again: Better Auth stored the token from its own TLS code exchange
 * with the provider (or verified it on an id-token sign-in), so `hd` and `tid` are the provider's.
 */
export function idTokenClaims(idToken: string | null | undefined): Record<string, unknown> {
  const payload = idToken?.split(".")[1];
  if (!payload) return {};
  try {
    const parsed: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Reads the user's Google and Microsoft accounts and turns their stored ID tokens into identities. */
export async function loadIdentities(db: Queryable, userId: string): Promise<IdentityInput[]> {
  const { rows } = await db.query(
    `select "providerId", "accountId", "idToken" from better_auth.account
     where "userId" = $1 and "providerId" in ('google', 'microsoft')`,
    [userId],
  );
  return rows.map((r) => {
    const claims = idTokenClaims(r.idToken as string | null);
    const provider = r.providerId as IdentityInput["provider"];
    const text = (v: unknown) => (typeof v === "string" && v !== "" ? v : undefined);
    return {
      provider,
      provider_id: String(r.accountId),
      email: text(claims.email),
      ...(provider === "google" ? { hd: text(claims.hd) } : { tid: text(claims.tid) }),
    };
  });
}

/** Who a signed-in user is now, by the deployment's list: what the web session and an MCP token both act as. */
export interface CurrentAccess {
  email: string;
  /** The Owner. Counts only while the list still says owner, so a demotion takes effect at the next request. */
  agencyAdmin: boolean;
  /** Signed in only for a restricted share link (B3): no role anywhere. */
  guest: boolean;
}

/**
 * The user's access as of now, or null when they may no longer sign in (taken off the list, or unknown). Checked on every web
 * request (`getSessionUser`) and every MCP request, so removing someone from the list ends their session and their API tokens
 * at the next request, and the Owner flag `auth.users` keeps from the last sign-in is honoured only while they are
 * still an Owner. Runs on the owner pool: `private.may_sign_in` isn't executable by anon or authenticated.
 */
export async function currentAccess(db: Queryable, userId: string, adminEmails: string[]): Promise<CurrentAccess | null> {
  const { rows } = await db.query(
    `select u.email,
            coalesce((u.raw_app_meta_data ->> 'agency_admin')::boolean, false) as agency_admin,
            private.may_sign_in(u.email, u.email_confirmed_at is not null, $2::text[]) as role
     from auth.users u where u.id = $1`,
    [userId, adminEmails],
  );
  const row = rows[0];
  if (!row || !row.role) return null;
  return { email: String(row.email), agencyAdmin: row.agency_admin === true && row.role === "owner", guest: row.role === "guest" };
}
