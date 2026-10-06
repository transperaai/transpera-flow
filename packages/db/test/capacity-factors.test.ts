import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LARKSPUR_WORKSPACE_ID, NORTHBEAM_WORKSPACE_ID, northbeamPersonIds, northbeamStepIds } from "../src";
import { headerRollback } from "./header-rollback";
import { createTestDb, createUser, type TestDb } from "./harness";

// Per-person times (issue #198, C6, migration 20261223000000_capacity_factors.sql): the table and its checks, the compare-and-set
// function, the switch function (owners and editors), who may write and who is refused, and the header's rollback. The privacy of
// `team_capacity` is in team-capacity.test.ts, the role matrix in role-matrix.test.ts and the share-link refusals in share-links.test.ts.

const FILE = "20261223000000_capacity_factors.sql";
const ws = NORTHBEAM_WORKSPACE_ID;
const P = {
  member: northbeamPersonIds["Leah Brooks"]!,
  viewer: northbeamPersonIds["Dan Okafor"]!,
  editor: northbeamPersonIds["Maya Collins"]!,
  other: northbeamPersonIds["Rosa Diaz"]!,
};
const STEP = northbeamStepIds.audit;
const STEP2 = northbeamStepIds.kickoff;

type Claims = Record<string, unknown>;
interface User {
  id: string;
  claims: Claims;
}
let db: TestDb;
let editor: User;
let owner: User;
let member: User;
let viewer: User;
let stranger: User;
let larkspurStep: string;
const tokenId = randomUUID();

beforeAll(async () => {
  db = await createTestDb();
  const link = async (email: string, role: string, person: string | null) => {
    const u = await createUser(db, email);
    await db.client.query("insert into memberships (workspace_id, user_id, role, person_id) values ($1, $2, $3, $4)", [ws, u.id, role, person]);
    return u;
  };
  editor = await link("cf-editor@example.com", "editor", P.editor);
  owner = await link("cf-owner@example.com", "owner", null);
  member = await link("cf-member@example.com", "member", P.member);
  viewer = await link("cf-viewer@example.com", "viewer", P.viewer);
  stranger = await createUser(db, "cf-stranger@example.com");
  larkspurStep = (await db.client.query("select id from steps where workspace_id = $1 limit 1", [LARKSPUR_WORKSPACE_ID])).rows[0].id;
}, 120_000);

afterAll(async () => {
  await db?.close();
});

const save = (c: pg.Client, person: string, step: string | null, base: number | null, value: number | null) =>
  c.query("select public.save_capacity_factor($1, $2, $3, $4) as r", [person, step, base, value]);
const saved = async (c: pg.Client, person: string, step: string | null, base: number | null, value: number | null) =>
  (await save(c, person, step, base, value)).rows[0].r as { status: string; value?: number | null; theirs?: number | null };
const stored = async (c: pg.Client, person: string, step: string | null) => {
  await c.query("reset role");
  const rows = (await c.query("select factor::float8 as factor from person_capacity_factors where person_id = $1 and step_id is not distinct from $2", [person, step])).rows;
  await c.query("set local role authenticated");
  return rows.map((r) => r.factor as number);
};
const count = async () => Number((await db.client.query("select count(*) from person_capacity_factors")).rows[0].count);

/** Run `sql` as the superuser inside a savepoint and return the error code it raised (null if none). */
async function codeOf(c: pg.Client, sql: string, params: unknown[] = []): Promise<string | null> {
  await c.query("savepoint s");
  try {
    await c.query(sql, params);
    await c.query("release savepoint s");
    return null;
  } catch (e) {
    await c.query("rollback to savepoint s");
    return (e as { code: string }).code;
  }
}

