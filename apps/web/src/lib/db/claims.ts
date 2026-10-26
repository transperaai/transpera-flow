import type { Claims } from "@transpera-flow/db/client";

/** The signed-in user, as `getSessionUser()` returns it. */
export interface ClaimsUser {
  id: string;
  email: string;
  agencyAdmin: boolean;
}

/**
 * The only place JWT claims are built: what `auth.jwt()` and `auth.uid()` see inside a query. Supabase-shaped, so the
 * existing RLS policies and SECURITY DEFINER functions work unchanged. Signed out is `null` (role `anon`). The MCP route adds
 * `api_token_id` (step 3b).
 */
export function claimsFor(user: ClaimsUser | null, extra: { apiTokenId?: string } = {}): Claims | null {
  if (!user) return null;
  return {
    sub: user.id,
    role: "authenticated",
    email: user.email,
    app_metadata: { agency_admin: user.agencyAdmin },
    ...(extra.apiTokenId ? { api_token_id: extra.apiTokenId } : {}),
  };
}
