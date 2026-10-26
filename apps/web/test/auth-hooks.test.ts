import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "../../../packages/db/test/harness";

vi.mock("server-only", () => ({}));

// The real Better Auth instance (src/lib/auth/server.ts) on a throwaway database, driven through its internal adapter instead of
// Google: creating a user and a session runs the same databaseHooks a sign-in does. Checks that the instance builds with the
// Kysely adapter on schema better_auth with uuid ids, that an unlisted address is refused (new user, and a returning user whose
// access was removed), and that a listed one is mirrored into auth.users and given its role. The OAuth redirect itself is checked live.

let db: TestDb;
let ctx: unknown;

beforeAll(async () => {
  db = await createTestDb();
  vi.stubEnv("DATABASE_URL", db.url);
  vi.stubEnv("BETTER_AUTH_SECRET", "a-long-random-secret-for-tests-0123456789");
  vi.stubEnv("BETTER_AUTH_URL", "https://transpera-flow-next.vercel.app");
  vi.stubEnv("OAUTH_PROXY_SECRET", "proxy-secret-for-tests-0123456789");
  vi.stubEnv("GOOGLE_CLIENT_ID", "client-id");
  vi.stubEnv("GOOGLE_CLIENT_SECRET", "client-secret");
  vi.stubEnv("ACCESS_ADMIN_EMAILS", "first@brand-new.io");
  vi.stubEnv("VERCEL_URL", "transpera-flow-abc123-team.vercel.app");
  vi.stubEnv("VERCEL_BRANCH_URL", "");
  await db.client.query(`insert into deployment_access (kind, value, role) values ('domain', 'client.com', 'viewer'), ('email', 'lead@client.com', 'editor')`);
  const { getAuth } = await import("@/lib/auth/server");
  ctx = await getAuth().$context;
});

afterAll(async () => {
  const pool = (globalThis as unknown as { __tfAuthPool?: { end(): Promise<void> } }).__tfAuthPool;
  await pool?.end();
  vi.unstubAllEnvs();
  await db?.close();
});

const adapter = () => (ctx as { internalAdapter: any }).internalAdapter; // eslint-disable-line @typescript-eslint/no-explicit-any
const newUser = (email: string, emailVerified = true) => adapter().createUser({ email, name: "Test Person", emailVerified });
const mirrored = async (email: string) => (await db.client.query("select id from auth.users where email = $1", [email])).rowCount;

