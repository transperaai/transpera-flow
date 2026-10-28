import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NORTHBEAM_PROCESS_ID, NORTHBEAM_WORKSPACE_ID, northbeamStepIds } from "../src";
import { createTestDb, createUser, type TestDb } from "./harness";

// Per-field saves under concurrency (docs/adr/0001-per-field-saves.md): two
// editors saving the same step at once through save_fields on two
// connections, as two browsers would. The database refuses a stale base.

let db: TestDb;
const users: Record<string, { id: string; claims: Record<string, unknown> }> = {};
const ws = NORTHBEAM_WORKSPACE_ID;
const proc = NORTHBEAM_PROCESS_ID;
const ids = northbeamStepIds;

type Reply = Record<string, unknown> & { status: string };

async function commitAs<T>(claims: Record<string, unknown>, fn: (c: pg.Client) => Promise<T>, client: pg.Client = db.client): Promise<T> {
  await client.query("begin");
  try {
    await client.query("set local role authenticated");
    await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
    const out = await fn(client);
    await client.query("commit");
    return out;
  } catch (err) {
    await client.query("rollback");
    throw err;
  }
}

const saveFields = async (c: pg.Client, revision: string, id: string, base: object, changes: object): Promise<Reply> =>
  (
    await c.query("select public.save_fields('steps', $1, $2, $3) as r", [
      JSON.stringify({ revision_id: revision, id }),
      JSON.stringify(base),
      JSON.stringify(changes),
    ])
  ).rows[0].r as Reply;

beforeAll(async () => {
  db = await createTestDb();
  for (const [name, role] of [
    ["tom", "editor"],
    ["ana", "editor"],
  ] as const) {
    users[name] = await createUser(db, `${name}@concurrent.example.com`);
    await db.client.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, (case $3::text when 'editor' then 'owner' when 'member' then 'viewer' else $3::text end)::membership_role)", [ws, users[name]!.id, role]);
  }
});

afterAll(async () => {
  await db?.close();
});

describe("two editors on one step at once", () => {
  let draft: string;
  let tom: pg.Client;
  let ana: pg.Client;

  beforeAll(async () => {
    tom = new pg.Client({ connectionString: db.url });
    ana = new pg.Client({ connectionString: db.url });
    await Promise.all([tom.connect(), ana.connect()]);
    const opened = await commitAs(users.tom!.claims, (c) => c.query("select public.open_draft($1) as r", [proc]), tom);
    draft = (opened.rows[0].r as Reply).revision_id as string;
  });

  afterAll(async () => {
    await Promise.all([tom?.end(), ana?.end()]);
  });

  const stored = async (fields: string) => (await db.client.query(`select ${fields} from steps where revision_id = $1 and id = $2`, [draft, ids.audit])).rows[0];

  it("keeps both when they change different fields", async () => {
    // Both loaded the step as it is live, then saved at the same moment.
    const [a, b] = await Promise.all([
      commitAs(users.tom!.claims, (c) => saveFields(c, draft, ids.audit, { work_hours: 6 }, { work_hours: 4 }), tom),
      commitAs(users.ana!.claims, (c) => saveFields(c, draft, ids.audit, { name: "Audit & proposal" }, { name: "Audit" }), ana),
    ]);
    expect([a.status, b.status]).toEqual(["saved", "saved"]);
    expect(await stored("name, work_hours::float8 as work_hours")).toEqual({ name: "Audit", work_hours: 4 });
  });

  it("reports the second save of the same field as a conflict with what is stored, and 'keep mine' then persists", async () => {
    const [a, b] = await Promise.all([
      commitAs(users.tom!.claims, (c) => saveFields(c, draft, ids.audit, { wait_hours: 0 }, { wait_hours: 4 }), tom),
      commitAs(users.ana!.claims, (c) => saveFields(c, draft, ids.audit, { wait_hours: 0 }, { wait_hours: 8 }), ana),
    ]);
    // Row locks serialise them: whichever ran second sees the other's value.
    const [first, second] = a.status === "saved" ? [{ r: a, v: 4 }, { r: b, v: 8, who: users.ana! }] : [{ r: b, v: 8 }, { r: a, v: 4, who: users.tom! }];
    expect(first.r.status).toBe("saved");
    expect(second.r).toMatchObject({ status: "conflict", conflicts: { wait_hours: first.v } });
    expect((await stored("wait_hours::float8 as w")).w).toBe(first.v);

    // Keep mine: the same save again, against what is stored now.
    const again = await commitAs(second.who.claims, (c) => saveFields(c, draft, ids.audit, { wait_hours: first.v }, { wait_hours: second.v }));
    expect(again.status).toBe("saved");
    expect((await stored("wait_hours::float8 as w")).w).toBe(second.v);
  });

  it("'keep theirs' writes nothing, so what the other editor saved stays", async () => {
    const tomSave = await commitAs(users.tom!.claims, (c) => saveFields(c, draft, ids.audit, { tool: "SEMrush, Google Docs" }, { tool: "HubSpot" }), tom);
    expect(tomSave.status).toBe("saved");
    const anaSave = await commitAs(users.ana!.claims, (c) => saveFields(c, draft, ids.audit, { tool: "SEMrush, Google Docs" }, { tool: "Notion" }), ana);
    expect(anaSave).toMatchObject({ status: "conflict", conflicts: { tool: "HubSpot" } });
    expect((await stored("tool")).tool).toBe("HubSpot");
  });
});
