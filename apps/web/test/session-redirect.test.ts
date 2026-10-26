import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// getDb() is the data access layer of every signed-in page. The proxy only checks that a session cookie is there, so an expired
// session, or one whose owner was taken off the access list, reaches the page: getDb() must send them to /login, not query as
// anon (anon may read no table: the page showed "Something went wrong"). Found clicking through the app after the move off
// Supabase, whose proxy checked the user on every request.

vi.mock("server-only", () => ({}));
const getSession = vi.fn();
const currentAccess = vi.fn();
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/lib/auth/server", () => ({ getAuth: () => ({ api: { getSession } }) }));
vi.mock("@/lib/auth/access", async (orig) => ({ ...(await orig<typeof import("@/lib/auth/access")>()), currentAccess }));
vi.mock("@/lib/db/pool", () => ({ appPool: () => ({}), authPool: () => ({}) }));
vi.mock("@transpera-flow/db/client", () => ({ createDb: (_pool: unknown, claims: unknown) => ({ claims }) }));

const { getDb, getVisitorDb } = await import("@/lib/auth/session");

/** Where a NEXT_REDIRECT error points, or null when `run` didn't redirect. */
async function redirectedTo(run: () => Promise<unknown>): Promise<string | null> {
  try {
    await run();
    return null;
  } catch (e) {
    const digest = (e as { digest?: string }).digest ?? "";
    if (!digest.startsWith("NEXT_REDIRECT")) throw e;
    return digest.split(";")[2];
  }
}

const SESSION = { session: { id: "s" }, user: { id: "u1", name: "Nora" } };

beforeEach(() => {
  vi.stubEnv("DATABASE_URL", "postgres://x/y");
  vi.stubEnv("BETTER_AUTH_SECRET", "s".repeat(32));
});
afterEach(() => {
  vi.unstubAllEnvs();
  getSession.mockReset();
  currentAccess.mockReset();
});

describe("getDb", () => {
  it("runs as the signed-in user", async () => {
    getSession.mockResolvedValue(SESSION);
    currentAccess.mockResolvedValue({ email: "a@b.co", agencyAdmin: false, guest: false });
    expect(await getDb()).toMatchObject({ claims: { sub: "u1", role: "authenticated" } });
  });

  it("sends an expired or unknown session to /login instead of querying as anon", async () => {
    getSession.mockResolvedValue(null);
    expect(await redirectedTo(getDb)).toBe("/login");
  });

  it("sends a live session whose owner was taken off the access list to /login, saying why", async () => {
    getSession.mockResolvedValue(SESSION);
    currentAccess.mockResolvedValue(null);
    expect(await redirectedTo(getDb)).toBe("/login?error=not_on_access_list");
  });
});

describe("getVisitorDb (share links, logos)", () => {
  it("runs as anon for a signed-out visitor", async () => {
    getSession.mockResolvedValue(null);
    expect(await getVisitorDb()).toEqual({ claims: null });
  });
});