describe("Better Auth hooks", () => {
  it("creates a listed user in schema better_auth with a uuid id, and mirrors them into auth.users", async () => {
    const user = await newUser("maya@client.com");
    expect(user.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect((await db.client.query(`select email from better_auth."user" where id = $1`, [user.id])).rows).toEqual([{ email: "maya@client.com" }]);
    expect(await mirrored("maya@client.com")).toBe(1);
  });

  it("refuses to create a user whose address is on no list, and writes nothing", async () => {
    await expect(newUser("stranger@elsewhere.org")).rejects.toMatchObject({ body: { code: "not_on_access_list" } });
    expect((await db.client.query(`select 1 from better_auth."user" where email = 'stranger@elsewhere.org'`)).rowCount).toBe(0);
    expect(await mirrored("stranger@elsewhere.org")).toBe(0);
  });

  it("refuses an unverified address, even on a listed domain", async () => {
    await expect(newUser("unverified@client.com", false)).rejects.toMatchObject({ body: { code: "not_on_access_list" } });
  });

  it("lets a bootstrap admin in and flags them as an agency admin when the session is created", async () => {
    const user = await newUser("first@brand-new.io");
    await adapter().createSession(user.id);
    const { rows } = await db.client.query("select raw_app_meta_data -> 'agency_admin' as f from auth.users where id = $1", [user.id]);
    expect(rows[0].f).toBe(true);
  });

  it("applies the role when a session is created: an editor joins every workspace", async () => {
    const user = await newUser("lead@client.com");
    const session = await adapter().createSession(user.id);
    expect(session.userId).toBe(user.id);
    const roles = (await db.client.query("select distinct role from memberships where user_id = $1", [user.id])).rows;
    expect(roles).toEqual([{ role: "editor" }]);
  });

  it("refuses a session for someone whose access was removed, and keeps their memberships", async () => {
    const user = await newUser("leaving@client.com");
    await adapter().createSession(user.id);
    const before = (await db.client.query("select count(*) from memberships where user_id = $1", [user.id])).rows[0].count;
    await db.client.query("update deployment_access set value = 'other.com' where value = 'client.com'");
    try {
      await expect(adapter().createSession(user.id)).rejects.toMatchObject({ body: { code: "not_on_access_list" } });
    } finally {
      await db.client.query("update deployment_access set value = 'client.com' where value = 'other.com'");
    }
    expect((await db.client.query("select count(*) from memberships where user_id = $1", [user.id])).rows[0].count).toBe(before);
  });

  it("lets an outsider on a live restricted share link in as a guest, with no memberships", async () => {
    const [ws] = (await db.client.query("select id from workspaces limit 1")).rows.map((r) => r.id as string);
    await db.client.query(
      `insert into share_links (workspace_id, token_hash, kind, show_people, allowed_emails, expires_at, snapshot, engine_version)
       values ($1, repeat('a', 64), 'overview', true, '{guest@outside.org}', now() + interval '1 day', $2::jsonb, '1')`,
      [ws, JSON.stringify({ v: 1, kind: "overview", toggles: { people: true, financials: false } })],
    );
    const user = await newUser("guest@outside.org");
    const session = await adapter().createSession(user.id);
    expect(session.userId).toBe(user.id);
    expect((await db.client.query("select 1 from memberships where user_id = $1", [user.id])).rowCount).toBe(0);
  });

  it("trusts the preview alias and this deployment's own URL, and no look-alike Vercel project", () => {
    const origins = (ctx as unknown as { trustedOrigins: string[] }).trustedOrigins;
    expect(origins).toEqual(expect.arrayContaining(["https://transpera-flow-next.vercel.app", "https://transpera-flow-abc123-team.vercel.app"]));
    expect(origins.some((o) => o.includes("*"))).toBe(false);
  });

  it("refuses to send anyone on to another Vercel project after sign-in", () => {
    // What the origin check asks of a callbackURL (Better Auth skips the check itself under NODE_ENV=test).
    const c = ctx as { isTrustedOrigin(url: string, o?: { allowRelativePaths?: boolean }): boolean };
    const trusted = (url: string, o?: { allowRelativePaths?: boolean }) => c.isTrustedOrigin(url, o);
    expect(trusted("https://transpera-flow-evil.vercel.app/steal", { allowRelativePaths: true })).toBe(false);
    expect(trusted("https://transpera-flow-next.vercel.app/s/abc", { allowRelativePaths: true })).toBe(true);
    expect(trusted("/s/abc", { allowRelativePaths: true })).toBe(true);
  });

  describe("the oAuthProxy, from a direct auth.api call", () => {
    const start = async (host: string) => {
      const { getAuth } = await import("@/lib/auth/server");
      const { incomingRequest } = await import("@/lib/auth/providers");
      const headers = new Headers({ host, "x-forwarded-proto": "https", origin: `https://${host}`, "content-type": "multipart/form-data" });
      const result = await getAuth().api.signInSocial({
        body: { provider: "google", callbackURL: "/s/abc" },
        headers,
        request: incomingRequest(headers, "/api/auth/sign-in/social"),
        asResponse: false,
      });
      return new URL(result.url!);
    };

    it("goes straight to Google from the alias Google knows", async () => {
      const url = await start("transpera-flow-next.vercel.app");
      expect(url.searchParams.get("redirect_uri")).toBe("https://transpera-flow-next.vercel.app/api/auth/callback/google");
      expect(url.searchParams.get("state")!.length).toBeLessThan(100);
    });

    it("goes through the alias from a per-commit preview URL", async () => {
      const url = await start("transpera-flow-abc123-team.vercel.app");
      expect(url.searchParams.get("redirect_uri")).toBe("https://transpera-flow-next.vercel.app/api/auth/callback/google");
      expect(url.searchParams.get("state")!.length).toBeGreaterThan(100); // the proxy's encrypted package
    });
  });
});
