import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { createTestDb, createUser, type TestDb } from "./harness";

// Migration 20270137000000_library_process_category.sql: `create_library_process` takes an optional category (D52). Given, it is the
// process's category (the check constraint refuses a bad one); absent, the before-insert default fills it from the kind, as before.

let db: TestDb;
let ws: string;
let owner: { id: string; claims: Record<string, unknown> };

const q = async (sql: string, params: unknown[] = []) => (await db.client.query(sql, params)).rows;

async function asOwner<T>(fn: () => Promise<T>): Promise<T> {
  await db.client.query("begin");
  try {
    await db.client.query("set local role authenticated");
    await db.client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(owner.claims)]);
    const out = await fn();
    await db.client.query("commit");
    return out;
  } catch (e) {
    await db.client.query("rollback");
    throw e;
  }
}

const make = (name: string, kind: string, ...rest: unknown[]) =>
  asOwner(async () => (await q(`select public.create_library_process($1, $2, $3${rest.length ? ", null, null, 'manual', $4" : ""}) as r`, [ws, name, kind, ...rest]))[0].r as { status: string; process_id?: string });
const categoryOf = async (id: string) => (await q("select category, kind from public.processes where id = $1", [id]))[0] as { category: string; kind: string };

beforeAll(async () => {
  db = await createTestDb();
  owner = await createUser(db, "library-category@example.com");
  [{ id: ws }] = await q("insert into workspaces (name, slug) values ('Library category', 'library-category') returning id");
  await q("insert into memberships (workspace_id, user_id, role) values ($1, $2, 'owner')", [ws, owner.id]);
}, 120_000);

afterAll(async () => {
  await db?.close();
});

describe("create_library_process with and without p_category", () => {
  it("leaves the category to the default when none is sent (six arguments, as before)", async () => {
    const a = await make("Pipeline default", "pipeline");
    const b = await make("Servicing default", "servicing");
    expect(await categoryOf(a.process_id!)).toEqual({ category: "sales", kind: "pipeline" });
    expect(await categoryOf(b.process_id!)).toEqual({ category: "routine_client_work", kind: "servicing" });
  });

  it("stores the category it is given, with the kind it is given", async () => {
    const onboarding = await make("Onboarding made", "pipeline", "onboarding");
    const internal = await make("Internal made", "servicing", "internal");
    const adHoc = await make("Ad hoc made", "servicing", "ad_hoc");
    expect(await categoryOf(onboarding.process_id!)).toEqual({ category: "onboarding", kind: "pipeline" });
    expect(await categoryOf(internal.process_id!)).toEqual({ category: "internal", kind: "servicing" });
    expect(await categoryOf(adHoc.process_id!)).toEqual({ category: "ad_hoc", kind: "servicing" });
  });

  it("refuses a category that isn't one (the check constraint), and there is one function with seven arguments", async () => {
    await expect(make("Bad category", "servicing", "nonsense")).rejects.toThrow(/processes_category_check/);
    const fns = await q("select pg_get_function_identity_arguments(oid) as args from pg_proc where proname = 'create_library_process' and pronamespace = 'public'::regnamespace");
    expect(fns).toHaveLength(1);
    expect(fns[0].args.split(",").length).toBe(7);
  });
});