describe("the table", () => {
  it("refuses 0.49, 2.01 and 0, accepts 0.5 and 2; one default and one factor per step, per person (23505); a person delete cascades", async () => {
    await db.client.query("begin");
    try {
      const ins = (step: string | null, factor: number, person = P.other) =>
        codeOf(db.client, "insert into person_capacity_factors (person_id, workspace_id, step_id, factor) values ($1, $2, $3, $4)", [person, ws, step, factor]);
      expect(await ins(STEP, 0.49)).toBe("23514");
      expect(await ins(STEP, 2.01)).toBe("23514");
      expect(await ins(STEP, 0)).toBe("23514");
      expect(await ins(null, -1)).toBe("23514");
      expect(await ins(STEP, 0.5)).toBeNull();
      expect(await ins(STEP2, 2)).toBeNull();
      expect(await ins(null, 1.1)).toBeNull();
      // A second default, and a second row for the same step.
      expect(await ins(null, 1.2)).toBe("23505");
      expect(await ins(STEP, 0.7)).toBe("23505");
      // Another person may hold their own.
      expect(await ins(null, 1.2, P.member)).toBeNull();
      // Provenance: the trigger stamps `factor`, and a table with no primary key still updates and keeps updated_at moving.
      const p = (await db.client.query("select provenance from person_capacity_factors where person_id = $1 and step_id is null", [P.other])).rows[0].provenance;
      expect(p.factor.source).toBe("entered");
      // A person is deleted with their factors.
      const before = Number((await db.client.query("select count(*) from person_capacity_factors where person_id = $1", [P.other])).rows[0].count);
      expect(before).toBe(3);
      await db.client.query("delete from people where id = $1", [P.other]);
      expect(Number((await db.client.query("select count(*) from person_capacity_factors where person_id = $1", [P.other])).rows[0].count)).toBe(0);
      // The foreign key is on (person, workspace): a person under another workspace's id is refused.
      expect(await codeOf(db.client, "insert into person_capacity_factors (person_id, workspace_id, step_id, factor) values ($1, $2, null, 1)", [P.editor, LARKSPUR_WORKSPACE_ID])).toBe("23503");
    } finally {
      await db.client.query("rollback");
    }
    expect(await count()).toBe(0);
  });

  it("anon holds nothing on it; authenticated holds the four rights; RLS is on with four policies", async () => {
    const grants = (await db.client.query(
      "select grantee, privilege_type from information_schema.role_table_grants where table_schema = 'public' and table_name = 'person_capacity_factors' and grantee in ('anon', 'authenticated') order by 1, 2",
    )).rows;
    expect(grants).toEqual([
      { grantee: "authenticated", privilege_type: "DELETE" },
      { grantee: "authenticated", privilege_type: "INSERT" },
      { grantee: "authenticated", privilege_type: "SELECT" },
      { grantee: "authenticated", privilege_type: "UPDATE" },
    ]);
    expect((await db.client.query("select relrowsecurity from pg_class where oid = 'public.person_capacity_factors'::regclass")).rows[0].relrowsecurity).toBe(true);
    const policies = (await db.client.query("select cmd, qual from pg_policies where tablename = 'person_capacity_factors' order by cmd")).rows;
    expect(policies.map((p) => p.cmd)).toEqual(["DELETE", "INSERT", "SELECT", "UPDATE"]);
    expect(policies.find((p) => p.cmd === "SELECT")!.qual).toContain("can_see_person");
    const triggers = (await db.client.query("select tgname from pg_trigger where tgrelid = 'public.person_capacity_factors'::regclass and not tgisinternal order by 1")).rows;
    expect(triggers.map((t) => t.tgname)).toEqual(["audit_company", "needs_review", "set_updated_at", "stamp_provenance"]);
    const fns = (await db.client.query(
      "select proname, prosecdef, proconfig from pg_proc where pronamespace = 'public'::regnamespace and proname in ('save_capacity_factor', 'save_capacity_factor_switch', 'team_capacity') order by 1",
    )).rows;
    expect(fns).toEqual([
      { proname: "save_capacity_factor", prosecdef: false, proconfig: ['search_path=""'] },
      { proname: "save_capacity_factor_switch", prosecdef: true, proconfig: ['search_path=""'] },
      { proname: "team_capacity", prosecdef: true, proconfig: ['search_path=""'] },
    ]);
  });
});

