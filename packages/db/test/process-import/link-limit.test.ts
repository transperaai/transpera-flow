import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { takeLinkFetch, LINK_FETCHES_PER_MINUTE } from "../../src/process-import";
import { createUser, startTestDb, userClaims, type ImportTestDb } from "./helpers";

// The link limit's answers, against a throwaway database: the real counter (`take_link_fetch`, also tested in packages/db), the
// function missing before its migration is applied, and any other failure.

let env: ImportTestDb;

beforeAll(async () => {
  env = await startTestDb();
});

afterAll(async () => {
  await env?.close();
});

afterEach(() => vi.restoreAllMocks());

const ctxFor = async () => ({ db: env.dbAs(userClaims(await createUser(env.t.client, `limit-${randomUUID()}@example.com`))) });

describe("takeLinkFetch", () => {
  it("allows a fetch the database counts, and says how long to wait otherwise", async () => {
    const ctx = await ctxFor();
    for (let i = 0; i < LINK_FETCHES_PER_MINUTE; i++) expect(await takeLinkFetch(ctx)).toEqual({ allowed: true });
    const refused = await takeLinkFetch(ctx);
    expect(refused).toMatchObject({ allowed: false, message: expect.stringMatching(/^You've opened 10 links in the last minute\. Try again in \d+ seconds?\.$/) });
    // Each person has their own count.
    expect(await takeLinkFetch(await ctxFor())).toEqual({ allowed: true });
  });

  it("says one second in the singular, and the number of seconds otherwise", async () => {
    const userId = await createUser(env.t.client, `limit-${randomUUID()}@example.com`);
    const ctx = { db: env.dbAs(userClaims(userId)) };
    for (let i = 0; i < LINK_FETCHES_PER_MINUTE; i++) await takeLinkFetch(ctx);
    // Move the window so that one second is left, then 42.
    for (const [left, text] of [[1, "1 second."], [42, "42 seconds."]] as const) {
      await env.t.client.query("update private.link_fetch_limits set window_start = now() - (interval '60 seconds' - make_interval(secs => $2)) where user_id = $1", [userId, left]);
      expect(await takeLinkFetch(ctx)).toMatchObject({ allowed: false, message: expect.stringContaining(`Try again in ${text}`) });
    }
  });

  it("fails open when the function is missing, and logs a tagged warning so it is visible", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const own = await startTestDb();
    try {
      await own.t.client.query("drop function public.take_link_fetch()");
      const ctx = { db: own.dbAs(userClaims(await createUser(own.t.client, `limit-${randomUUID()}@example.com`))) };
      expect(await takeLinkFetch(ctx)).toEqual({ allowed: true });
    } finally {
      await own.close();
    }
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toMatch(/^\[link-limit\] take_link_fetch is missing/);
  });

  it("fails closed on any other error, without logging a warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // Signed out, the function refuses (it counts per signed-in user): not a missing function, so the fetch is not allowed.
    expect(await takeLinkFetch({ db: env.dbAs(null) })).toMatchObject({ allowed: false });
    expect(warn).not.toHaveBeenCalled();
  });
});
