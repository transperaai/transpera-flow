import { randomUUID } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NORTHBEAM_WORKSPACE_ID, northbeamClientIds, northbeamPersonIds, northbeamRoleIds, northbeamServiceIds } from "../src";
import { createTestDb, createUser, type TestDb } from "./harness";

// Roles as company-model facts (issue #88; docs/adr/0012-*): editors add,
// rename and deactivate them; one that steps, people or clients use can't be
// deleted; an API token can't write them (it suggests, and a person accepts).

let db: TestDb;
const users: Record<string, { id: string; claims: Record<string, unknown> }> = {};
const ws = NORTHBEAM_WORKSPACE_ID;
const sam = northbeamPersonIds["Sam Patel"]!;
const client = northbeamClientIds.c01!;

beforeAll(async () => {
  db = await createTestDb();
  for (const role of ["owner", "editor", "member", "viewer"] as const) {
    users[role] = await createUser(db, `${role}@roles.example.com`);
    await db.client.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, (case $3::text when 'editor' then 'owner' when 'member' then 'viewer' else $3::text end)::membership_role)", [ws, users[role]!.id, role]);
  }
  users.agency = await createUser(db, "agency@roles.example.com", { agency_admin: true });
});

afterAll(async () => {
  await db?.close();
});

interface SaveResult {
  status: "saved" | "conflict" | "not_found";
  row?: Record<string, unknown>;
  conflicts?: Record<string, unknown>;
}
const saveRole = async (c: pg.Client, id: string, base: object, changes: object): Promise<SaveResult> =>
  (
    await c.query("select public.save_fields('roles', $1::jsonb, $2::jsonb, $3::jsonb) as r", [
      JSON.stringify({ id }),
      JSON.stringify(base),
      JSON.stringify(changes),
    ])
  ).rows[0].r;

const addRole = async (c: pg.Client, name: string) =>
  (await c.query("insert into roles (workspace_id, name) values ($1, $2) returning id", [ws, name])).rows[0].id as string;

/** Run a statement that should fail without aborting the surrounding transaction. */
async function fails(c: pg.Client, sql: string, params: unknown[], code: string, message?: RegExp) {
  await c.query("savepoint attempt");
  let error: (Error & { code?: string }) | undefined;
  try {
    await c.query(sql, params);
  } catch (e) {
    error = e as Error & { code?: string };
  }
  await c.query("rollback to savepoint attempt");
  expect(error, sql).toBeDefined();
  expect(error!.code).toBe(code);
  if (message) expect(error!.message).toMatch(message);
}

const del = "delete from roles where id = $1";

describe("who can write roles", () => {
  for (const who of ["owner", "editor", "agency"]) {
    it(`${who} adds, renames, deactivates and reactivates a role`, async () => {
      await db.as(users[who]!.claims, async (c) => {
        const id = await addRole(c, "Copywriter");
        const row = (await c.query("select name, active, provenance from roles where id = $1", [id])).rows[0];
        expect(row).toEqual({ name: "Copywriter", active: true, provenance: {} });
        const renamed = await saveRole(c, id, { name: "Copywriter" }, { name: "Content writer" });
        expect(renamed.status).toBe("saved");
        expect(renamed.row).toMatchObject({ name: "Content writer" });
        expect((await saveRole(c, id, { active: true }, { active: false })).row).toMatchObject({ active: false });
        expect((await saveRole(c, id, { active: false }, { active: true })).row).toMatchObject({ active: true });
      });
    });
  }

  for (const who of ["member", "viewer"]) {
    it(`${who} can't add, change or delete a role`, async () => {
      await db.as(users[who]!.claims, async (c) => {
        await fails(c, "insert into roles (workspace_id, name) values ($1, 'Copywriter')", [ws], "42501", /row-level security/);
        expect((await saveRole(c, northbeamRoleIds.fin, { name: "Finance" }, { name: "Money" })).status).toBe("not_found");
        expect((await c.query(del, [northbeamRoleIds.fin])).rowCount).toBe(0);
      });
    });
  }

  it("a stale base is a conflict that carries the stored value", async () => {
    await db.as(users.editor!.claims, async (c) => {
      const r = await saveRole(c, northbeamRoleIds.fin, { name: "Accounts" }, { name: "Money" });
      expect(r.status).toBe("conflict");
      expect(r.conflicts).toEqual({ name: "Finance" });
    });
  });
});

describe("names", () => {
  it("are unique in a workspace, ignoring case and surrounding spaces, and never blank", async () => {
    await db.as(users.editor!.claims, async (c) => {
      await fails(c, "insert into roles (workspace_id, name) values ($1, ' finance ')", [ws], "23505");
      await fails(c, "insert into roles (workspace_id, name) values ($1, 'FINANCE')", [ws], "23505");
      await fails(c, "insert into roles (workspace_id, name) values ($1, '   ')", [ws], "23514");
      await fails(c, "insert into roles (workspace_id, name) values ($1, $2)", [ws, "x".repeat(201)], "23514");
      const id = await addRole(c, "Copywriter");
      await fails(c, "update roles set name = 'finance' where id = $1", [id], "23505");
    });
  });
});

