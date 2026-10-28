import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, createUser, type TestDb } from "./harness";

// Client branding (issue #34, B5, migration 20261214000000): `workspaces.branding` with its shape check, saving through
// `save_fields`, and the audit entry. The logo guard, the `branding` bucket's policies and the `logo_path` key went with
// migration 20261230000000 (step 4): the logo is a row of `workspace_logos`, tested in workspace-logos.test.ts.

type Claims = Record<string, unknown>;
interface User {
  id: string;
  claims: Claims;
}

let db: TestDb;
let ws = "";
let other = "";
const users: Record<string, User> = {};
const q = async (sql: string, params: unknown[] = []) => (await db.client.query(sql, params)).rows;

/** Run `fn` as a role with claims, in a transaction that is committed (or rolled back when it throws). */
async function as<T>(claims: Claims | null, fn: (c: pg.Client) => Promise<T>, role = "authenticated"): Promise<T> {
  await db.client.query("begin");
  try {
    await db.client.query(`set local role ${role}`);
    await db.client.query("select set_config('request.jwt.claims', $1, true)", [claims ? JSON.stringify(claims) : ""]);
    const out = await fn(db.client);
    await db.client.query("commit");
    return out;
  } catch (err) {
    await db.client.query("rollback");
    throw err;
  }
}

async function refused(run: Promise<unknown>, code: string, why: RegExp) {
  const err = (await run.then(
    () => null,
    (e: unknown) => e,
  )) as { code?: string; message?: string } | null;
  expect(err, "expected the statement to be refused").not.toBeNull();
  expect({ code: err!.code, message: err!.message }).toEqual({ code, message: expect.stringMatching(why) });
}

const logo = (workspace: string, ext = "png") => `${workspace}/${randomUUID()}.${ext}`;
/** Set `branding` as the superuser (no JWT: the guard passes). */
const set = (workspace: string, branding: unknown) => q("update workspaces set branding = $2::jsonb where id = $1", [workspace, JSON.stringify(branding)]);

interface SaveResult {
  status: "saved" | "conflict" | "not_found";
  row?: Record<string, unknown>;
}
const saveFields = async (c: pg.Client, key: object, base: object, changes: object): Promise<SaveResult> =>
  (await c.query("select public.save_fields('workspaces', $1::jsonb, $2::jsonb, $3::jsonb) as r", [JSON.stringify(key), JSON.stringify(base), JSON.stringify(changes)])).rows[0].r;

beforeAll(async () => {
  db = await createTestDb({ supabaseDefaultPrivileges: true });
  [{ id: ws }] = await q("insert into workspaces (name, slug) values ('Brand Co', 'brand-co') returning id");
  [{ id: other }] = await q("insert into workspaces (name, slug) values ('Other Brand Co', 'other-brand-co') returning id");
  const roles = ["owner", "editor", "member", "viewer", "agency_member"] as const;
  for (const role of roles) users[role] = await createUser(db, `${role}@branding.example.com`);
  users.flag = await createUser(db, "flag@branding.example.com", { agency_admin: true });
  users.stranger = await createUser(db, "stranger@branding.example.com");
  users.otherOwner = await createUser(db, "other-owner@branding.example.com");
  const memberships: [string, string, string][] = [
    [ws, users.owner!.id, "owner"],
    [ws, users.editor!.id, "editor"],
    [ws, users.member!.id, "member"],
    [ws, users.viewer!.id, "viewer"],
    [ws, users.agency_member!.id, "agency_admin"],
    [other, users.otherOwner!.id, "owner"],
  ];
  for (const m of memberships) await q("insert into memberships (workspace_id, user_id, role) values ($1, $2, $3)", m);
});

afterAll(async () => {
  await db?.close();
});

describe("the column", () => {
  it("is jsonb, not null, default {}, and every workspace starts unbranded", async () => {
    expect(await q("select data_type, is_nullable, column_default from information_schema.columns where table_schema = 'public' and table_name = 'workspaces' and column_name = 'branding'")).toEqual([
      { data_type: "jsonb", is_nullable: "NO", column_default: "'{}'::jsonb" },
    ]);
    expect(await q("select count(*)::int n from workspaces where branding <> '{}'::jsonb")).toEqual([{ n: 0 }]);
    expect(await q("select count(*)::int n from workspaces")).not.toEqual([{ n: 0 }]);
    expect(await q("select convalidated from pg_constraint where conname = 'workspaces_branding_shape'")).toEqual([{ convalidated: true }]);
  });
});

