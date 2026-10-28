import type { Claims } from "@transpera-flow/db/client";

/** The signed-in user, as `getSessionUser()` returns it. */
export interface ClaimsUser {
  id: string;
  email: string;
  agencyAdmin: boolean;
  /** Signed in only for a restricted share link (B3): no role anywhere. */
  guest?: boolean;
}

/**
 * The only place JWT claims are built: what `auth.jwt()` and `auth.uid()` see inside a query. They keep the shape (`sub`, `role`,
 * `email`, `app_metadata`) the RLS policies and SECURITY DEFINER functions were written against, so those work unchanged. A guest is never an agency admin. Signed out is `null` (role `anon`). The MCP route adds
 * `api_token_id` (step 3b).
 */
export function claimsFor(user: ClaimsUser | null, extra: { apiTokenId?: string } = {}): Claims | null {
  if (!user) return null;
  return {
    sub: user.id,
    role: "authenticated",
    email: user.email,
    // `guest` makes workspace_role, my_person_id and is_sign_in_admin answer nothing, whatever memberships remain (20270105000000).
    app_metadata: { agency_admin: user.agencyAdmin && !user.guest, ...(user.guest ? { guest: true } : {}) },
    ...(extra.apiTokenId ? { api_token_id: extra.apiTokenId } : {}),
  };
}