describe("save_capacity_factor, as an editor", () => {
  it("inserts a default and a step, updates, and a null removes; the saved value is what is stored", async () => {
    await db.as(editor.claims, async (c) => {
      expect(await saved(c, P.other, null, null, 0.9)).toEqual({ status: "saved", value: 0.9 });
      expect(await saved(c, P.other, STEP, null, 0.8)).toEqual({ status: "saved", value: 0.8 });
      expect(await stored(c, P.other, null)).toEqual([0.9]);
      expect(await stored(c, P.other, STEP)).toEqual([0.8]);
      // Update: base is what we last saw.
      expect(await saved(c, P.other, STEP, 0.8, 1.25)).toEqual({ status: "saved", value: 1.25 });
      expect(await stored(c, P.other, STEP)).toEqual([1.25]);
      // The bounds are inclusive.
      expect(await saved(c, P.other, STEP, 1.25, 0.5)).toEqual({ status: "saved", value: 0.5 });
      expect(await saved(c, P.other, STEP, 0.5, 2)).toEqual({ status: "saved", value: 2 });
      // Saving what is stored changes nothing and is saved.
      expect(await saved(c, P.other, STEP, 2, 2)).toEqual({ status: "saved", value: 2 });
      // A null removes the row (back to the default / 1).
      expect(await saved(c, P.other, STEP, 2, null)).toEqual({ status: "saved", value: null });
      expect(await stored(c, P.other, STEP)).toEqual([]);
      // Removing what is not there is saved too.
      expect(await saved(c, P.other, STEP, null, null)).toEqual({ status: "saved", value: null });
      expect(await stored(c, P.other, null)).toEqual([0.9]);
    });
    expect(await count()).toBe(0);
  });

  it("a stale base gives a conflict with what is stored (null when there is no row), and writes nothing", async () => {
    await db.as(editor.claims, async (c) => {
      await saved(c, P.other, STEP, null, 0.8);
      // Someone else changed it to 0.8 while we looked at 1.1: ours is neither stored nor the base.
      expect(await saved(c, P.other, STEP, 1.1, 1.5)).toEqual({ status: "conflict", theirs: 0.8 });
      expect(await stored(c, P.other, STEP)).toEqual([0.8]);
      // We looked at 0.8, but it was removed: no row.
      expect(await saved(c, P.other, STEP2, 0.8, 1.5)).toEqual({ status: "conflict", theirs: null });
      expect(await stored(c, P.other, STEP2)).toEqual([]);
      // A removal against a stale base conflicts as well.
      expect(await saved(c, P.other, STEP, 1.1, null)).toEqual({ status: "conflict", theirs: 0.8 });
      expect(await stored(c, P.other, STEP)).toEqual([0.8]);
      // Someone already saved the very value we mean to: not a conflict.
      expect(await saved(c, P.other, STEP, 1.1, 0.8)).toEqual({ status: "saved", value: 0.8 });
    });
  });

  it("refuses a value out of range (23514), a step of another workspace (22023), and answers not_found for an unknown person", async () => {
    await db.as(editor.claims, async (c) => {
      for (const bad of [0.49, 2.01, 0, -1, 10]) {
        await c.query("savepoint s");
        await expect(save(c, P.other, STEP, null, bad), String(bad)).rejects.toMatchObject({ code: "23514", message: "save_capacity_factor: a factor is from 0.5 to 2" });
        await c.query("rollback to savepoint s");
      }
      await c.query("savepoint s");
      await expect(save(c, P.other, larkspurStep, null, 1.2)).rejects.toMatchObject({ code: "22023", message: "save_capacity_factor: that step is not in this workspace" });
      await c.query("rollback to savepoint s");
      expect((await save(c, randomUUID(), STEP, null, 1.2)).rows[0].r).toEqual({ status: "not_found" });
    });
    // A person of another workspace is not found either: an editor of Northbeam can't see them.
    const other = (await db.client.query("select id from people where workspace_id = $1 limit 1", [LARKSPUR_WORKSPACE_ID])).rows[0].id;
    await db.as(editor.claims, async (c) => {
      expect((await save(c, other, null, null, 1.2)).rows[0].r).toEqual({ status: "not_found" });
    });
    expect(await count()).toBe(0);
  });

  it("stamps provenance.factor as entered by them and writes an audit row naming them; the audit target is the person", async () => {
    await db.as(editor.claims, async (c) => {
      await saved(c, P.other, STEP, null, 0.8);
      await saved(c, P.other, STEP, 0.8, 0.9);
      await saved(c, P.other, STEP, 0.9, null);
      await c.query("reset role");
      const prov = (await c.query("select provenance from person_capacity_factors where person_id = $1", [P.other])).rows;
      expect(prov).toEqual([]);
      const rows = (await c.query(
        "select actor_id, actor_kind, action, target_table, target_id, diff from audit_log where created_at = now() and target_table = 'person_capacity_factors' order by action",
      )).rows as { actor_id: string; actor_kind: string; action: string; target_id: string; diff: { old?: { factor: number }; new?: { factor: number } } }[];
      expect(rows.map((r) => r.action)).toEqual(["delete", "insert", "update"]);
      for (const r of rows) {
        expect(r).toMatchObject({ actor_id: editor.id, actor_kind: "user", target_id: P.other });
      }
      expect(rows.find((r) => r.action === "insert")!.diff.new).toMatchObject({ step_id: STEP, factor: 0.8 });
      expect(rows.find((r) => r.action === "update")!.diff).toMatchObject({ old: { factor: 0.8 }, new: { factor: 0.9 } });
    });
    await db.as(editor.claims, async (c) => {
      await saved(c, P.other, null, null, 1.1);
      await c.query("reset role");
      const prov = (await c.query("select provenance from person_capacity_factors where person_id = $1", [P.other])).rows[0].provenance;
      expect(prov.factor).toMatchObject({ source: "entered", by: editor.id });
      expect(typeof prov.factor.at).toBe("string");
    });
  });

  it("an owner saves too", async () => {
    await db.as(owner.claims, async (c) => {
      expect(await saved(c, P.other, null, null, 1.3)).toEqual({ status: "saved", value: 1.3 });
    });
  });
});

