import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { onceForRequest } = await import("@/lib/auth/session");

// getSessionUser's per-request memo: React's `cache` doesn't memoize in a Server Action or a Route Handler, where nearly every
// call site asks getSessionUser() and then getDb() (which asks again), each time a session read and an access check.
describe("onceForRequest", () => {
  const user = { id: "u", email: "a@b.c", agencyAdmin: false, guest: false, name: null };

  it("loads once for one request's headers, and again for another request", async () => {
    const load = vi.fn(async () => user);
    const first = new Headers();
    expect(await onceForRequest(first, load)).toBe(user);
    expect(await onceForRequest(first, load)).toBe(user);
    expect(load).toHaveBeenCalledTimes(1);
    await onceForRequest(new Headers(), load);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("doesn't keep a failed load", async () => {
    const h = new Headers();
    await expect(onceForRequest(h, async () => Promise.reject(new Error("db down")))).rejects.toThrow("db down");
    await Promise.resolve();
    expect(await onceForRequest(h, async () => user)).toBe(user);
  });
});
