import { describe, expect, it } from "vitest";
import { BUNDLE_TABLES, supabaseReader, type Db } from "../src";

// The Supabase reader pages (the API returns at most 1000 rows a request), orders stably and filters to the workspace.

function fakeDb(total: number) {
  const calls: { table: string; select: string; eq: [string, string]; order: string[]; range: [number, number] }[] = [];
  const db = {
    from(table: string) {
      const call = { table, select: "", eq: ["", ""] as [string, string], order: [] as string[], range: [0, 0] as [number, number] };
      const q = {
        select(c: string) {
          call.select = c;
          return q;
        },
        eq(c: string, v: string) {
          call.eq = [c, v];
          return q;
        },
        order(c: string) {
          call.order.push(c);
          return q;
        },
        async range(a: number, b: number) {
          call.range = [a, b];
          calls.push({ ...call, order: [...call.order] });
          const rows = Array.from({ length: Math.max(0, Math.min(b + 1, total) - a) }, (_, i) => ({ id: a + i, workspace_id: "w" }));
          return { data: rows, error: null };
        },
      };
      return q;
    },
  };
  return { db: db as unknown as Db, calls };
}

describe("supabaseReader", () => {
  it("reads every page, scoped to the workspace and in a stable order", async () => {
    const { db, calls } = fakeDb(2005);
    const rows = await supabaseReader(db)("steps", "w");
    expect(rows).toHaveLength(2005);
    expect(calls.map((c) => c.range)).toEqual([[0, 999], [1000, 1999], [2000, 2999]]);
    expect(calls.every((c) => c.eq[0] === "workspace_id" && c.eq[1] === "w")).toBe(true);
    expect(calls[0]!.order).toEqual(["id"]);
  });

  it("stops after one short page, and never asks for a column the app can't read", async () => {
    const { db, calls } = fakeDb(3);
    expect(await supabaseReader(db)("suggestion_proposals", "w")).toHaveLength(3);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.select).not.toContain("proposer_email");
    expect(calls[0]!.select).toBe(BUNDLE_TABLES.suggestion_proposals.columns);
  });

  it("refuses a table that is not part of a bundle", async () => {
    await expect(supabaseReader(fakeDb(0).db)("api_tokens", "w")).rejects.toThrow(/Not a bundle table/);
    await expect(supabaseReader(fakeDb(0).db)("memberships", "w")).rejects.toThrow(/Not a bundle table/);
  });
});
