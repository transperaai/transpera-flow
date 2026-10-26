import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateFunctionTypes } from "../scripts/function-types";
import { rpc, rpcRows, type Claims } from "../src/client";
import { createTestDb, createUser, type TestDb } from "./harness";

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(() => db.close());

describe("function-types.ts", () => {
  it("is what the migrations generate (run `pnpm --filter @transpera-flow/db gen:types` after changing a function)", async () => {
    const current = readFileSync(new URL("../src/function-types.ts", import.meta.url), "utf8");
    expect(await generateFunctionTypes(db.client)).toBe(current);
  });

  it("types arguments, defaults, overloads and every kind of return", async () => {
    await db.client.query(`
      create type public.zz_mood as enum ('happy', 'sad');
      create function public.zz_a(a int, b text default 'x', c jsonb default null) returns void language sql as 'select';
      create function public.zz_a(a int, d uuid[]) returns table (n bigint, at timestamptz, m zz_mood) language sql as 'select 1::bigint, now(), ''happy''::zz_mood where false';
      create function public.zz_set(n int) returns setof text language sql as 'select ''x''';
      create function public.zz_row() returns public.workspaces language sql as 'select * from public.workspaces limit 1';
      create function public.zz_out(a int, out total numeric, out label text) language sql as 'select a, ''x''';
    `);
    const src = await generateFunctionTypes(db.client);
    expect(src).toContain("zz_a: { Args: { a: number; b?: string; c?: Json }; Returns: null }\n    | { Args: { a: number; d: string[] }; Returns: { n: number; at: string; m: \"happy\" | \"sad\" }[] };");
    expect(src).toContain("zz_set: { Args: { n: number }; Returns: string[] };");
    expect(src).toMatch(/zz_row: \{ Args: never; Returns: \{ id: string; .*settings: Json.*\} \};/);
    expect(src).toContain("zz_out: { Args: { a: number }; Returns: { total: number; label: string } };");
    expect(src).toContain("resolve_issue: { Args: { p_workspace: string; p_id: string; p_how: string; p_note?: string; p_status?: string }; Returns: Json }\n    | {");
  });

  it("types as `| null` the `returns table` columns that do come back null (outer joins, nullable columns)", async () => {
    const src = readFileSync(new URL("../src/function-types.ts", import.meta.url), "utf8");
    const admin = await createUser(db, "nullable-columns@transpera.example", { agency_admin: true });
    const d = db.dbAs(admin.claims as Claims);
    const ws = await rpc(d, "create_workspace", { ws_name: "Nullable columns", ws_slug: "nullable-columns" });

    // A new workspace has no headline numbers yet (left join).
    const listed = (await rpcRows(d, "agency_workspace_list")).find((r) => r.id === ws)!;
    expect(listed).toMatchObject({ numbers: null, computed_at: null });
    expect(src).toMatch(/agency_workspace_list: .*last_activity: string \| null; numbers: Json \| null; computed_at: string \| null/);

    // A member who has never signed in, with no person linked.
    const member = (await rpcRows(d, "workspace_members", { ws })).find((r) => r.user_id === admin.id);
    expect(member).toMatchObject({ person_id: null, last_sign_in_at: null });
    expect(src).toMatch(/workspace_members: .*email: string \| null;.*person_id: string \| null; last_sign_in_at: string \| null/);

    // A source with no recording date or file.
    await d.insertInto("sources").values({ workspace_id: ws, kind: "notes", title: "No date" }).execute();
    const [source] = await rpcRows(d, "search_sources", { p_workspace: ws });
    expect(source).toMatchObject({ recorded_at: null, file_url: null });
    expect(src).toMatch(/search_sources: .*recorded_at: string \| null; file_url: string \| null;/);
  });
});