describe("save_capacity_factor refuses everyone else", () => {
  it("a member (even on their own person), a viewer and a non-member get not_found and nothing changes", async () => {
    await db.client.query("insert into person_capacity_factors (person_id, workspace_id, step_id, factor) values ($1, $2, null, 1.1), ($3, $2, null, 1.2)", [P.other, ws, P.member]);
    for (const [who, person] of [[member, P.other], [member, P.member], [viewer, P.viewer], [viewer, P.other], [stranger, P.other]] as const) {
      await db.as(who.claims, async (c) => {
        expect((await save(c, person, STEP, null, 0.8)).rows[0].r, `${who.id} on ${person}`).toEqual({ status: "not_found" });
        expect((await save(c, person, null, 1.1, 1.9)).rows[0].r).toEqual({ status: "not_found" });
        expect((await save(c, person, null, 1.1, null)).rows[0].r).toEqual({ status: "not_found" });
      });
    }
    const rows = (await db.client.query("select person_id, step_id, factor::float8 as factor from person_capacity_factors order by factor")).rows;
    expect(rows).toEqual([
      { person_id: P.other, step_id: null, factor: 1.1 },
      { person_id: P.member, step_id: null, factor: 1.2 },
    ]);
    await db.client.query("delete from person_capacity_factors");
  });

  it("an API token (the MCP server) is refused with 42501, even through the function; nothing changes", async () => {
    await db.client.query("insert into person_capacity_factors (person_id, workspace_id, step_id, factor) values ($1, $2, null, 1.1)", [P.other, ws]);
    await db.as({ ...editor.claims, api_token_id: tokenId }, async (c) => {
      for (const [step, base, value] of [[STEP, null, 0.8], [null, 1.1, 1.4], [null, 1.1, null]] as const) {
        await c.query("savepoint s");
        await expect(save(c, P.other, step, base, value), `${step} ${value}`).rejects.toMatchObject({ code: "42501" });
        await c.query("rollback to savepoint s");
      }
      // Nor directly.
      await c.query("savepoint s");
      await expect(c.query("insert into person_capacity_factors (person_id, workspace_id, step_id, factor) values ($1, $2, $3, 1.2)", [P.other, ws, STEP])).rejects.toMatchObject({ code: "42501" });
      await c.query("rollback to savepoint s");
    });
    expect((await db.client.query("select factor::float8 as factor from person_capacity_factors")).rows).toEqual([{ factor: 1.1 }]);
    await db.client.query("delete from person_capacity_factors");
  });

  it("anon can't execute either function", async () => {
    await db.client.query("begin");
    try {
      await db.client.query("set local role anon");
      await db.client.query("savepoint a");
      await expect(save(db.client, P.other, null, null, 1)).rejects.toThrow(/permission denied/);
      await db.client.query("rollback to savepoint a");
      await expect(db.client.query("select public.save_capacity_factor_switch($1, '{\"capacity_factor_enabled\": null}', '{\"capacity_factor_enabled\": true}')", [ws])).rejects.toThrow(/permission denied/);
    } finally {
      await db.client.query("rollback");
    }
  });
});

