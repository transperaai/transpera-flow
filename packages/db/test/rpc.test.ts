import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rpc, rpcRows } from "../src/client";
import { createTestDb, type TestDb } from "./harness";

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
  await db.client.query(`
    create function public.zz_scalar(a int, b int default 10) returns numeric language sql as 'select a + b + 0.5';
    create function public.zz_rows(n int) returns table (i int, at timestamptz) language sql
      as $$ select g, timestamptz '2026-10-26 10:00:00+00' from generate_series(1, n) g $$;
    create function public.zz_void() returns void language sql as 'select';
    create function public.zz_me() returns uuid language sql as 'select auth.uid()';
    grant execute on function public.zz_scalar, public.zz_rows, public.zz_void, public.zz_me to anon, authenticated;
  `);
});
afterAll(() => db.close());

// The helpers are typed from function-types.ts; these test-only functions are not in it.
const anyRpc = rpc as unknown as (...a: unknown[]) => Promise<unknown>;
const anyRows = rpcRows as unknown as (...a: unknown[]) => Promise<unknown>;

describe("rpc", () => {
  it("passes named arguments, leaves undefined ones to their defaults, and returns numbers as numbers", async () => {
    const d = db.dbAs(null);
    expect(await anyRpc(d, "zz_scalar", { a: 1, b: 2 })).toBe(3.5);
    expect(await anyRpc(d, "zz_scalar", { a: 1, b: undefined })).toBe(11.5);
  });
  it("returns null for a void function", async () => {
    expect(await anyRpc(db.dbAs(null), "zz_void")).toBeNull();
  });
  it("runs as the caller", async () => {
    const sub = "a0000000-0000-4000-8000-0000000000aa";
    expect(await anyRpc(db.dbAs({ sub, role: "authenticated" }), "zz_me")).toBe(sub);
  });
  it("returns a set-returning function's rows as PostgREST did, and [] for none", async () => {
    const d = db.dbAs(null);
    expect(await anyRows(d, "zz_rows", { n: 2 })).toEqual([
      { i: 1, at: "2026-10-26T10:00:00+00:00" },
      { i: 2, at: "2026-10-26T10:00:00+00:00" },
    ]);
    expect(await anyRows(d, "zz_rows", { n: 0 })).toEqual([]);
  });
  it("refuses a name that isn't a plain identifier", async () => {
    await expect(anyRpc(db.dbAs(null), "zz_void(); drop table x; --")).rejects.toThrow(/bad function name/);
  });
});

describe("rpc arguments", () => {
  beforeAll(async () => {
    await db.client.query(`
      create function public.zz_json(j jsonb, ids uuid[] default '{}') returns jsonb language sql
        as $$ select jsonb_build_object('j', j, 'n', cardinality(ids)) $$;
      grant execute on function public.zz_json to anon;
    `);
  });
  it("sends an array to a jsonb argument as JSON, and to a uuid[] argument as a Postgres array", async () => {
    const id = "a0000000-0000-4000-8000-0000000000bb";
    expect(await anyRpc(db.dbAs(null), "zz_json", { j: [1, { a: "x" }], ids: [id, id] })).toEqual({ j: [1, { a: "x" }], n: 2 });
    expect(await anyRpc(db.dbAs(null), "zz_json", { j: { k: [true] } })).toEqual({ j: { k: [true] }, n: 0 });
  });
  it("sends a string to a jsonb argument as a JSON string, whatever the other arguments are, as PostgREST did", async () => {
    expect(await anyRpc(db.dbAs(null), "zz_json", { j: "[1]" })).toEqual({ j: "[1]", n: 0 });
    expect(await anyRpc(db.dbAs(null), "zz_json", { j: "[1]", ids: ["a0000000-0000-4000-8000-0000000000bb"] })).toEqual({ j: "[1]", n: 1 });
  });
});
