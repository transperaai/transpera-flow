import "server-only";
import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { nextCookies } from "better-auth/next-js";
import { oAuthProxy } from "better-auth/plugins";
import { PostgresDialect } from "kysely";
import { authPool } from "@/lib/db/pool";
import { ACCESS_DENIED_CODE, ACCESS_DENIED_MESSAGE, loadIdentities, signInRole, syncSignIn } from "./access";
import { authEnv, type AuthEnv } from "./env";
import { socialProviders, trustedOrigins } from "./providers";

// The Better Auth instance (docs/plans/supabase-exit-brief.md, step 2). Users live in schema `better_auth` of the deployment's
// own database; a trigger mirrors each into `auth.users`, so the foreign keys and RLS written against `auth.users` keep working.

const denied = () => new APIError("FORBIDDEN", { code: ACCESS_DENIED_CODE, message: ACCESS_DENIED_MESSAGE });

function createAuth(env: AuthEnv) {
  const pool = authPool();
  return betterAuth({
    appName: "Transpera Flow",
    secret: env.secret,
    baseURL: env.baseUrl,
    // A bare Pool can't take `schemaName`; going through the dialect can. No search_path startup option: Neon's pooled
    // connections reject it.
    database: { dialect: new PostgresDialect({ pool }), type: "postgres", schemaName: "better_auth", transaction: true },
    advanced: { database: { generateId: "uuid" } },
    trustedOrigins: trustedOrigins(env.baseUrl),
    // Failures in the OAuth callback come back to the login page as ?error=<code>&error_description=<text>.
    onAPIError: { errorURL: "/login" },
    socialProviders: socialProviders(process.env, env.providers),
    databaseHooks: {
      user: {
        create: {
          // A first sign-in is refused unless the address is on the access list . Nothing is written.
          before: async (user) => {
            const role = await signInRole(pool, user.email, user.emailVerified === true, env.adminEmails);
            if (!role) throw denied();
          },
        },
      },
      session: {
        create: {
          // Every sign-in, new or returning: re-check access (it may have been removed), then apply it.
          before: async (session) => {
            const identities = await loadIdentities(pool, session.userId);
            const role = await syncSignIn(pool, session.userId, env.adminEmails, identities);
            if (!role) throw denied();
          },
        },
      },
    },
    plugins: [
      // Preview deployments sign in through the stable alias in BETTER_AUTH_URL, the only origin Google knows.
      ...(env.baseUrl ? [oAuthProxy({ productionURL: env.baseUrl, secret: env.oauthProxySecret })] : []),
      nextCookies(), // last
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;

const globalAuth = globalThis as unknown as { __tfAuth?: Auth };

/** The Better Auth instance. Throws when the deployment isn't configured (demo mode never gets here). */
export function getAuth(): Auth {
  const env = authEnv();
  if (!env) throw new Error("Sign-in is not configured");
  return (globalAuth.__tfAuth ??= createAuth(env));
}