describe("save_capacity_factor_switch", () => {
  const sw = (c: pg.Client, base: string, changes: string, w: string = ws) => c.query("select public.save_capacity_factor_switch($1, $2::jsonb, $3::jsonb) as r", [w, base, changes]);
  const swr = async (who: User, base: string, changes: string) => (await db.as(who.claims, (c) => sw(c, base, changes))).rows[0].r as { status: string; row?: { settings: Record<string, unknown> }; conflicts?: Record<string, unknown> };
  const raises = async (c: pg.Client, code: string, base: string, changes: string) => {
    await c.query("savepoint s");
    await expect(sw(c, base, changes), changes).rejects.toMatchObject({ code });
    await c.query("rollback to savepoint s");
  };

  it("an editor and an owner save true; the result carries the stored value", async () => {
    for (const who of [editor, owner]) {
      const r = await swr(who, '{"capacity_factor_enabled": null}', '{"capacity_factor_enabled": true}');
      expect(r).toMatchObject({ status: "saved", row: { settings: { capacity_factor_enabled: true } }, conflicts: {} });
    }
  });

  it("is stored, stamped as entered by the editor, and logged with them as the actor", async () => {
    await db.as(editor.claims, async (c) => {
      await sw(c, '{"capacity_factor_enabled": null}', '{"capacity_factor_enabled": true}');
      await c.query("reset role");
      const w = (await c.query("select settings, provenance from workspaces where id = $1", [ws])).rows[0];
      expect(w.settings.capacity_factor_enabled).toBe(true);
      expect(w.provenance["settings.capacity_factor_enabled"]).toMatchObject({ source: "entered", by: editor.id });
      const log = (await c.query("select actor_id, actor_kind, action, target_table from audit_log where created_at = now() and target_table = 'workspaces'")).rows;
      expect(log).toEqual([{ actor_id: editor.id, actor_kind: "user", action: "update", target_table: "workspaces" }]);
    });
  });

  it("a member, a viewer and a non-member get not_found", async () => {
    for (const who of [member, viewer, stranger]) {
      expect(await swr(who, '{"capacity_factor_enabled": null}', '{"capacity_factor_enabled": true}')).toEqual({ status: "not_found" });
    }
    expect((await db.client.query("select settings ? 'capacity_factor_enabled' as has from workspaces where id = $1", [ws])).rows[0].has).toBe(false);
  });

  it("any other key is refused (42501), a value that is not true, false or null is refused (23514), and the inputs are checked (22023)", async () => {
    await db.as(editor.claims, async (c) => {
      await raises(c, "42501", '{"name": "x"}', '{"name": "y"}');
      await raises(c, "42501", '{"capacity_factor_enabled": null, "currency": "x"}', '{"capacity_factor_enabled": true, "currency": "y"}');
      await raises(c, "42501", '{"floor": null}', '{"floor": 1}');
      for (const bad of ['"yes"', "1", "0", '"true"', "{}", "[]"]) await raises(c, "23514", '{"capacity_factor_enabled": null}', `{"capacity_factor_enabled": ${bad}}`);
      await raises(c, "22023", '{}', '{"capacity_factor_enabled": true}');
      await raises(c, "22023", '{"capacity_factor_enabled": null}', "{}");
      await raises(c, "22023", '[]', '{"capacity_factor_enabled": true}');
      await c.query("savepoint s");
      await expect(sw(c, '{"capacity_factor_enabled": null}', '{"capacity_factor_enabled": true}', randomUUID())).resolves.toMatchObject({ rows: [{ r: { status: "not_found" } }] });
      await c.query("rollback to savepoint s");
    });
    // The messages carry the function's prefix, as save_health_rules' do.
    await db.as(editor.claims, async (c) => {
      await c.query("savepoint s");
      await expect(sw(c, '{"capacity_factor_enabled": null}', '{"capacity_factor_enabled": "yes"}')).rejects.toThrow("save_capacity_factor_switch: capacity_factor_enabled must be true, false or null");
      await c.query("rollback to savepoint s");
    });
  });

  it("null and false are the same: a base of false against an absent key saves; a base of null against a stored false saves", async () => {
    // Absent key, base false: the stored (absent = off) equals the base, so the change to true saves.
    expect(await swr(editor, '{"capacity_factor_enabled": false}', '{"capacity_factor_enabled": true}')).toMatchObject({ status: "saved", row: { settings: { capacity_factor_enabled: true } } });
    await db.client.query("begin");
    try {
      await db.client.query("update workspaces set settings = settings || '{\"capacity_factor_enabled\": false}' where id = $1", [ws]);
      await db.client.query("set local role authenticated");
      await db.client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(editor.claims)]);
      const r = (await sw(db.client, '{"capacity_factor_enabled": null}', '{"capacity_factor_enabled": true}')).rows[0].r;
      expect(r).toMatchObject({ status: "saved", row: { settings: { capacity_factor_enabled: true } } });
    } finally {
      await db.client.query("rollback");
    }
    // Switching off with null from an absent key: nothing to write, saved, the key stays absent.
    const off = await swr(editor, '{"capacity_factor_enabled": null}', '{"capacity_factor_enabled": null}');
    expect(off).toMatchObject({ status: "saved", row: { settings: { capacity_factor_enabled: null } } });
    expect((await db.client.query("select settings ? 'capacity_factor_enabled' as has from workspaces where id = $1", [ws])).rows[0].has).toBe(false);
  });

  it("a stale base gives a conflict with the stored value and writes nothing", async () => {
    await db.client.query("begin");
    try {
      await db.client.query("update workspaces set settings = settings || '{\"capacity_factor_enabled\": true}' where id = $1", [ws]);
      await db.client.query("set local role authenticated");
      await db.client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(editor.claims)]);
      // We saw it off; someone switched it on; we ask for off.
      const r = (await sw(db.client, '{"capacity_factor_enabled": false}', '{"capacity_factor_enabled": false}')).rows[0].r;
      expect(r).toMatchObject({ status: "conflict", conflicts: { capacity_factor_enabled: true }, row: { settings: { capacity_factor_enabled: true } } });
      // We saw it on and ask for on: saved, nothing to write.
      const same = (await sw(db.client, '{"capacity_factor_enabled": true}', '{"capacity_factor_enabled": true}')).rows[0].r;
      expect(same).toMatchObject({ status: "saved" });
    } finally {
      await db.client.query("rollback");
    }
  });

  it("an API token is refused with 42501 (needs_review) even through the function", async () => {
    await db.as({ ...editor.claims, api_token_id: tokenId }, async (c) => {
      await raises(c, "42501", '{"capacity_factor_enabled": null}', '{"capacity_factor_enabled": true}');
    });
  });

  it("owner-only fields stay owner-only: an editor still can't save the workspace through save_fields", async () => {
    await db.as(editor.claims, async (c) => {
      const r = (await c.query("select public.save_fields('workspaces', $1::jsonb, $2::jsonb, $3::jsonb) as r", [JSON.stringify({ id: ws }), JSON.stringify({ capacity_factor_enabled: null }), JSON.stringify({ capacity_factor_enabled: true })])).rows[0].r;
      expect(r.status).toBe("not_found");
    });
  });
});

