// Sign-in settings, read from the environment at request time. All of it is per deployment (docs/plans/supabase-exit-brief.md, step 2).

export type ProviderId = "google" | "microsoft";

export interface AuthEnv {
  /** `DATABASE_URL`: the owner. Better Auth and the sign-in access functions use it; nothing else should. */
  databaseUrl: string;
  /**
   * `APP_DATABASE_URL`, the `authenticator` login (packages/db/scripts/create-app-login.sql). The app's queries use it. Outside
   * production it falls back to `databaseUrl` when unset; in production it must be set and differ from `DATABASE_URL`.
   */
  appDatabaseUrl: string;
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
    appDatabaseUrl: appDatabaseUrl(env, databaseUrl),
    secret,
    baseUrl: env.BETTER_AUTH_URL?.trim() || undefined,
    oauthProxySecret: env.OAUTH_PROXY_SECRET?.trim() || undefined,
    providers: parseProviders(env.AUTH_PROVIDERS),
    adminEmails: parseEmails(env.ACCESS_ADMIN_EMAILS),
  };
}

/** A production deployment: `next build`/`next start` (NODE_ENV) or Vercel's Production environment. */
export function isProduction(env: Record<string, string | undefined>): boolean {
  return env.NODE_ENV === "production" || env.VERCEL_ENV === "production";
}

/**
 * The login the app's queries use. In production it must be the `authenticator` login, never the owner: the owner bypasses
 * row-level security, so a missing `APP_DATABASE_URL` would leave the driver's claims as the only guard (ADR 0019). Locally and in
 * tests it falls back to `DATABASE_URL`.
 */
function appDatabaseUrl(env: Record<string, string | undefined>, databaseUrl: string): string {
  const app = env.APP_DATABASE_URL?.trim();
  if (isProduction(env)) {
    if (!app) {
      throw new Error("APP_DATABASE_URL is not set. In production the app's queries must use the authenticator login (packages/db/scripts/create-app-login.sql), not the DATABASE_URL owner.");
    }
    if (app === databaseUrl) {
      throw new Error("APP_DATABASE_URL is the same as DATABASE_URL. In production it must be the authenticator login (packages/db/scripts/create-app-login.sql), not the owner.");
    }
  }
  return app || databaseUrl;
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
