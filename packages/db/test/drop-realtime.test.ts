import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./harness";

// Live editing was removed (docs/adr/0005, superseded). After migration
// 20261231000000_drop_realtime.sql nothing of ours refers to Realtime. The
// test database has the legacy shim's publication and realtime.messages, as
// Neon does, so this also shows the migration applies on top of the shim.

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb({ realtime: true });
});

afterAll(async () => {
  await db?.close();
});

describe("Realtime is dropped", () => {
  it("leaves no table in the supabase_realtime publication", async () => {
    const r = await db.client.query("select tablename from pg_publication_tables where pubname = 'supabase_realtime'");
    expect(r.rows).toEqual([]);
  });

  it("leaves no policy of ours on realtime.messages", async () => {
    const r = await db.client.query("select policyname from pg_policies where schemaname = 'realtime' and tablename = 'messages'");
    expect(r.rows).toEqual([]);
  });

  it("leaves no function or trigger that references realtime.", async () => {
    const fns = await db.client.query(
      `select n.nspname || '.' || p.proname as name
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname not in ('pg_catalog', 'information_schema', 'realtime')
          and p.prokind in ('f', 'p')
          and pg_get_functiondef(p.oid) ~* '\\mrealtime\\.'
        order by 1`,
    );
    expect(fns.rows).toEqual([]);
    const triggers = await db.client.query(
      `select tgrelid::regclass::text as tbl, tgname from pg_trigger
        where not tgisinternal and pg_get_triggerdef(oid) ~* '\\mrealtime\\.'`,
    );
    expect(triggers.rows).toEqual([]);
    expect((await db.client.query("select to_regprocedure('private.process_topic(text)') as f")).rows[0].f).toBeNull();
  });

  it("applies on a database without the shim too", async () => {
    const plain = await createTestDb({ realtime: false });
    try {
      expect((await plain.client.query("select count(*)::int as n from pg_publication")).rows[0].n).toBe(0);
      expect((await plain.client.query("select to_regprocedure('private.process_topic(text)') as f")).rows[0].f).toBeNull();
    } finally {
      await plain.close();
    }
  });

  it("applies again without effect", async () => {
    const { readFileSync } = await import("node:fs");
    const sql = readFileSync(new URL("../migrations/20261231000000_drop_realtime.sql", import.meta.url), "utf8");
    await expect(db.client.query(sql)).resolves.toBeDefined();
  });
});
