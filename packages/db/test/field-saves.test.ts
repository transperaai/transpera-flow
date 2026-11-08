import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NORTHBEAM_WORKSPACE_ID, northbeamPersonIds, northbeamRoleIds, northbeamStepIds } from "../src";
import { createTestDb, createUser, type TestDb } from "./harness";

// Per-field saves with a version check (docs/adr/0001-per-field-saves.md) and
// the people write paths they guard, all run as the signed-in user under RLS.

let db: TestDb;
const users: Record<string, { id: string; claims: Record<string, unknown> }> = {};
const ws = NORTHBEAM_WORKSPACE_ID;
const priya = northbeamPersonIds["Priya Shah"]!;
const tom = northbeamPersonIds["Tom Reed"]!;

beforeAll(async () => {
  db = await createTestDb();
  for (const role of ["owner", "editor", "member", "viewer"] as const) {
    users[role] = await createUser(db, `${role}@fields.example.com`);
    await db.client.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, (case $3::text when 'editor' then 'owner' when 'member' then 'viewer' else $3::text end)::membership_role)", [
      ws,
      users[role]!.id,
      role,
    ]);
  }
  users.agency = await createUser(db, "agency@fields.example.com", { agency_admin: true });
  users.stranger = await createUser(db, "stranger@fields.example.com");
});

afterAll(async () => {
  await db?.close();
});

interface SaveResult {
  status: "saved" | "conflict" | "not_found";
  row?: Record<string, unknown>;
  conflicts?: Record<string, unknown>;
  members?: string[];
}

const saveFields = async (
  c: pg.Client,
  target: string,
  key: object,
  base: object,
  changes: object,
): Promise<SaveResult> =>
  (
    await c.query("select public.save_fields($1, $2::jsonb, $3::jsonb, $4::jsonb) as r", [
      target,
      JSON.stringify(key),
      JSON.stringify(base),
      JSON.stringify(changes),
    ])
  ).rows[0].r;

const saveLinks = async (
  c: pg.Client,
  target: string,
  owner: object,
  member: string,
  base: string[],
  next: string[],
): Promise<SaveResult> =>
  (
    await c.query("select public.save_links($1, $2::jsonb, $3, $4::jsonb, $5::jsonb) as r", [
      target,
      JSON.stringify(owner),
      member,
      JSON.stringify(base),
      JSON.stringify(next),
    ])
  ).rows[0].r;

const person = async (c: pg.Client, id: string) =>
  (await c.query("select name, fte::float8 as fte, cost_rate::float8 as cost_rate, active from people where id = $1", [id]))
    .rows[0];

