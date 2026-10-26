import type { ProviderId } from "./env";

// Preview deployments sign in through the stable alias (oAuthProxy).
export const PREVIEW_ALIAS = "https://transpera-flow-next.vercel.app";

/**
 * Origins Better Auth accepts for callback URLs, Origin headers and the oAuthProxy's return leg: its own base URL, the preview
 * alias, and this deployment's own Vercel URLs (per-commit and branch). Not a `transpera-flow-*.vercel.app` wildcard: anyone
 * can name a Vercel project `transpera-flow-<anything>`, which would make every such site a trusted redirect target.
 */
export function trustedOrigins(baseUrl: string | undefined, env: Record<string, string | undefined> = process.env): string[] {
  const own = [env.VERCEL_URL, env.VERCEL_BRANCH_URL]
    .map((host) => host?.trim())
    .filter((host): host is string => !!host && /^[a-z0-9.-]+$/i.test(host))
    .map((host) => `https://${host}`);
  return [...new Set([...(baseUrl ? [baseUrl] : []), PREVIEW_ALIAS, ...own])];
}

/**
 * The incoming request, rebuilt for a direct `auth.api` call. The oAuthProxy decides from the request's URL whether this
 * deployment is the one Google knows (then no proxy) and where to come back to (a trusted origin only). Without a request it
 * falls back to VERCEL_URL, the per-commit URL, so someone who started on the alias or the production domain would end up
 * signed in on the per-commit URL instead.
 */
export function incomingRequest(headers: Headers, path: string): Request {
  const host = headers.get("x-forwarded-host") ?? headers.get("host") ?? "localhost";
  const proto = headers.get("x-forwarded-proto")?.split(",")[0]?.trim() || "https";
  const forwarded = new Headers(headers);
  for (const name of ["content-length", "content-type", "transfer-encoding"]) forwarded.delete(name);
  return new Request(new URL(path, `${proto}://${host}`), { method: "POST", headers: forwarded });
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
