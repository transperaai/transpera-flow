// Deployment access at sign-in (docs/plans/supabase-exit-brief.md, step 2). The rules live in SQL (`private.deployment_role`,
// `private.sync_deployment_access`, migration 20261228000000); this file only calls them. They run on Better Auth's owner pool,
// never as a signed-in user.

export type DeploymentRole = "admin" | "editor" | "viewer";
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
 * Once per sign-in: decides the role again, and in one transaction records the provider identities, sets the agency-admin flag,
 * and (not for a guest) runs the workspace lists and raises every workspace to at least editor/viewer. Returns null, changing
 * nothing, when the user may no longer sign in.
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