describe("the migration file", () => {
  it("states in its preflight the md5 of the body it replaces, and in its post-apply check the md5 of the body it installs", async () => {
    const sql = readFileSync(new URL(`../supabase/migrations/${FILE}`, import.meta.url), "utf8");
    const old = /Expect one row: t, f, ([0-9a-f]{32})/.exec(sql)![1]!;
    const next = /then team_capacity's new md5, ([0-9a-f]{32}):/.exec(sql)![1]!;
    expect(old).not.toBe(next);
    const md5 = async () => (await db.client.query("select md5(prosrc) as m from pg_proc where pronamespace = 'public'::regnamespace and proname = 'team_capacity'")).rows[0].m;
    expect(await md5()).toBe(next);
  });

  it("the header's rollback, run as written, leaves the old team_capacity (md5 as the preflight states) and nothing else of it behind", async () => {
    const own = await createTestDb();
    try {
      const sql = readFileSync(new URL(`../supabase/migrations/${FILE}`, import.meta.url), "utf8");
      const old = /Expect one row: t, f, ([0-9a-f]{32})/.exec(sql)![1]!;
      const q = async (text: string, params: unknown[] = []) => (await own.client.query(text, params)).rows;
      await q("create schema if not exists supabase_migrations");
      await q("create table if not exists supabase_migrations.schema_migrations (version text primary key, name text, statements text[])");
      await q("insert into supabase_migrations.schema_migrations (version, name) values ('20261223000000', 'capacity_factors') on conflict do nothing");
      const admin = (await createUser(own, "rb-admin@example.com", { agency_admin: true })).claims;
      // A factor, so the new key has something to show before the rollback.
      await q("insert into person_capacity_factors (person_id, workspace_id, step_id, factor) values ($1, $2, null, 1.2)", [P.other, ws]);
      const team = async () => own.as(admin, async (c) => (await c.query("select public.team_capacity($1) as t", [ws])).rows[0].t as Record<string, unknown>);
      const before = await team();
      expect(before.person_capacity_factors).toHaveLength(1);
      const rollback = headerRollback(FILE);
      expect(rollback).toMatch(/^begin;/);
      expect(rollback).toMatch(/commit;$/);
      await own.client.query(rollback);
      expect(await q("select to_regclass('public.person_capacity_factors') as t")).toEqual([{ t: null }]);
      expect(await q("select proname from pg_proc where proname in ('save_capacity_factor', 'save_capacity_factor_switch', 'share_links_no_speeds')")).toEqual([]);
      expect(await q("select tgname from pg_trigger where tgname = 'share_links_no_speeds'")).toEqual([]);
      expect(await q("select md5(prosrc) as m from pg_proc where pronamespace = 'public'::regnamespace and proname = 'team_capacity'")).toEqual([{ m: old }]);
      const after = await team();
      expect(after).not.toHaveProperty("person_capacity_factors");
      // Everything else it gave is unchanged (the same labels, the same order).
      const { person_capacity_factors: _gone, ...rest } = before;
      expect(after).toEqual(rest);
      expect(await q("select version from supabase_migrations.schema_migrations where version = '20261223000000'")).toEqual([]);
      // team_capacity keeps its grants.
      expect(await q("select has_function_privilege('authenticated', 'public.team_capacity(uuid)', 'execute') a, has_function_privilege('anon', 'public.team_capacity(uuid)', 'execute') b")).toEqual([{ a: true, b: false }]);
    } finally {
      await own.close();
    }
  }, 120_000);

  it("the apply file carries the migration twice (as SQL and as the statement row) and the rollback twice", () => {
    const apply = readFileSync(new URL(`../scripts/apply/${FILE}`, import.meta.url), "utf8");
    const migration = readFileSync(new URL(`../supabase/migrations/${FILE}`, import.meta.url), "utf8");
    expect(apply).toContain(`array[$mig$${migration.trimEnd()}\n$mig$]`);
    expect(apply).toContain("begin;\nset local lock_timeout");
    expect(apply.trimEnd().endsWith("commit;")).toBe(true);
    expect(apply).toContain("'20261223000000', 'capacity_factors'");
    expect(apply.split("--   delete from supabase_migrations.schema_migrations where version = '20261223000000';")).toHaveLength(3);
  });
});