describe("save_fields", () => {
  it("saves a field for an editor and returns the stored row", async () => {
    await db.as(users.editor!.claims, async (c) => {
      const r = await saveFields(c, "people", { id: priya }, { name: "Priya Shah" }, { name: "Priya S." });
      expect(r.status).toBe("saved");
      expect(r.row).toMatchObject({ id: priya, name: "Priya S." });
      expect(r.conflicts).toEqual({});
      expect((await person(c, priya)).name).toBe("Priya S.");
    });
  });

  it("merges edits to different fields of the same row", async () => {
    await db.as(users.editor!.claims, async (c) => {
      // Two people opened the form with the same values; each edits one field.
      expect((await saveFields(c, "people", { id: priya }, { name: "Priya Shah" }, { name: "Priya S." })).status).toBe(
        "saved",
      );
      expect((await saveFields(c, "people", { id: priya }, { fte: 1 }, { fte: 0.8 })).status).toBe("saved");
      expect(await person(c, priya)).toMatchObject({ name: "Priya S.", fte: 0.8 });
    });
  });

  it("reports a same-field conflict without writing, and 'keep mine' saves on the second try", async () => {
    await db.as(users.editor!.claims, async (c) => {
      await saveFields(c, "people", { id: priya }, { cost_rate: null }, { cost_rate: 40 });
      const clash = await saveFields(c, "people", { id: priya }, { cost_rate: null }, { cost_rate: 55 });
      expect(clash.status).toBe("conflict");
      expect(clash.conflicts).toEqual({ cost_rate: 40 });
      expect((await person(c, priya)).cost_rate).toBe(40);

      // Keep mine: resubmit against the value we were shown.
      const mine = await saveFields(c, "people", { id: priya }, { cost_rate: 40 }, { cost_rate: 55 });
      expect(mine.status).toBe("saved");
      expect((await person(c, priya)).cost_rate).toBe(55);
    });
  });

  it("saves the fields that don't clash and reports the ones that do", async () => {
    await db.as(users.editor!.claims, async (c) => {
      await saveFields(c, "people", { id: tom }, { name: "Tom Reed" }, { name: "Thomas Reed" });
      const r = await saveFields(c, "people", { id: tom }, { name: "Tom Reed", fte: 1 }, { name: "T. Reed", fte: 0.5 });
      expect(r.status).toBe("conflict");
      expect(r.conflicts).toEqual({ name: "Thomas Reed" });
      expect(await person(c, tom)).toMatchObject({ name: "Thomas Reed", fte: 0.5 });
    });
  });

  it("treats a repeated save as already done, and compares values by column type", async () => {
    await db.as(users.editor!.claims, async (c) => {
      expect((await saveFields(c, "people", { id: tom }, { fte: "1.0" }, { fte: 0.6 })).status).toBe("saved");
      expect((await saveFields(c, "people", { id: tom }, { fte: 1 }, { fte: "0.60" })).status).toBe("saved");
      expect((await person(c, tom)).fte).toBe(0.6);
    });
  });

  it("lets agency admins and owners save, but not members, viewers or strangers", async () => {
    for (const role of ["agency", "owner"]) {
      await db.as(users[role]!.claims, async (c) => {
        expect((await saveFields(c, "people", { id: priya }, { active: true }, { active: false })).status).toBe("saved");
      });
    }
    for (const role of ["member", "viewer", "stranger"]) {
      await db.as(users[role]!.claims, async (c) => {
        expect(await saveFields(c, "people", { id: priya }, { active: true }, { active: false })).toEqual({
          status: "not_found",
        });
      });
    }
    expect((await db.client.query("select active from people where id = $1", [priya])).rows[0].active).toBe(true);
  });

  it("refuses keys, ownership and audit columns, tables outside the allow-list, and missing bases", async () => {
    const attempts: [string, object, object, object, RegExp][] = [
      ["people", { id: priya }, { workspace_id: ws }, { workspace_id: ws }, /cannot be saved/],
      ["people", { id: priya }, { id: priya }, { id: tom }, /cannot be saved/],
      ["people", { id: priya }, { created_by: null }, { created_by: null }, /cannot be saved/],
      ["people", { id: priya }, { nope: 1 }, { nope: 2 }, /cannot be saved/],
      ["people", { id: priya }, {}, { name: "X" }, /no base value/],
      ["memberships", { id: priya }, { role: "viewer" }, { role: "owner" }, /not editable/],
      ["people", { id: priya }, { name: "Priya Shah" }, {}, /non-empty/],
    ];
    for (const [target, key, base, changes, error] of attempts) {
      await expect(db.as(users.editor!.claims, (c) => saveFields(c, target, key, base, changes))).rejects.toThrow(error);
    }
  });

  it("keeps every editable table in the allow-list once all migrations have run", async () => {
    // Several migrations redefine save_fields; the last one applied wins, so its
    // list must be the union. Keep in sync with `EditableTable` in apps/web.
    const editable = [
      "workspaces",
      "roles",
      "people",
      "person_leave",
      "processes",
      "steps",
      "edges",
      "services",
      "lead_sources",
      "seasonality",
      "demand_settings",
      "issues",
      "sources",
      "clients",
      "client_assignments",
      "service_servicing",
    ];
    for (const target of editable) {
      const outcome = await db
        .as(users.editor!.claims, (c) => saveFields(c, target, { id: priya }, { nope: 1 }, { nope: 2 }))
        .then(
          () => "ok",
          (e: Error) => e.message,
        );
      expect(outcome, target).not.toMatch(/not editable/);
    }
  });

  it("enforces the table's check constraints", async () => {
    await expect(
      db.as(users.editor!.claims, (c) => saveFields(c, "people", { id: priya }, { fte: 1 }, { fte: 3 })),
    ).rejects.toThrow(/check constraint/);
  });

  it("saves one key of a jsonb column, leaving the others alone", async () => {
    await db.as(users.owner!.claims, async (c) => {
      const r = await saveFields(
        c,
        "workspaces",
        { id: ws },
        { "settings.availability_floor": null },
        { "settings.availability_floor": 0.1 },
      );
      expect(r.status).toBe("saved");
      const settings = (await c.query("select settings from workspaces where id = $1", [ws])).rows[0].settings;
      expect(settings).toMatchObject({ availability_floor: 0.1, hours_per_week: 40, currency: "GBP" });

      const clash = await saveFields(
        c,
        "workspaces",
        { id: ws },
        { "settings.availability_floor": null },
        { "settings.availability_floor": 0.2 },
      );
      expect(clash).toMatchObject({ status: "conflict", conflicts: { "settings.availability_floor": 0.1 } });
    });
  });

  it("leaves workspace settings to Agency admins: a viewer's save finds nothing", async () => {
    await db.as(users.viewer!.claims, async (c) => {
      const r = await saveFields(
        c,
        "workspaces",
        { id: ws },
        { "settings.availability_floor": null },
        { "settings.availability_floor": 0.1 },
      );
      expect(r.status).toBe("not_found");
    });
  });

  it("is not callable by anon", async () => {
    await db.client.query("begin");
    try {
      await db.client.query("set local role anon");
      await expect(
        db.client.query("select public.save_fields('people', '{}', '{}', '{}')"),
      ).rejects.toThrow(/permission denied/);
    } finally {
      await db.client.query("rollback");
    }
  });
});

