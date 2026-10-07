/** The Sentry DSN, or null: with no DSN, nothing is initialised or sent (issue #44). */
export function sentryDsn(): string | null {
  // Read literally, so Next inlines it in the browser bundle.
  const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;
  return dsn && dsn.trim() ? dsn.trim() : null;
}

/** Source maps are made and uploaded only with all three build variables. */
export function sourceMapsConfigured(): boolean {
  return Boolean(process.env.SENTRY_AUTH_TOKEN?.trim() && process.env.SENTRY_ORG?.trim() && process.env.SENTRY_PROJECT?.trim());
}

/** "production" | "preview" | "development", from NEXT_PUBLIC_VERCEL_ENV (Vercel exposes it), else NODE_ENV. */
export function sentryEnvironment(): string {
  const vercel = process.env.NEXT_PUBLIC_VERCEL_ENV;
  if (vercel === "production" || vercel === "preview" || vercel === "development") return vercel;
  return process.env.NODE_ENV === "production" ? "production" : "development";
}
