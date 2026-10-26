import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateFunctionTypes } from "../scripts/function-types";
import { createTestDb, type TestDb } from "./harness";

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
});
