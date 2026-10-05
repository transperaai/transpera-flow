import { randomUUID } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NORTHBEAM_WORKSPACE_ID } from "../src";
import { createTestDb, createUser, type TestDb } from "./harness";

// The change-log entry for an uploaded process (issue #166, B13): `log_process_import` writes "Imported from <source>" for a
// process an import made, for someone who can edit it, once, and nothing else.

const ws = NORTHBEAM_WORKSPACE_ID;
let db: TestDb;
const users: Record<string, { id: string; claims: Record<string, unknown> }> = {};

beforeAll(async () => {
  db = await createTestDb();
  for (const role of ["editor", "viewer"] as const) {
    users[role] = await createUser(db, `${role}@log-import.example.com`);
    await db.client.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, $3)", [ws, users[role]!.id, role]);
  }
  users.stranger = await createUser(db, "stranger@log-import.example.com");
});

afterAll(async () => {
  await db?.close();
});

/** A process as an import leaves it: made by `by` (the editor unless said), `age` ago. */
const imported = async (source = "import", by: string | null = users.editor!.id, age = "0 seconds") =>
  (
    await db.client.query(
      "insert into processes (workspace_id, name, kind, entity_name, source, created_by, created_at) values ($1, $2, 'pipeline', 'lead', $3, $4, now() - $5::interval) returning id",
      [ws, `Uploaded ${randomUUID()}`, source, by, age],
    )
  ).rows[0].id as string;

/** The import entries for a process, read as the database owner (the change log is for managers; this is inside the test's transaction). */
const entries = async (c: pg.Client, id: string) => {
  await c.query("reset role");
  return (await c.query("select * from audit_log where target_table = 'processes' and target_id = $1 and action = 'import'", [id])).rows;
};

const log = (c: pg.Client, id: string, source: string) => c.query("select public.log_process_import($1, $2)", [id, source]);

const fails = async (c: pg.Client, run: () => Promise<unknown>, pattern: RegExp) => {
  await c.query("savepoint s");
  try {
    await expect(run()).rejects.toThrow(pattern);
  } finally {
    await c.query("rollback to savepoint s");
  }
};

describe("log_process_import", () => {
  it("writes one entry, as the user, naming where the process came from", async () => {
    const id = await imported();
    const rows = await db.as(users.editor!.claims, async (c) => {
      await log(c, id, "enquiry-to-client.json");
      return entries(c, id);
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ workspace_id: ws, actor_id: users.editor!.id, actor_kind: "user", diff: { source: "enquiry-to-client.json", text: "Imported from enquiry-to-client.json" } });
  });

  it("calls an API-token request an mcp one", async () => {
    const id = await imported();
    const rows = await db.as({ ...users.editor!.claims, api_token_id: randomUUID() }, async (c) => {
      await log(c, id, "https://example.com/page");
      return entries(c, id);
    });
    expect(rows[0].actor_kind).toBe("mcp");
  });

  it("refuses a second entry for the same import", async () => {
    const id = await imported();
    await db.as(users.editor!.claims, async (c) => {
      await log(c, id, "a.json");
      await fails(c, () => log(c, id, "b.json"), /already logged/);
    });
  });

  it("refuses a viewer, a stranger and a process that does not exist, all as 'no such process'", async () => {
    const id = await imported();
    for (const who of ["viewer", "stranger"]) {
      await db.as(users[who]!.claims, async (c) => {
        await fails(c, () => log(c, id, "a.json"), /no such process/);
      });
    }
    await db.as(users.editor!.claims, async (c) => {
      await fails(c, () => log(c, randomUUID(), "a.json"), /no such process/);
    });
    expect(await db.as(users.editor!.claims, (c) => entries(c, id))).toEqual([]);
  });

  it("refuses a process someone else made, and one made more than ten minutes ago", async () => {
    const theirs = await imported("import", users.viewer!.id);
    const old = await imported("import", users.editor!.id, "11 minutes");
    const fresh = await imported("import", users.editor!.id, "9 minutes");
    await db.as(users.editor!.claims, async (c) => {
      await fails(c, () => log(c, theirs, "a.json"), /no such process/);
      await fails(c, () => log(c, old, "a.json"), /no such process/);
      await log(c, fresh, "a.json");
      expect(await entries(c, fresh)).toHaveLength(1);
    });
  });

  it("refuses a process an import did not make, and an empty source", async () => {
    await db.as(users.editor!.claims, async (c) => {
      await fails(c, async () => log(c, await imported("manual"), "a.json"), /not made by an import/);
      const id = await imported();
      await fails(c, () => log(c, id, "   "), /say where/);
    });
  });

  it("cuts a long source to 300 characters, and is not callable by anon", async () => {
    const id = await imported();
    const rows = await db.as(users.editor!.claims, async (c) => {
      await log(c, id, "x".repeat(500));
      return entries(c, id);
    });
    expect(rows[0].diff.source).toHaveLength(300);
    const acl = (await db.client.query("select has_function_privilege('anon', 'public.log_process_import(uuid, text)', 'execute') as anon, has_function_privilege('authenticated', 'public.log_process_import(uuid, text)', 'execute') as auth")).rows[0];
    expect(acl).toEqual({ anon: false, auth: true });
  });
});
