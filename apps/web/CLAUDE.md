# apps/web

Next.js app. Sign-in is Better Auth with Google (`/api/auth/*`, `src/lib/auth`), stored in the `better_auth` schema of the deployment's
Neon database. Queries run through Kysely and a `pg` pool as `anon` or `authenticated` with the user's claims, so row-level
security decides what each request sees (`src/lib/db/pool.ts`, `src/lib/db/claims.ts`, `getDb()` in `src/lib/auth/session.ts`).

Environment (see `.env.example`): `DATABASE_URL` (the owner: Better Auth, migrations, sign-in access), `APP_DATABASE_URL` (the
`authenticator` login the app's queries use; falls back to `DATABASE_URL`), `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`,
`OAUTH_PROXY_SECRET`, `PREVIEW_ALIAS_URL`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `AUTH_PROVIDERS`, `ACCESS_ADMIN_EMAILS`. Without `DATABASE_URL` and
`BETTER_AUTH_SECRET` the app runs in demo mode (`/demo`).

@AGENTS.md