describe("save_links", () => {
  const owner = { person_id: priya, workspace_id: ws };
  const roles = async (c: pg.Client) =>
    (await c.query("select role_id from person_roles where person_id = $1 order by role_id", [priya])).rows.map(
      (r) => r.role_id as string,
    );

  it("replaces a person's roles when nobody else changed them", async () => {
    await db.as(users.editor!.claims, async (c) => {
      const next = [northbeamRoleIds.sales, northbeamRoleIds.am].sort();
      const r = await saveLinks(c, "person_roles", owner, "role_id", [northbeamRoleIds.sales], next);
      expect(r).toEqual({ status: "saved", members: next });
      expect(await roles(c)).toEqual(next);

      const r2 = await saveLinks(c, "person_roles", owner, "role_id", next, [northbeamRoleIds.am]);
      expect(r2.status).toBe("saved");
      expect(await roles(c)).toEqual([northbeamRoleIds.am]);
    });
  });

  it("reports a conflict when the set changed underneath, and accepts a matching retry", async () => {
    await db.as(users.editor!.claims, async (c) => {
      await saveLinks(c, "person_roles", owner, "role_id", [northbeamRoleIds.sales], [northbeamRoleIds.fin]);
      const clash = await saveLinks(c, "person_roles", owner, "role_id", [northbeamRoleIds.sales], [northbeamRoleIds.am]);
      expect(clash).toEqual({ status: "conflict", members: [northbeamRoleIds.fin] });
      expect(await roles(c)).toEqual([northbeamRoleIds.fin]);

      const retry = await saveLinks(c, "person_roles", owner, "role_id", [northbeamRoleIds.sales], [northbeamRoleIds.fin]);
      expect(retry.status).toBe("saved");
    });
  });

  it("saves skills", async () => {
    await db.as(users.editor!.claims, async (c) => {
      const r = await saveLinks(c, "person_skills", owner, "step_id", [], [northbeamStepIds.qualify]);
      expect(r.status).toBe("saved");
      const rows = (await c.query("select step_id from person_skills where person_id = $1", [priya])).rows;
      expect(rows).toEqual([{ step_id: northbeamStepIds.qualify }]);
    });
  });

  it("lets only editors and up change sets", async () => {
    for (const role of ["member", "viewer", "stranger"]) {
      await db.as(users[role]!.claims, async (c) => {
        const r = await saveLinks(c, "person_roles", owner, "role_id", [northbeamRoleIds.sales], []);
        expect(r.status).toBe("not_found");
      });
    }
    expect((await db.client.query("select count(*)::int as n from person_roles where person_id = $1", [priya])).rows[0].n).toBe(1);
  });

  it("refuses tables and columns outside the allow-list", async () => {
    await expect(
      db.as(users.editor!.claims, (c) => saveLinks(c, "memberships", owner, "user_id", [], [])),
    ).rejects.toThrow(/not an editable set/);
    await expect(
      db.as(users.editor!.claims, (c) => saveLinks(c, "person_roles", owner, "workspace_id", [], [])),
    ).rejects.toThrow(/not an editable set/);
  });
});

