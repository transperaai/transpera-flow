import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { proxy } from "@/proxy";
import {
  ACCESS_DENIED_CODE,
  idTokenClaims,
  loadIdentities,
  signInRole,
  syncSignIn,
  type Queryable,
} from "@/lib/auth/access";
import { authEnv, parseEmails, parseProviders } from "@/lib/auth/env";
import { incomingRequest, PREVIEW_ALIAS, socialProviders, trustedOrigins } from "@/lib/auth/providers";
import { claimsFor } from "@/lib/db/claims";
import { deploymentErrorMessage, normalizeRuleValue } from "@/lib/deployment-rules";
import { createTestDb, type TestDb } from "../../../packages/db/test/harness";

// Sign-in plumbing for the move off Supabase (docs/plans/supabase-exit-brief.md, step 2): the proxy's cookie check, the
// per-deployment settings, and the access functions the Better Auth hooks call, run against a real database. Better Auth's own
// OAuth flow is not unit-tested; it is checked live.

const SETTINGS = { DATABASE_URL: "postgres://x/y", BETTER_AUTH_SECRET: "s".repeat(32) };

afterEach(() => vi.unstubAllEnvs());

function stubAuthEnv(on: boolean) {
  for (const [k, v] of Object.entries(SETTINGS)) vi.stubEnv(k, on ? v : "");
}

const visit = (path: string, cookie?: string) =>
  proxy(new NextRequest(`https://app.example.com${path}`, { headers: cookie ? { cookie } : {} }));
const location = (res: Response) => res.headers.get("location");
const passes = (res: Response) => res.headers.get("x-middleware-next") === "1";

describe("proxy", () => {
  it("sends a visitor with no session cookie to /login", () => {
    stubAuthEnv(true);
    for (const path of ["/", "/w/northbeam", "/w/northbeam/settings/access?x=1", "/api/narrate"]) {
      const res = visit(path);
      expect(res.status, path).toBe(307);
      expect(location(res), path).toBe("https://app.example.com/login");
    }
  });

  it("lets a request with a session cookie through", () => {
    stubAuthEnv(true);
    expect(passes(visit("/w/northbeam", "better-auth.session_token=abc.def"))).toBe(true);
    expect(passes(visit("/w/northbeam", "__Secure-better-auth.session_token=abc.def"))).toBe(true);
  });

  it("does not take another cookie for a session", () => {
    stubAuthEnv(true);
    expect(visit("/", "sb-access-token=abc; theme=dark").status).toBe(307);
  });

  it("keeps the public paths, Better Auth, and the MCP bypass open", () => {
    stubAuthEnv(true);
    for (const path of ["/login", "/demo", "/privacy", "/auth/signout", "/api/auth/sign-in/social", "/api/auth/callback/google", "/api/mcp", "/s/abc"]) {
      expect(passes(visit(path)), path).toBe(true);
    }
  });

  it("does not open a look-alike of a public path", () => {
    stubAuthEnv(true);
    for (const path of ["/loginx", "/api/authx", "/sx", "/api/mcp/extra"]) expect(visit(path).status, path).toBe(307);
  });

  it("guards nothing in demo mode (no sign-in settings)", () => {
    stubAuthEnv(false);
    expect(passes(visit("/w/northbeam"))).toBe(true);
    expect(passes(visit("/"))).toBe(true);
  });
});

