import pg from "pg";
import { describe, expect, it } from "vitest";
import { createDb } from "../src/client";

// Compiling runs the plugin without a database. apps/web's first-principles action test writes arrays for real.
const db = createDb(new pg.Pool(), null);
const WS = "a0000000-0000-4000-8000-000000000001";

describe("JSON columns", () => {
  it("JSON-encodes arrays and other non-strings written to a jsonb column on insert, and leaves other columns", () => {
    const q = db.insertInto("analysis_rules").values({ workspace_id: WS, settings: [1, { a: [2] }] as never }).compile();
    expect(q.parameters).toEqual([WS, JSON.stringify([1, { a: [2] }])]);
  });
  it("encodes each row of a multi-row insert, and the upsert's update", () => {
    const q = db
      .insertInto("analysis_rules")
      .values([
        { workspace_id: WS, settings: [1] as never },
        { workspace_id: WS, settings: { b: true } },
      ])
      .onConflict((oc) => oc.column("workspace_id").doUpdateSet({ settings: [3] as never }))
      .compile();
    expect(q.parameters).toEqual([WS, "[1]", WS, '{"b":true}', "[3]"]);
  });
  it("encodes on update, leaves strings (already JSON text) and null alone", () => {
    expect(db.updateTable("analysis_rules").set({ settings: ["x"] as never }).where("workspace_id", "=", WS).compile().parameters).toEqual(['["x"]', WS]);
    expect(db.updateTable("analysis_rules").set({ settings: '{"y":1}' }).compile().parameters).toEqual(['{"y":1}']);
    expect(db.updateTable("analysis_rules as r").set({ settings: [true] as never }).compile().parameters).toEqual(["[true]"]);
  });
});