describe("people write access", () => {
  const insertPerson = (c: pg.Client, workspace: string) =>
    c.query("insert into people (workspace_id, name, fte) values ($1, 'New hire', 0.5) returning id", [workspace]);

  it("lets editors and owners add people with roles and leave", async () => {
    for (const role of ["editor", "owner", "agency"]) {
      await db.as(users[role]!.claims, async (c) => {
        const id = (await insertPerson(c, ws)).rows[0].id as string;
        await c.query("insert into person_roles (person_id, role_id, workspace_id) values ($1, $2, $3)", [
          id,
          northbeamRoleIds.seo,
          ws,
        ]);
        await c.query(
          "insert into person_leave (person_id, workspace_id, start_date, end_date) values ($1, $2, '2026-12-21', '2026-12-31')",
          [id, ws],
        );
        const deleted = await c.query("delete from person_leave where person_id = $1", [id]);
        expect(deleted.rowCount).toBe(1);
      });
    }
  });

  it("stops members and viewers adding people or leave", async () => {
    for (const role of ["member", "viewer"]) {
      await expect(db.as(users[role]!.claims, (c) => insertPerson(c, ws))).rejects.toThrow(/row-level security/);
      await expect(
        db.as(users[role]!.claims, (c) =>
          c.query(
            "insert into person_leave (person_id, workspace_id, start_date, end_date) values ($1, $2, '2026-12-21', '2026-12-31')",
            [priya, ws],
          ),
        ),
      ).rejects.toThrow(/row-level security/);
    }
  });

  it("stops viewers deleting leave", async () => {
    const leave = (
      await db.client.query(
        "insert into person_leave (person_id, workspace_id, start_date, end_date) values ($1, $2, '2027-01-04', '2027-01-08') returning id",
        [tom, ws],
      )
    ).rows[0].id as string;
    try {
      const deleted = await db.as(users.viewer!.claims, (c) => c.query("delete from person_leave where id = $1", [leave]));
      expect(deleted.rowCount).toBe(0);
    } finally {
      await db.client.query("delete from person_leave where id = $1", [leave]);
    }
  });

  it("stops an editor adding people to another workspace", async () => {
    const other = (await db.client.query("insert into workspaces (name, slug) values ('Elsewhere', 'elsewhere') returning id"))
      .rows[0].id as string;
    await expect(db.as(users.editor!.claims, (c) => insertPerson(c, other))).rejects.toThrow(/row-level security/);
  });
});
