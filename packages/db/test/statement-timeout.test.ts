import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rpc, rpcRows } from "../src/client";
import { createTestDb, type TestDb } from "./harness";

// PostgREST applied each role's statement_timeout (anon 3 s, authenticated 8 s) and a function's own `set statement_timeout`.
// set_config('role', ...) applies neither, so the ClaimsDriver sets the role's limit and rpc() sets the function's.

let db: TestDb;
const user = { sub: "a0000000-0000-4000-8000-0000000000aa", role: "authenticated" as const };
// The test-only functions aren't in the generated types.
const anyRpc = rpc as unknown as (...a: unknown[]) => Promise<unknown>;
const anyRows = rpcRows as unknown as (...a: unknown[]) => Promise<unknown>;

beforeAll(async () => {
  db = await createTestDb();
  await db.client.query(`
    create function public.zz_sleep_plain(s float8) returns text language sql as 'select pg_sleep(s)::text';
    create function public.zz_sleep_long(s float8) returns text language sql set statement_timeout = '6s' as 'select pg_sleep(s)::text';
    create function public.zz_sleep_short(s float8) returns text language sql set statement_timeout = '1s' as 'select pg_sleep(s)::text';
    create function public.zz_sleep_rows(s float8) returns table (n int, m int) language sql set statement_timeout = '6s' as 'select 1, 2 from (select pg_sleep(s)) x';
    create function public.zz_limit() returns text language sql as $$select current_setting('statement_timeout')$$;
    create function public.zz_limit_long() returns text language sql set statement_timeout = '45s' as $$select current_setting('statement_timeout')$$;
    create function public.zz_limit_bare() returns text language sql set statement_timeout = 5000 as $$select current_setting('statement_timeout')$$;
    create function public.zz_sleep_over(s float8) returns text language sql set statement_timeout = 0 as 'select pg_sleep(s)::text';
    create function public.zz_sleep_over(s float8, x int) returns text language sql set statement_timeout = '1s' as 'select pg_sleep(s)::text';
    create function public.zz_limit_fail() returns text language plpgsql set statement_timeout = '45s' as $$begin raise exception 'zz failed' using errcode = 'P0001'; end$$;
    grant execute on all functions in schema public to anon, authenticated;
  `);
});
afterAll(() => db.close());

const limit = (d: ReturnType<TestDb["dbAs"]>) =>
  sql<{ v: string }>`select current_setting('statement_timeout') as v`.execute(d).then((r) => r.rows[0]!.v);

describe("the role's statement timeout", () => {
  it("is 3 s for anon and 8 s for authenticated, on every statement", async () => {
    expect(await limit(db.dbAs(null))).toBe("3s");
    expect(await limit(db.dbAs(user))).toBe("8s");
  });

  it("applies inside db.transaction() and db.connection()", async () => {
    const d = db.dbAs(user);
    expect(await d.transaction().execute((trx) => limit(trx))).toBe("8s");
    expect(await d.connection().execute((c) => limit(c))).toBe("8s");
    expect(await db.dbAs(null).transaction().execute((trx) => limit(trx))).toBe("3s");
  });

  it("cancels a statement that runs past it (57014)", async () => {
    await expect(sql`select pg_sleep(4)`.execute(db.dbAs(null))).rejects.toMatchObject({ code: "57014" });
  }, 10_000);

  it("is the limit of the role, not a longer one: authenticated outlasts anon's 3 s; and a cancelled connection stays usable", async () => {
    const d = db.dbAs(null);
    const [authenticated, anon] = await Promise.allSettled([sql`select pg_sleep(4)`.execute(db.dbAs(user)), sql`select pg_sleep(4)`.execute(d)]);
    expect(authenticated.status).toBe("fulfilled");
    expect(anon).toMatchObject({ status: "rejected", reason: { code: "57014" } });
    expect(await limit(d)).toBe("3s");
  }, 10_000);
});

describe("a function's own statement timeout", () => {
  it("is cancelled at the role's limit when the function sets none", async () => {
    await expect(anyRpc(db.dbAs(null), "zz_sleep_plain", { s: 4 })).rejects.toMatchObject({ code: "57014" });
  }, 10_000);

  it("a function with a longer limit isn't cancelled at the role's (anon: 3 s, function: 6 s)", async () => {
    const [scalar, rows] = await Promise.all([anyRpc(db.dbAs(null), "zz_sleep_long", { s: 4 }), anyRows(db.dbAs(null), "zz_sleep_rows", { s: 4 })]);
    expect(scalar).toBe("");
    expect(rows).toEqual([{ n: 1, m: 2 }]);
  }, 15_000);

  it("a function with a shorter limit is cancelled at its own (authenticated: 8 s, function: 1 s)", async () => {
    await expect(anyRpc(db.dbAs(user), "zz_sleep_short", { s: 2 })).rejects.toMatchObject({ code: "57014" });
  }, 10_000);

  it("the function's limit is in force while it runs, and the role's is back after", async () => {
    const d = db.dbAs(null);
    expect(await anyRpc(d, "zz_limit_long")).toBe("45s");
    expect(await anyRpc(d, "zz_limit")).toBe("3s");
    expect(await limit(d)).toBe("3s");
  });

  it("inside db.transaction() the earlier limit is restored after the call", async () => {
    const d = db.dbAs(user);
    const seen = await d.transaction().execute(async (trx) => [await limit(trx), await anyRpc(trx, "zz_limit_long"), await limit(trx)]);
    expect(seen).toEqual(["8s", "45s", "8s"]);
  });

  it("works on a db.connection() too", async () => {
    const seen = await db.dbAs(null).connection().execute(async (c) => [await anyRpc(c, "zz_limit_long"), await limit(c)]);
    expect(seen).toEqual(["45s", "3s"]);
  });

  it("reads import_workspace_bundle's 40 s from the catalog, as the migration set it", async () => {
    const { rows } = await db.client.query(
      "select proconfig from pg_proc where pronamespace = 'public'::regnamespace and proname = 'import_workspace_bundle'",
    );
    expect(rows[0]!.proconfig).toContain("statement_timeout=40s");
  });

  it("reads a unit-less limit as milliseconds, as Postgres does", async () => {
    expect(await anyRpc(db.dbAs(null), "zz_limit_bare")).toBe("5s");
  });

  it("among overloads takes the longest, and 0 (no limit) is longer than any (anon: 3 s; overloads: none and 1 s)", async () => {
    expect(await anyRpc(db.dbAs(null), "zz_sleep_over", { s: 3.5 })).toBe("");
    expect(await limit(db.dbAs(null))).toBe("3s");
  }, 10_000);

  it("is not left behind when the call fails: on the pool, on a db.connection(), or rolled back to a savepoint", async () => {
    const d = db.dbAs(null);
    await expect(anyRpc(d, "zz_limit_fail")).rejects.toMatchObject({ code: "P0001" });
    expect(await limit(d)).toBe("3s");

    const afterRollback = await d.connection().execute(async (c) => {
      await expect(c.transaction().execute((trx) => anyRpc(trx, "zz_limit_fail"))).rejects.toMatchObject({ code: "P0001" });
      return limit(c);
    });
    expect(afterRollback).toBe("3s");

    const trx = await db.dbAs(user).startTransaction().execute();
    try {
      const sp = await trx.savepoint("before_call").execute();
      await expect(anyRpc(sp, "zz_limit_fail")).rejects.toMatchObject({ code: "P0001" });
      await sp.rollbackToSavepoint("before_call").execute();
      expect(await limit(trx)).toBe("8s");
    } finally {
      await trx.rollback().execute();
    }
  });
});