describe("deleting a role", () => {
  it("works for one nothing uses", async () => {
    await db.as(users.editor!.claims, async (c) => {
      const id = await addRole(c, "Copywriter");
      expect((await c.query(del, [id])).rowCount).toBe(1);
    });
  });

  it("fails while people hold it, and cascades nothing", async () => {
    await db.as(users.editor!.claims, async (c) => {
      const id = await addRole(c, "Copywriter");
      await c.query("insert into person_roles (person_id, role_id, workspace_id) values ($1, $2, $3)", [sam, id, ws]);
      await fails(c, del, [id], "23503", /still used/);
      expect((await c.query("select count(*)::int as n from person_roles where role_id = $1", [id])).rows[0].n).toBe(1);
      // Finance is held by people in the seed too.
      const held = (await c.query("select count(*)::int as n from person_roles where role_id = $1", [northbeamRoleIds.fin])).rows[0].n;
      if (held > 0) await fails(c, del, [northbeamRoleIds.fin], "23503", /still used/);
    });
  });

  it("fails while a client assignment names it", async () => {
    await db.as(users.editor!.claims, async (c) => {
      const id = await addRole(c, "Copywriter");
      await c.query("insert into client_assignments (client_id, role_id, person_id, workspace_id) values ($1, $2, $3, $4)", [client, id, sam, ws]);
      await fails(c, del, [id], "23503", /still used/);
      expect((await c.query("select count(*)::int as n from client_assignments where role_id = $1", [id])).rows[0].n).toBe(1);
    });
  });

  it("fails while a step in a draft or superseded revision names it", async () => {
    await db.as(users.editor!.claims, async (c) => {
      const id = await addRole(c, "Copywriter");
      const proc = (
        await c.query("insert into processes (workspace_id, name, kind, entity_name) values ($1, 'Quarterly review', 'servicing', 'review') returning id", [ws])
      ).rows[0].id;
      const draft = (await c.query("select public.open_draft($1) as r", [proc])).rows[0].r;
      expect(draft.status).toBe("ok");
      await c.query("insert into steps (revision_id, workspace_id, process_id, name, kind, role_id) values ($1, $2, $3, 'Write copy', 'task', $4)", [
        draft.revision_id,
        ws,
        proc,
        id,
      ]);
      await fails(c, del, [id], "23503", /still used/);
      // Once the draft is gone the role can go.
      await c.query("delete from steps where role_id = $1", [id]);
      expect((await c.query(del, [id])).rowCount).toBe(1);
    });
  });

  it("fails while a service's fallback load names it", async () => {
    await db.as(users.editor!.claims, async (c) => {
      const id = await addRole(c, "Copywriter");
      await c.query("update services set fallback_ongoing_load = $2::jsonb where id = $1", [northbeamServiceIds.seo, JSON.stringify({ [id]: 2 })]);
      await fails(c, del, [id], "23503", /still used/);
    });
  });

  it("deleting the workspace still cascades all of its roles", async () => {
    const wsId = randomUUID();
    await db.client.query("insert into workspaces (id, name, slug) values ($1, 'Doomed', 'doomed')", [wsId]);
    const a = (await db.client.query("insert into roles (workspace_id, name) values ($1, 'A') returning id", [wsId])).rows[0].id;
    await db.client.query("insert into roles (workspace_id, name) values ($1, 'B')", [wsId]);
    const p = (await db.client.query("insert into people (workspace_id, name) values ($1, 'Pat') returning id", [wsId])).rows[0].id;
    await db.client.query("insert into person_roles (person_id, role_id, workspace_id) values ($1, $2, $3)", [p, a, wsId]);
    // A direct delete of the used role is refused, even as a superuser ...
    await expect(db.client.query(del, [a])).rejects.toThrow(/still used/);
    // ... but the workspace goes, and takes everything with it.
    await db.client.query("delete from workspaces where id = $1", [wsId]);
    expect((await db.client.query("select count(*)::int as n from roles where workspace_id = $1", [wsId])).rows[0].n).toBe(0);
  });
});

describe("API tokens", () => {
  const useClaims = (c: pg.Client, claims: Record<string, unknown>) =>
    c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
  const token = () => ({ ...users.editor!.claims, api_token_id: randomUUID() });

  it("can't insert, update or delete roles, though the same editor can", async () => {
    await db.as(users.editor!.claims, async (c) => {
      const spare = await addRole(c, "Spare"); // unused, so the in-use guard doesn't answer first
      const writes: [string, unknown[]][] = [
        ["insert into roles (workspace_id, name) values ($1, 'Copywriter')", [ws]],
        ["update roles set headcount = 3 where id = $1", [northbeamRoleIds.seo]],
        [del, [spare]],
      ];
      for (const [sql, params] of writes) {
        await useClaims(c, token());
        await fails(c, sql, params, "42501", /only by review/);
        await useClaims(c, users.editor!.claims);
        await c.query("savepoint ok");
        expect((await c.query(sql, params)).rowCount, sql).toBe(1);
        await c.query("rollback to savepoint ok");
      }
    });
  });

  it("a token's delete of a role in use is refused as in use, not as unreviewed", async () => {
    await db.as(token(), (c) => fails(c, del, [northbeamRoleIds.seo], "23503", /still used/));
  });
});

describe("audit", () => {
  it("logs a role insert with the user as actor", async () => {
    await db.as(users.editor!.claims, async (c) => {
      const id = await addRole(c, "Copywriter");
      await c.query("reset role");
      const rows = (await c.query("select actor_id, actor_kind, action from audit_log where target_table = 'roles' and target_id = $1", [id])).rows;
      expect(rows).toEqual([{ actor_id: users.editor!.id, actor_kind: "user", action: "insert" }]);
    });
  });
});