describe("the shape check", () => {
  it("accepts {}, an accent, and a dark accent with a null accent", async () => {
    await set(ws, {});
    await set(ws, { accent: "#0b6e8a" });
    await set(ws, { accent: null, accent_dark: "#aabbcc" });
    await set(ws, { accent: "#0b6e8a", accent_dark: null });
    await set(ws, {});
  });

  it("refuses bad hex, a wrong type, an unknown key, a non-object, and a logo_path (the logo is in workspace_logos now)", async () => {
    const bad: unknown[] = [
      { accent: "#FFF" },
      { accent: "#abc" },
      { accent: "#ABCDEF" },
      { accent: "0b6e8a" },
      { accent: 5 },
      { accent_dark: "#12345g" },
      { accent_dark: ["#aabbcc"] },
      { color: "#aabbcc" },
      { report_colors: [] },
      [],
      "x",
      5,
      null,
      { logo_path: 5 },
      { logo_path: logo(ws) },
      { logo_path: logo(other) },
      { logo_path: logo(ws, "svg") },
      { logo_path: `${ws}/x/${randomUUID()}.png` },
      { logo_path: `${ws}/not-a-uuid.png` },
      { logo_path: `${ws}/${randomUUID()}.PNG` },
      { logo_path: `${ws}/${randomUUID()}.gif` },
    ];
    for (const value of bad) {
      await refused(q("update workspaces set branding = $2::jsonb where id = $1", [ws, JSON.stringify(value)]), "23514", /workspaces_branding_shape|violates check/);
    }
    expect(await q("select branding from workspaces where id = $1", [ws])).toEqual([{ branding: {} }]);
  });
});

describe("saving through save_fields", () => {
  const save = (claims: Claims, accent = "#0b6e8a") => as(claims, (c) => saveFields(c, { id: ws }, { "branding.accent": null }, { "branding.accent": accent }));

  it("owners and agency admins save it (JWT flag and membership)", async () => {
    for (const who of ["owner", "agency_member", "flag"]) {
      await set(ws, {});
      const r = await save(users[who]!.claims);
      expect(r.status, who).toBe("saved");
      expect(await q("select branding from workspaces where id = $1", [ws]), who).toEqual([{ branding: { accent: "#0b6e8a" } }]);
    }
    await set(ws, {});
  });

  it("an editor, member, viewer and stranger find nothing", async () => {
    for (const who of ["editor", "member", "viewer", "stranger", "otherOwner"]) {
      expect((await save(users[who]!.claims)).status, who).toBe("not_found");
    }
    expect(await q("select branding from workspaces where id = $1", [ws])).toEqual([{ branding: {} }]);
  });

  it("saves the dark accent, and refuses a version clash", async () => {
    await as(users.owner!.claims, async (c) => {
      expect((await saveFields(c, { id: ws }, { "branding.accent_dark": null }, { "branding.accent_dark": "#4cc3e0" })).status).toBe("saved");
      expect(await saveFields(c, { id: ws }, { "branding.accent_dark": null }, { "branding.accent_dark": "#aabbcc" })).toMatchObject({ status: "conflict" });
    });
    await set(ws, {});
  });

  it("refuses a bad value at the check (the app has already refused contrast; Postgres checks the shape only)", async () => {
    await refused(save(users.owner!.claims, "#ABC"), "23514", /workspaces_branding_shape|violates check/);
    // A low-contrast accent is allowed in the database: the app refuses it at save time and ignores it at render time (Q11).
    expect((await save(users.owner!.claims, "#ffff00")).status).toBe("saved");
    await set(ws, {});
  });

  it("an MCP caller (an API token) is refused by the needs_review trigger", async () => {
    await refused(save({ ...users.owner!.claims, api_token_id: randomUUID() }), "42501", /company model can't be changed through an API token/);
    expect(await q("select branding from workspaces where id = $1", [ws])).toEqual([{ branding: {} }]);
  });

  it("writes an audit_log row for the workspace naming the actor", async () => {
    await save(users.owner!.claims, "#123456");
    const rows = await q("select actor_id, actor_kind, action, diff from audit_log where target_table = 'workspaces' and diff::text like '%#123456%' order by created_at");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor_id: users.owner!.id, actor_kind: "user", action: "update" });
    expect(rows[0].diff.new.branding).toEqual({ accent: "#123456" });
    expect(rows[0].diff.old.branding).toEqual({});
    await set(ws, {});
  });
});

describe("the apply file of the migration", () => {
  it("carries the rollback twice (header and statement) and the same migration", () => {
    const FILE = "20261214000000_client_branding.sql";
    const apply = readFileSync(new URL("../scripts/apply/20261214000000_client_branding.sql", import.meta.url), "utf8");
    const migration = readFileSync(new URL(`../migrations/${FILE}`, import.meta.url), "utf8");
    const del = "--   delete from supabase_migrations.schema_migrations where version = '20261214000000';";
    expect(apply.split(del)).toHaveLength(3);
    expect(apply).toContain(`array[$mig$${migration.trimEnd()}\n$mig$]`);
  });
});