describe("sign-in settings", () => {
  it("is configured only with a database and a secret", () => {
    expect(authEnv({})).toBeNull();
    expect(authEnv({ DATABASE_URL: "postgres://x/y" })).toBeNull();
    expect(authEnv({ BETTER_AUTH_SECRET: "s" })).toBeNull();
    expect(authEnv({ ...SETTINGS, BETTER_AUTH_URL: " https://a.example ", ACCESS_ADMIN_EMAILS: "A@x.io, b@y.io ," })).toMatchObject({
      baseUrl: "https://a.example",
      adminEmails: ["a@x.io", "b@y.io"],
      providers: ["google"],
    });
  });

  it("defaults to Google and reads AUTH_PROVIDERS", () => {
    expect(parseProviders(undefined)).toEqual(["google"]);
    expect(parseProviders("")).toEqual(["google"]);
    expect(parseProviders("google,microsoft")).toEqual(["google", "microsoft"]);
    expect(parseProviders(" Microsoft , GOOGLE ")).toEqual(["google", "microsoft"]);
    expect(parseProviders("microsoft")).toEqual(["microsoft"]);
    expect(parseProviders("github")).toEqual(["google"]);
    expect(parseEmails(undefined)).toEqual([]);
  });

  it("wires Google with the openid scope and an account chooser, and no hosted-domain restriction", () => {
    const { google, microsoft } = socialProviders({ GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "secret" }, ["google"]);
    expect(microsoft).toBeUndefined();
    expect(google).toMatchObject({ clientId: "id", clientSecret: "secret", prompt: "select_account" });
    expect(google?.scope).toEqual(["openid", "email", "profile"]);
    expect(google).not.toHaveProperty("hd");
  });

  it("wires Microsoft with the client's tenant, and refuses to run without one", () => {
    const env = { MICROSOFT_CLIENT_ID: "mid", MICROSOFT_CLIENT_SECRET: "msecret", MICROSOFT_TENANT_ID: "tenant-1" };
    const { google, microsoft } = socialProviders(env, ["microsoft"]);
    expect(google).toBeUndefined();
    expect(microsoft).toMatchObject({ clientId: "mid", clientSecret: "msecret", tenantId: "tenant-1" });
    expect(socialProviders(env, ["google", "microsoft"]).google).toBeDefined();
    expect(() => socialProviders({ MICROSOFT_CLIENT_ID: "mid" }, ["microsoft"])).toThrow(/MICROSOFT_TENANT_ID/);
  });

  it("trusts its own URL, the preview alias and this deployment's Vercel URLs, and no wildcard", () => {
    expect(trustedOrigins("https://transpera-flow.vercel.app", {})).toEqual(["https://transpera-flow.vercel.app", PREVIEW_ALIAS]);
    expect(PREVIEW_ALIAS).toBe("https://transpera-flow-next.vercel.app");
    expect(trustedOrigins(undefined, {})).toEqual([PREVIEW_ALIAS]);
    expect(
      trustedOrigins(PREVIEW_ALIAS, { VERCEL_URL: "transpera-flow-abc-team.vercel.app", VERCEL_BRANCH_URL: "transpera-flow-git-x-team.vercel.app" }),
    ).toEqual([PREVIEW_ALIAS, "https://transpera-flow-abc-team.vercel.app", "https://transpera-flow-git-x-team.vercel.app"]);
    expect(trustedOrigins(undefined, { VERCEL_URL: "evil.io/x" })).toEqual([PREVIEW_ALIAS]);
  });

  it("rebuilds the incoming request for a direct auth.api call", () => {
    const req = incomingRequest(
      new Headers({ host: "internal", "x-forwarded-host": "a.example", "x-forwarded-proto": "https", cookie: "c=1", "content-length": "9" }),
      "/api/auth/sign-in/social",
    );
    expect(req.url).toBe("https://a.example/api/auth/sign-in/social");
    expect(req.headers.get("cookie")).toBe("c=1");
    expect(req.headers.get("content-length")).toBeNull();
  });

});

describe("claims", () => {
  const user = { id: "u-1", email: "a@x.io", agencyAdmin: true };
  it("marks a guest, who is never an agency admin", () => {
    expect(claimsFor({ ...user, guest: true })?.app_metadata).toEqual({ agency_admin: false, guest: true });
  });
  it("builds the Supabase-shaped claims, and null when signed out", () => {
    expect(claimsFor(user)).toEqual({ sub: "u-1", role: "authenticated", email: "a@x.io", app_metadata: { agency_admin: true } });
    expect(claimsFor({ ...user, agencyAdmin: false })?.app_metadata).toEqual({ agency_admin: false });
    expect(claimsFor(null)).toBeNull();
  });
  it("adds the MCP token id when there is one", () => {
    expect(claimsFor(user, { apiTokenId: "t-1" })).toMatchObject({ api_token_id: "t-1" });
    expect(claimsFor(user)).not.toHaveProperty("api_token_id");
  });
});

describe("deployment list helpers", () => {
  it("tidies a domain or email before it is stored", () => {
    expect(normalizeRuleValue("domain", " https://www.Client.com/path ")).toBe("client.com");
    expect(normalizeRuleValue("domain", "maya@Client.com")).toBe("client.com");
    expect(normalizeRuleValue("email", "  Maya@Client.COM ")).toBe("maya@client.com");
  });
  it("turns the database's refusals into sentences", () => {
    expect(deploymentErrorMessage({ code: "23505", message: 'duplicate key value violates unique constraint "deployment_access_kind_value_key"' })).toBe(
      "That is already on the list.",
    );
    expect(deploymentErrorMessage({ code: "23514", message: 'violates check constraint "deployment_access_value_format"' })).toMatch(/free email providers/);
    expect(deploymentErrorMessage({ code: "42501", message: "permission denied for table deployment_access" })).toMatch(/agency admins/);
  });
});

