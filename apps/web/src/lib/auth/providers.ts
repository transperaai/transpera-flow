import type { ProviderId } from "./env";

// Preview deployments sign in through the stable alias (oAuthProxy), so both it and per-commit preview URLs are trusted origins.
export const PREVIEW_ALIAS = "https://transpera-flow-next.vercel.app";
export const PREVIEW_ORIGINS = [PREVIEW_ALIAS, "https://transpera-flow-*.vercel.app"];

/** Origins Better Auth accepts for callback URLs and requests, besides its own base URL. */
export function trustedOrigins(baseUrl: string | undefined): string[] {
  return [...(baseUrl ? [baseUrl] : []), ...PREVIEW_ORIGINS];
}

/**
 * The providers a deployment enables (`AUTH_PROVIDERS`). Google asks for `openid email profile` (openid makes it return the ID
 * token that carries the hosted-domain claim). It deliberately sets no `hd`: that would refuse personal Google accounts, and
 * the access list may name them. Microsoft's tenant id restricts sign-in to the client's tenant.
 */
export function socialProviders(env: Record<string, string | undefined>, enabled: ProviderId[]) {
  const providers: {
    google?: { clientId: string; clientSecret: string; scope: string[]; prompt: "select_account" };
    microsoft?: { clientId: string; clientSecret: string; tenantId: string; scope: string[]; prompt: "select_account" };
  } = {};
  if (enabled.includes("google")) {
    providers.google = {
      clientId: env.GOOGLE_CLIENT_ID ?? "",
      clientSecret: env.GOOGLE_CLIENT_SECRET ?? "",
      scope: ["openid", "email", "profile"],
      prompt: "select_account",
    };
  }
  if (enabled.includes("microsoft")) {
    // No default tenant: "common" would let any Microsoft account reach the access check.
    if (!env.MICROSOFT_TENANT_ID) throw new Error("AUTH_PROVIDERS includes microsoft, so MICROSOFT_TENANT_ID must be set");
    providers.microsoft = {
      clientId: env.MICROSOFT_CLIENT_ID ?? "",
      clientSecret: env.MICROSOFT_CLIENT_SECRET ?? "",
      tenantId: env.MICROSOFT_TENANT_ID,
      scope: ["openid", "email", "profile"],
      prompt: "select_account",
    };
  }
  return providers;
}
