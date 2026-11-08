import { randomUUID } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations } from "../src/migrations";
import { createTestDb, createUser, type TestDb } from "./harness";

// The company map drives the run (Q17, D51, ADR 0023; migration 20270134000000_map_drives_run.sql). `processes.map_drives_run` is true on every
// company map except one a person already published a version of before the migration (so a run nobody touched doesn't move). The migration
// runs on a database as it was before it: one workspace whose map only the system made, one whose map a person published. Then a person's
// publish (or restore) flips the flag for good, and a system-made version leaves it alone.

const BASE = "20270132000000";
let db: TestDb;
let editor: { id: string; claims: Record<string, unknown> };
type Reply = Record<string, unknown> & { status: string };

const q = async (sql: string, params: unknown[] = []) => (await db.client.query(sql, params)).rows;
async function commitAs<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  await db.client.query("begin");
  try {
    await db.client.query("set local role authenticated");
    await db.client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(editor.claims)]);
    const out = await fn(db.client);
    await db.client.query("commit");
    return out;
  } catch (err) {
    await db.client.query("rollback");
    throw err;
  }
}
const rpc = async (c: pg.Client, fn: string, ...args: unknown[]): Promise<Reply> =>
  (await c.query(`select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(", ")}) as r`, args)).rows[0].r as Reply;

let n = 0;
async function workspace(label: string) {
  const i = ++n;
  const [{ id: ws }] = await q("insert into workspaces (name, slug) values ($1, $2) returning id", [`${label} ${i}`, `map-drives-run-${i}`]);
  await q("insert into memberships (workspace_id, user_id, role) values ($1, $2, 'owner')", [ws, editor.id]);
  await q("insert into processes (id, workspace_id, name, kind) values ($1, $2, 'Sales', 'pipeline'), ($3, $2, 'Delivery', 'servicing')", [randomUUID(), ws, randomUUID()]);
  const [{ id: cid }] = await q("select id from processes where workspace_id = $1 and is_company", [ws]);
  return { ws, cid: cid as string };
}
const flag = async (cid: string) => (await q("select map_drives_run from processes where id = $1", [cid]))[0].map_drives_run as boolean;
const publish = async (cid: string) => {
  await commitAs((c) => rpc(c, "open_draft", cid));
  const r = await commitAs((c) => rpc(c, "publish_process", cid));
  expect(r.status).toBe("published");
};

let systemOnly: { ws: string; cid: string };
let touched: { ws: string; cid: string };

beforeAll(async () => {
  db = await createTestDb({ upTo: BASE, supabaseDefaultPrivileges: true });
  editor = await createUser(db, "editor@map-drives-run.example.com");
  systemOnly = await workspace("System only");
  touched = await workspace("Touched");
  await publish(touched.cid);
  const applied = await applyMigrations(db.client, {});
  expect(applied.files[0]).toBe("20270134000000_map_drives_run.sql");
});

afterAll(async () => {
  await db?.close();
});

describe("map_drives_run", () => {
  it("is backfilled false for a map a person published, true for one only the system made", async () => {
    expect((await q("select count(*)::int c from process_revisions where process_id = $1 and published_by is not null", [touched.cid]))[0].c).toBeGreaterThan(0);
    expect((await q("select count(*)::int c from process_revisions where process_id = $1 and published_by is not null", [systemOnly.cid]))[0].c).toBe(0);
    expect(await flag(touched.cid)).toBe(false);
    expect(await flag(systemOnly.cid)).toBe(true);
  });

  it("is true for the map of a workspace made after the migration, and for every ordinary process", async () => {
    const fresh = await workspace("Fresh");
    expect(await flag(fresh.cid)).toBe(true);
    expect((await q("select count(*)::int c from processes where not is_company and not map_drives_run"))[0].c).toBe(0);
  });

  it("is left alone by a system-made version, and flipped by a person's publish", async () => {
    // A new process puts a card on the map in a system-made version (published_by null): the flag stays false.
    await q("insert into processes (id, workspace_id, name, kind) values ($1, $2, 'Support', 'servicing')", [randomUUID(), touched.ws]);
    const [live] = await q("select r.published_by from process_revisions r join processes p on p.live_revision_id = r.id where p.id = $1", [touched.cid]);
    expect(live.published_by).toBeNull();
    expect(await flag(touched.cid)).toBe(false);
    // A person's publish makes the map drive the run.
    await publish(touched.cid);
    expect(await flag(touched.cid)).toBe(true);
    // And it stays true when the system makes another version.
    await q("insert into processes (id, workspace_id, name, kind) values ($1, $2, 'Reporting', 'servicing')", [randomUUID(), touched.ws]);
    expect(await flag(touched.cid)).toBe(true);
  });

  it("is flipped by a person's restore of an earlier version, once it is published", async () => {
    const w = await workspace("Restore");
    // Made false as an older workspace's would be, then a person restores the first version.
    await q("update processes set map_drives_run = false where id = $1", [w.cid]);
    const [first] = await q("select id from process_revisions where process_id = $1 and status = 'published'", [w.cid]);
    await q("insert into processes (id, workspace_id, name, kind) values ($1, $2, 'Support', 'servicing')", [randomUUID(), w.ws]);
    expect(await flag(w.cid)).toBe(false);
    const r = await commitAs((c) => rpc(c, "restore_version", w.cid, first.id));
    expect(r.status).toBe("restored");
    // A restore opens a draft; the flag moves when the person publishes it.
    await commitAs((c) => rpc(c, "publish_process", w.cid));
    expect(await flag(w.cid)).toBe(true);
  });
});