describe("id token claims", () => {
  const token = (payload: unknown) => `h.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.s`;
  it("reads the payload", () => {
    expect(idTokenClaims(token({ hd: "client.com", email: "a@client.com" }))).toEqual({ hd: "client.com", email: "a@client.com" });
  });
  it("returns nothing for a missing or malformed token", () => {
    for (const bad of [null, undefined, "", "abc", "a.b", "a.!!!.c", `h.${Buffer.from("[1]").toString("base64url")}.s`]) {
      expect(idTokenClaims(bad as string | null), String(bad)).toEqual(idTokenClaims(undefined));
    }
  });
});

describe("the access functions the Better Auth hooks call", () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await createTestDb();
    await db.client.query(`insert into deployment_access (kind, value, role) values ('domain', 'client.com', 'viewer'), ('email', 'lead@client.com', 'editor')`);
  });
  afterAll(async () => {
    await db?.close();
  });
  const q = (): Queryable => db.client;

  async function signUp(email: string, accounts: { providerId: string; accountId: string; idToken?: string }[] = []) {
    const id = randomUUID();
    await db.client.query(`insert into better_auth."user" (id, name, email, "emailVerified") values ($1, 'P', $2, true)`, [id, email]);
    for (const a of accounts) {
      await db.client.query(
        `insert into better_auth.account ("accountId", "providerId", "userId", "idToken", "updatedAt") values ($1, $2, $3, $4, now())`,
        [a.accountId, a.providerId, id, a.idToken ?? null],
      );
    }
    return id;
  }
  const jwt = (payload: unknown) => `h.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.s`;

  it("decides a role before the user exists (the user-create hook)", async () => {
    expect(await signInRole(q(), "someone@client.com", true, [])).toBe("viewer");
    expect(await signInRole(q(), "lead@client.com", true, [])).toBe("editor");
    expect(await signInRole(q(), "stranger@else.org", true, [])).toBeNull();
    expect(await signInRole(q(), "someone@client.com", false, [])).toBeNull();
    expect(await signInRole(q(), "", true, [])).toBeNull();
    expect(await signInRole(q(), undefined, true, [])).toBeNull();
    expect(await signInRole(q(), "boot@else.org", true, ["boot@else.org"])).toBe("admin");
  });

  it("refuses an unknown email at sign-in and changes nothing (the session-create hook)", async () => {
    const id = await signUp("stranger@else.org");
    expect(await syncSignIn(q(), id, [], await loadIdentities(q(), id))).toBeNull();
    expect((await db.client.query("select 1 from memberships where user_id = $1", [id])).rowCount).toBe(0);
    expect(ACCESS_DENIED_CODE).toBe("not_on_access_list");
  });

  it("applies the role and records Google's hosted domain from the stored ID token", async () => {
    const id = await signUp("maya@client.com", [
      { providerId: "google", accountId: "g-1", idToken: jwt({ email: "maya@client.com", hd: "client.com" }) },
      { providerId: "credential", accountId: "ignored" },
    ]);
    const identities = await loadIdentities(q(), id);
    expect(identities).toEqual([{ provider: "google", provider_id: "g-1", email: "maya@client.com", hd: "client.com" }]);
    expect(await syncSignIn(q(), id, [], identities)).toBe("viewer");
    const { rows } = await db.client.query("select identity_data from auth.identities where user_id = $1", [id]);
    expect(rows[0].identity_data.custom_claims).toEqual({ hd: "client.com" });
    expect(Number((await db.client.query("select count(*) from memberships where user_id = $1", [id])).rows[0].count)).toBeGreaterThan(0);
  });

  it("records a Microsoft tenant, and a personal Google account with no hosted domain", async () => {
    const id = await signUp("lead@client.com", [
      { providerId: "microsoft", accountId: "m-1", idToken: jwt({ tid: "tenant-1" }) },
      { providerId: "google", accountId: "g-2", idToken: jwt({ email: "lead@client.com" }) },
    ]);
    expect(await syncSignIn(q(), id, [], await loadIdentities(q(), id))).toBe("editor");
    const { rows } = await db.client.query("select provider, identity_data from auth.identities where user_id = $1 order by provider", [id]);
    expect(rows.map((r) => [r.provider, r.identity_data.custom_claims])).toEqual([
      ["google", undefined],
      ["microsoft", { tid: "tenant-1" }],
    ]);
  });
});
