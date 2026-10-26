// Sign-in settings, read from the environment at request time. All of it is per deployment (docs/plans/supabase-exit-brief.md, step 2).

export type ProviderId = "google" | "microsoft";

export interface AuthEnv {
  databaseUrl: string;
  secret: string;
  /** The deployment's own URL; a preview deployment sets the stable alias here and signs in through it (oAuthProxy). */
  baseUrl: string | undefined;
  oauthProxySecret: string | undefined;
  providers: ProviderId[];
  /** `ACCESS_ADMIN_EMAILS`: addresses that count as named-email `admin` rules, so a new deployment's first admin can sign in. */
  adminEmails: string[];
}

/** Better Auth is configured when it has a database and a secret. Otherwise the app runs in demo mode, as before. */
export function authEnv(env: Record<string, string | undefined> = process.env): AuthEnv | null {
  const databaseUrl = env.DATABASE_URL?.trim();
  const secret = env.BETTER_AUTH_SECRET?.trim();
  if (!databaseUrl || !secret) return null;
  return {
    databaseUrl,
    secret,
    baseUrl: env.BETTER_AUTH_URL?.trim() || undefined,
    oauthProxySecret: env.OAUTH_PROXY_SECRET?.trim() || undefined,
    providers: parseProviders(env.AUTH_PROVIDERS),
    adminEmails: parseEmails(env.ACCESS_ADMIN_EMAILS),
  };
}

/** `AUTH_PROVIDERS` is a comma-separated list; unset or empty means Google. Unknown names are ignored. */
export function parseProviders(value: string | undefined): ProviderId[] {
  const wanted = (value ?? "").split(",").map((p) => p.trim().toLowerCase());
  const known = (["google", "microsoft"] as const).filter((p) => wanted.includes(p));
  return known.length > 0 ? known : ["google"];
}

/** Comma-separated addresses, trimmed and lower-cased. */
export function parseEmails(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e !== "");
}

export const PROVIDER_LABELS: Record<ProviderId, string> = { google: "Google", microsoft: "Microsoft" };
