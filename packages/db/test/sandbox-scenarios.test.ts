import { randomUUID } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyPatches, isBlocking, parsePatches } from "@transpera-flow/engine";
import {
  NORTHBEAM_WORKSPACE_ID,
  SANDBOX_LEVERS,
  SANDBOX_LIBRARY,
  LEVER_KIND_IDS,
  changesFromPatch,
  northbeamBundle,
  parseChanges,
  patchOf,
  sqlTargetClass,
  toEngineModel,
  type SandboxChange,
} from "../src";
import { createTestDb, createUser, type TestDb } from "./harness";

// The Sandbox's scenario table (docs/plans/sandbox-p1-brief.md §1, §6): the change checks against the TypeScript registry, the lever
// table, names, parents, the 900 cap, row-level security (Owner, Agency admin, Viewer, guest, anon), the library, and the links.

const ws = NORTHBEAM_WORKSPACE_ID;
let db: TestDb;
let other: string;
const users: Record<string, { id: string; claims: Record<string, unknown> }> = {};
const START = { startDate: "2026-10-05" };
const role = "b0000000-0000-4000-8000-000000000005";
const person = "90000000-0000-4000-8000-000000000001";

beforeAll(async () => {
  db = await createTestDb();
  other = (await db.client.query("insert into workspaces (name, slug) values ('Other Co', 'other-co') returning id")).rows[0].id;
  users.admin = await createUser(db, "admin@agency.example", { agency_admin: true });
  for (const r of ["owner", "viewer"] as const) {
    users[r] = await createUser(db, `${r}@northbeam.example`);
    await db.client.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, $3::membership_role)", [ws, users[r]!.id, r]);
  }
  users.guest = await createUser(db, "guest@example.com");
});

afterAll(async () => {
  await db?.close();
});

const uid = () => randomUUID();
const change = (lever: string, extra: Record<string, unknown> = {}) => ({ id: uid(), lever, target: null, op: "set", value: 1, ...extra });
const sqlOk = async (changes: unknown) => (await db.client.query("select private.is_sandbox_changes($1::jsonb) as ok", [JSON.stringify(changes)])).rows[0].ok as boolean;

describe("the change checks: private.is_sandbox_changes and parseChanges agree", () => {
  const monday = "2027-03-01";
  const cases: [string, unknown, boolean][] = [
    ["an empty list", [], true],
    ["not a list", {}, false],
    ["not an object", ["x"], false],
    // Every lever, whole run and timed.
    ["A1 whole run", [change("A1", { op: "multiply", value: 1.25 })], true],
    ["A1 from a month", [change("A1", { op: "multiply", value: 1.25, from: "2027-05" })], true],
    ["A1 with a target", [change("A1", { target: "x" })], false],
    ["A6 whole run", [change("A6", { target: "s1", value: 3 })], true],
    ["A6 from a month", [change("A6", { target: "s1", from: "2027-05" })], true],
    ["A6 with no target", [change("A6")], false],
    ["A6 with a selector", [change("A6", { target: "@busiest" })], false],
    ["B1 whole run", [change("B1", { value: 30 })], true],
    ["B1 from a month (it is the start)", [change("B1", { from: "2027-05" })], false],
    ["B2 for a service", [change("B2", { target: "s1", value: 4600 })], true],
    ["B2 for the single retainer (no target)", [change("B2", { value: 4600 })], true],
    ["B2 from a month", [change("B2", { target: "s1", op: "multiply", value: 1.08, from: "2027-07" })], true],
    ["B3 whole run", [change("B3", { value: 0.03 })], true],
    ["B3 from a month", [change("B3", { op: "multiply", value: 1.5, from: "2027-02" })], true],
    ["C1 for a role", [change("C1", { target: "r1", op: "multiply", value: 1.1 })], true],
    ["C1 for the busiest role", [change("C1", { target: "@busiest", op: "multiply", value: 1.1 })], true],
    ["C1 for the heaviest step (wrong selector)", [change("C1", { target: "@heaviest" })], false],
    ["C2 whole run", [change("C2", { op: "set", value: 18000 })], true],
    ["C2 multiply from a month", [change("C2", { op: "multiply", value: 1.1, from: "2027-04" })], true],
    ["C2 set to 0", [change("C2", { op: "set", value: 0 })], true],
    ["C2 add a cut", [change("C2", { op: "add", value: -2000 })], true],
    ["C2 set below 0", [change("C2", { op: "set", value: -1 })], false],
    ["C2 multiply below 0", [change("C2", { op: "multiply", value: -0.5 })], false],
    ["C2 with a target", [change("C2", { target: "r1", op: "set", value: 1 })], false],
    ["D1 whole run", [change("D1", { target: role })], true],
    ["D1 from a month, named", [change("D1", { target: role, from: "2027-03", params: { name: "Jade" } })], true],
    ["D1 FTE 0.1", [change("D1", { target: role, value: 0.1 })], true],
    ["D1 FTE 2", [change("D1", { target: role, value: 2 })], true],
    ["D1 FTE 2.1", [change("D1", { target: role, value: 2.1 })], false],
    ["D1 FTE 0.05", [change("D1", { target: role, value: 0.05 })], false],
    ["D1 multiply", [change("D1", { target: role, op: "multiply" })], false],
    ["D1 with an empty name", [change("D1", { target: role, params: { name: "" } })], false],
    ["D1 with a 121-character name", [change("D1", { target: role, params: { name: "x".repeat(121) } })], false],
    ["D1 with another param", [change("D1", { target: role, params: { name: "a", fte: 1 } })], false],
    ["D2 whole run", [change("D2", { target: person, value: 0 })], true],
    ["D2 from a month", [change("D2", { target: person, value: 0, from: "2027-06" })], true],
    ["D2 with a value", [change("D2", { target: person, value: 1 })], false],
    ["D3 on a Monday", [change("D3", { target: person, value: 2, from: monday })], true],
    ["D3 with no start", [change("D3", { target: person, value: 2 })], false],
    ["D3 on a Tuesday", [change("D3", { target: person, value: 2, from: "2027-03-02" })], false],
    ["D3 on 2027-02-30", [change("D3", { target: person, value: 2, from: "2027-02-30" })], false],
    ["D3 from a month", [change("D3", { target: person, value: 2, from: "2027-03" })], false],
    ["D3 for 52 weeks", [change("D3", { target: person, value: 52, from: monday })], true],
    ["D3 for 53 weeks", [change("D3", { target: person, value: 53, from: monday })], false],
    ["D3 for 1.5 weeks", [change("D3", { target: person, value: 1.5, from: monday })], false],
    ["D3 for 0 weeks", [change("D3", { target: person, value: 0, from: monday })], false],
    ["D4 whole run", [change("D4", { target: person, value: 0.8 })], true],
    ["D4 from a month", [change("D4", { target: person, op: "multiply", value: 0.8, from: "2027-04" })], true],
    ["D5 for a role", [change("D5", { target: "r1", op: "add", value: 1 })], true],
    ["D5 for the busiest role", [change("D5", { target: "@busiest", op: "add", value: 1, from: "2027-04" })], true],
    ["E1 for the heaviest step", [change("E1", { target: "@heaviest", op: "multiply", value: 0.4 })], true],
    ["E1 for the busiest role (wrong selector)", [change("E1", { target: "@busiest" })], false],
    ["E2 from a month", [change("E2", { target: "st1", op: "multiply", value: 0.5, from: "2027-04" })], true],
    ["E3 whole run", [change("E3", { target: "st1", value: 0.05 })], true],
    ["E6 from a month", [change("E6", { target: "sol1", from: "2027-04" })], true],
    ["E6 whole run", [change("E6", { target: "sol1" })], true],
    ["E6 with a value of 2", [change("E6", { target: "sol1", value: 2 })], false],
    ["X1 for a health rule", [change("X1", { target: "initial", value: 70 })], true],
    ["X1 for another name", [change("X1", { target: "missed_threshold" })], false],
    ["X1 from a month", [change("X1", { target: "initial", from: "2027-04" })], false],
    ["X2 for the busiest role", [change("X2", { target: "@busiest" })], true],
    ["X3 for a service", [change("X3", { target: "s1", op: "multiply", value: 1.25 })], true],
    // The shape of a change.
    ["an unknown lever", [change("Z9")], false],
    ["an unknown key", [change("A1", { note: "x" })], false],
    ["until (reserved for a later phase)", [change("A1", { until: "2027-09" })], false],
    ["a bad op", [change("A1", { op: "divide" })], false],
    ["a value that is a string", [change("A1", { value: "2" })], false],
    ["a value over the sanity bound", [change("A1", { value: 1e10 })], false],
    ["an id that is not a uuid", [{ ...change("A1"), id: "abc" }], false],
    ["a target with a dot", [change("D5", { target: "a.b" })], false],
    ["a target with a space", [change("D5", { target: "a b" })], false],
    ["a target that is not a string", [change("D5", { target: 5 })], false],
    ["from on a lever that cannot be timed (B1)", [change("B1", { from: "2027-04" })], false],
    ["from as a number", [change("A1", { from: 202704 })], false],
    ["from outside 2000 to 2100", [change("A1", { from: "2101-01" })], false],
    ["from month 13", [change("A1", { from: "2027-13" })], false],
    ["params on a lever other than D1", [change("A1", { params: { name: "x" } })], false],
    // The list.
    ["duplicate change ids", [{ ...change("A1"), id: "11111111-1111-4111-8111-111111111111" }, { ...change("B3"), id: "11111111-1111-4111-8111-111111111111" }], false],
    ["200 changes", Array.from({ length: 200 }, () => change("A1", { op: "add", value: 0 })), true],
    ["201 changes", Array.from({ length: 201 }, () => change("A1", { op: "add", value: 0 })), false],
    ["4 solutions", Array.from({ length: 4 }, (_, i) => change("E6", { target: `sol${i}`, from: `2027-0${i + 1}` })), true],
    ["5 solutions", Array.from({ length: 5 }, (_, i) => change("E6", { target: `sol${i}`, from: i < 4 ? `2027-0${i + 1}` : "2027-01" })), false],
    ["6 capped months", ["01", "02", "03", "04", "05", "06"].map((m) => change("A1", { from: `2027-${m}` })), true],
    ["7 capped months", ["01", "02", "03", "04", "05", "06", "07"].map((m) => change("A1", { from: `2027-${m}` })), false],
    ["6 capped months plus a hire in a seventh (not capped)", [...["01", "02", "03", "04", "05", "06"].map((m) => change("A1", { from: `2027-${m}` })), change("D1", { target: role, from: "2027-07" })], true],
    ["the same month in two capped levers counts once", [change("A1", { from: "2027-01" }), change("B3", { from: "2027-01" }), change("B2", { from: "2027-01" })], true],
    ["D4 counts toward the months", ["01", "02", "03", "04", "05", "06", "07"].map((m, i) => (i < 6 ? change("A1", { from: `2027-${m}` }) : change("D4", { target: person, from: `2027-${m}` }))), false],
  ];

  it.each(cases)("%s", async (_name, changes, ok) => {
    const sql = await sqlOk(changes);
    const parsed = parseChanges(changes);
    expect(sql, "SQL").toBe(ok);
    expect(parsed.ok, `parseChanges${parsed.ok ? "" : `: ${parsed.error}`}`).toBe(ok);
  });

  it("a 100,000-character list is too big, in SQL and in parseChanges", async () => {
    const big = Array.from({ length: 200 }, () => change("D1", { target: role, params: { name: "n".repeat(120) } }));
    expect(JSON.stringify(big).length).toBeGreaterThan(40_000);
    const huge = Array.from({ length: 200 }, () => ({ ...change("D1", { target: role }), params: { name: "n".repeat(120) }, pad: "x".repeat(400) }));
    expect(await sqlOk(huge)).toBe(false);
    expect(parseChanges(huge).ok).toBe(false);
  });
});

describe("the lever table", () => {
  it("private.sandbox_levers() equals SANDBOX_LEVERS", async () => {
    const rows = (await db.client.query("select id, target, selector, ops, whole_run, timed, timing, capped from private.sandbox_levers() order by id")).rows;
    const expected = [...SANDBOX_LEVERS]
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .map((l) => ({
        id: l.id,
        target: sqlTargetClass(l),
        selector: l.selector ?? null,
        ops: [...l.ops],
        whole_run: l.wholeRun,
        timed: l.timed === false ? "no" : l.timed,
        timing: l.timed === false ? null : (l.timing ?? null),
        capped: l.capped,
      }));
    expect(rows).toEqual(expected);
  });

  it("private.sandbox_library() equals SANDBOX_LIBRARY, and no change id starts with the restore's placeholder prefix", async () => {
    const rows = (await db.client.query("select name, description, changes from private.sandbox_library()")).rows;
    expect(rows).toEqual(SANDBOX_LIBRARY.map((l) => ({ name: l.name, description: l.description, changes: l.changes })));
    for (const l of SANDBOX_LIBRARY) for (const c of l.changes) expect(c.id.startsWith("00000000-0000-4000-8000-")).toBe(false);
  });

  it("every lever's kind is a real Settings, Levers kind, and the pay flags are as the brief says", () => {
    for (const l of SANDBOX_LEVERS) if (l.kind !== null) expect(LEVER_KIND_IDS, l.id).toContain(l.kind);
    expect(SANDBOX_LEVERS.filter((l) => l.pay !== "none").map((l) => [l.id, l.pay, l.offered])).toEqual([["C1", "role", false]]);
    expect(SANDBOX_LEVERS.filter((l) => l.pay === "individual")).toEqual([]);
  });

  it("the library applies cleanly to Northbeam's model (selectors resolve)", () => {
    const model = toEngineModel(northbeamBundle(), START);
    for (const l of SANDBOX_LIBRARY) {
      const patches = l.changes.map((c) => patchOf(c as SandboxChange)!);
      expect(parsePatches(patches).ok, l.name).toBe(true);
      expect(applyPatches(model, patches).issues.filter(isBlocking), l.name).toEqual([]);
    }
  });

  it("patches and changes round-trip for every patch lever", () => {
    const patches = [
      { path: "demand.leads_per_week", op: "multiply" as const, value: 1.25 },
      { path: "finances.retainer", op: "set" as const, value: 4000 },
      { path: "services.s1.price", op: "set" as const, value: 4600 },
      { path: "roles.@busiest.headcount", op: "add" as const, value: 1 },
      { path: "health.initial", op: "set" as const, value: 70 },
    ];
    const changes = changesFromPatch(patches);
    expect(changes.map((c) => patchOf(c))).toEqual(patches);
    expect(parseChanges(changes).ok).toBe(true);
  });
});

describe("names, parents and the cap", () => {
  const insert = (c: pg.Client, name: string, extra: { parent?: string | null; workspace?: string; id?: string } = {}) =>
    c.query("insert into sandbox_scenarios (id, workspace_id, name, parent_id) values (coalesce($4::uuid, gen_random_uuid()), $1, $2, $3) returning id", [extra.workspace ?? ws, name, extra.parent ?? null, extra.id ?? null]);

  it("names are unique in a workspace, ignoring case and spaces; the same name is fine in another workspace", async () => {
    await insert(db.client, "Unique Plan");
    await expect(insert(db.client, "  unique plan ")).rejects.toThrow(/sandbox_scenarios_workspace_name_key/);
    await expect(insert(db.client, "UNIQUE PLAN")).rejects.toMatchObject({ code: "23505" });
    await expect(insert(db.client, "Unique Plan", { workspace: other })).resolves.toBeTruthy();
    await expect(db.client.query("insert into sandbox_scenarios (workspace_id, name) values ($1, '   ')", [ws])).rejects.toThrow(/sandbox_scenarios_name_check/);
    await expect(db.client.query("insert into sandbox_scenarios (workspace_id, name, horizon_months) values ($1, 'H25', 25)", [ws])).rejects.toThrow(/horizon_months/);
    await expect(db.client.query("insert into sandbox_scenarios (workspace_id, name, start_date) values ($1, 'Mid', '2027-03-15')", [ws])).rejects.toThrow(/start_date/);
    await expect(db.client.query("insert into sandbox_scenarios (workspace_id, name, description) values ($1, 'Long', $2)", [ws, "x".repeat(2001)])).rejects.toThrow(/description/);
  });

  it("a parent must be in the same workspace; a scenario cannot build on itself or loop; five deep is the most", async () => {
    const [foreign] = (await insert(db.client, "Foreign parent", { workspace: other })).rows;
    await expect(insert(db.client, "Child of foreign", { parent: foreign.id })).rejects.toThrow(/foreign key/);
    const self = uid();
    await expect(insert(db.client, "Own parent", { id: self, parent: self })).rejects.toThrow(/not_own_parent|build on itself/);
    const a = (await insert(db.client, "Loop A")).rows[0].id;
    const b = (await insert(db.client, "Loop B", { parent: a })).rows[0].id;
    await expect(db.client.query("update sandbox_scenarios set parent_id = $2 where id = $1", [a, b])).rejects.toThrow(/build on itself/);
    // A chain: root, then five more is six levels.
    let at = (await insert(db.client, "Chain 0")).rows[0].id as string;
    for (let i = 1; i <= 5; i++) at = (await insert(db.client, `Chain ${i}`, { parent: at })).rows[0].id;
    await expect(insert(db.client, "Chain 6", { parent: at })).rejects.toThrow(/at most 5 deep/);
  });

  it("deleting a parent while a child builds on it is refused (23503); deleting the workspace removes all", async () => {
    const parent = (await insert(db.client, "Parent to keep")).rows[0].id;
    const child = (await insert(db.client, "Child to keep", { parent })).rows[0].id;
    await expect(db.client.query("delete from sandbox_scenarios where id = $1", [parent])).rejects.toMatchObject({ code: "23503" });
    await db.client.query("delete from sandbox_scenarios where id = $1", [child]);
    await expect(db.client.query("delete from sandbox_scenarios where id = $1", [parent])).resolves.toBeTruthy();
    const w = (await db.client.query("insert into workspaces (name, slug) values ('Doomed', 'doomed') returning id")).rows[0].id;
    const p = (await insert(db.client, "Doomed parent", { workspace: w })).rows[0].id;
    await insert(db.client, "Doomed child", { workspace: w, parent: p });
    await db.client.query("delete from workspaces where id = $1", [w]);
    expect((await db.client.query("select count(*)::int as n from sandbox_scenarios where workspace_id = $1", [w])).rows[0].n).toBe(0);
  });

  it("a scenario stays in its workspace", async () => {
    const id = (await insert(db.client, "Stays")).rows[0].id;
    await expect(db.client.query("update sandbox_scenarios set workspace_id = $2 where id = $1", [id, other])).rejects.toThrow(/stays in its workspace/);
  });

  it("the cap of 1000 applies to people only (the migration and the library trigger run with no user)", async () => {
    const w = (await db.client.query("insert into workspaces (name, slug) values ('Capped', 'capped') returning id")).rows[0].id;
    await db.client.query("insert into sandbox_scenarios (workspace_id, name) select $1, 'S' || g from generate_series(1, 996) g", [w]);
    expect((await db.client.query("select count(*)::int as n from sandbox_scenarios where workspace_id = $1", [w])).rows[0].n).toBe(1000);
    // No user: more is fine.
    await db.client.query("insert into sandbox_scenarios (workspace_id, name) values ($1, 'No user')", [w]);
    // An Agency admin: refused.
    await expect(
      db.as(users.admin!.claims, (c) => c.query("insert into sandbox_scenarios (workspace_id, name) values ($1, 'One too many')", [w])),
    ).rejects.toThrow(/at most 1000 scenarios/);
  });

  it("keeps updated_at current (compared in SQL: the timestamps can share a millisecond)", async () => {
    const { id } = (await db.client.query("insert into sandbox_scenarios (workspace_id, name) values ($1, 'Timed') returning id", [ws])).rows[0];
    const { later } = (await db.client.query("update sandbox_scenarios set description = 'x' where id = $1 returning updated_at > created_at as later", [id])).rows[0];
    expect(later).toBe(true);
  });
});

describe("the library", () => {
  it("a new workspace gets the four library scenarios, which parse and apply to any model", async () => {
    const rows = (await db.client.query("select name, changes, created_by from sandbox_scenarios where workspace_id = $1 order by name", [other])).rows.filter((r) => SANDBOX_LIBRARY.some((l) => l.name === r.name));
    expect(rows.map((r) => r.name)).toEqual(["Automate the heaviest step", "Downturn", "Hire into the busiest role", "More leads"]);
    const model = toEngineModel(northbeamBundle(), START);
    for (const r of rows) {
      expect(parseChanges(r.changes).ok, r.name).toBe(true);
      const patches = (r.changes as SandboxChange[]).map((c) => patchOf(c)!);
      expect(applyPatches(model, patches).issues.filter(isBlocking), r.name).toEqual([]);
    }
  });

  it("seeds the library when an Agency admin creates a workspace through the API (RLS on)", async () => {
    const seeded = await db.as(users.admin!.claims, async (c) => {
      const w = (await c.query("insert into workspaces (name, slug) values ('Acme', 'acme') returning id")).rows[0].id;
      return (await c.query("select name, created_by from sandbox_scenarios where workspace_id = $1", [w])).rows;
    });
    expect(seeded).toHaveLength(4);
    expect(seeded.every((r) => r.created_by === users.admin!.id)).toBe(true);
  });

  it("Northbeam's seed holds the four converted scenarios and the two demo hires", async () => {
    const rows = (await db.client.query("select name, changes from sandbox_scenarios where workspace_id = $1 order by id", [ws])).rows.filter((r) => !/^(Unique|Chain|Loop|Parent|Child|Own|Stays|Timed|Foreign)/.test(r.name));
    expect(rows.map((r) => r.name)).toEqual(["Hire a strategist", "Automate proposals", "More leads", "Downturn", "Hire in January", "Hire in March"]);
    for (const r of rows) expect(parseChanges(r.changes).ok, r.name).toBe(true);
  });
});

describe("row-level security", () => {
  const insert = (c: pg.Client, w: string, name = "Mine") => c.query("insert into sandbox_scenarios (workspace_id, name) values ($1, $2) returning id, created_by", [w, name]);
  const count = (c: pg.Client, w: string) => c.query("select count(*)::int as n from sandbox_scenarios where workspace_id = $1", [w]).then((r) => r.rows[0].n as number);

  it("everyone who can read the workspace reads its scenarios (Viewers too); a guest sees none, and no one sees another workspace's", async () => {
    for (const r of ["admin", "owner", "viewer"]) expect(await db.as(users[r]!.claims, (c) => count(c, ws)), r).toBeGreaterThanOrEqual(4);
    expect(await db.as(users.guest!.claims, (c) => count(c, ws))).toBe(0);
    expect(await db.as(users.viewer!.claims, (c) => count(c, other))).toBe(0);
  });

  it("the Owner and Agency admins insert, change and delete; a Viewer and a guest cannot", async () => {
    for (const r of ["admin", "owner"]) {
      const out = await db.as(users[r]!.claims, async (c) => {
        const row = (await insert(c, ws, `RLS ${r}`)).rows[0];
        const renamed = (await c.query("update sandbox_scenarios set name = $2 where id = $1 returning id", [row.id, `RLS ${r} renamed`])).rowCount;
        const deleted = (await c.query("delete from sandbox_scenarios where id = $1", [row.id])).rowCount;
        return { createdBy: row.created_by, renamed, deleted };
      });
      expect(out, r).toEqual({ createdBy: users[r]!.id, renamed: 1, deleted: 1 });
    }
    for (const r of ["viewer", "guest"]) {
      await expect(db.as(users[r]!.claims, (c) => insert(c, ws, `Nope ${r}`)), r).rejects.toThrow(/row-level security/);
      const changed = await db.as(users[r]!.claims, async (c) => ({
        updated: (await c.query("update sandbox_scenarios set name = name || 'x' where workspace_id = $1", [ws])).rowCount,
        deleted: (await c.query("delete from sandbox_scenarios where workspace_id = $1", [ws])).rowCount,
      }));
      expect(changed, r).toEqual({ updated: 0, deleted: 0 });
    }
  });

  it("an Owner of one workspace cannot write into another, or move a scenario there", async () => {
    await expect(db.as(users.owner!.claims, (c) => insert(c, other))).rejects.toThrow(/row-level security/);
    // The column is not one a person may update; with the grant it would be the policy.
    await expect(db.as(users.owner!.claims, (c) => c.query("update sandbox_scenarios set workspace_id = $1 where workspace_id = $2", [other, ws]))).rejects.toThrow(/permission denied|row-level security/);
  });

  it("only the columns a person writes can be updated (not id, workspace, created_by or created_at)", async () => {
    const id = (await insert(db.client, ws, "Columns")).rows[0].id;
    for (const col of ["id", "workspace_id", "created_by", "created_at", "updated_at"]) {
      await expect(db.as(users.admin!.claims, (c) => c.query(`update sandbox_scenarios set ${col} = ${col} where id = $1`, [id])), col).rejects.toThrow(/permission denied/);
    }
    for (const set of ["name = 'Columns 2'", "description = 'd'", "changes = '[]'", "horizon_months = 6", "start_date = '2027-03-01'", "parent_id = null"]) {
      await expect(db.as(users.admin!.claims, (c) => c.query(`update sandbox_scenarios set ${set} where id = $1`, [id])), set).resolves.toBeTruthy();
    }
  });

  it("gives the anon role no access", async () => {
    await db.client.query("begin");
    try {
      await db.client.query("set local role anon");
      await expect(db.client.query("select * from sandbox_scenarios")).rejects.toThrow(/permission denied/);
    } finally {
      await db.client.query("rollback");
    }
  });
});

describe("links to other tables", () => {
  it("an issue and a run linked to a deleted scenario are unlinked, not blocked", async () => {
    const s = (await db.client.query("insert into sandbox_scenarios (workspace_id, name) values ($1, 'Linked') returning id", [ws])).rows[0].id;
    const issue = (await db.client.query("insert into issues (workspace_id, type, title, scenario_id) values ($1, 'idea', 'Try it', $2) returning id", [ws, s])).rows[0].id;
    const run = (await db.client.query("insert into runs (workspace_id, name, reps, seed, params_snapshot, scenario_id) values ($1, 'r', 30, 1, '{}', $2) returning id", [ws, s])).rows[0].id;
    await db.client.query("delete from sandbox_scenarios where id = $1", [s]);
    expect((await db.client.query("select scenario_id from issues where id = $1", [issue])).rows[0].scenario_id).toBeNull();
    expect((await db.client.query("select scenario_id from runs where id = $1", [run])).rows[0].scenario_id).toBeNull();
  });

  it("the old tables and their helpers are gone; the solution patch check is kept", async () => {
    const r = (await db.client.query("select to_regclass('public.scenarios') as s, to_regclass('public.forecast_plans') as f, to_regprocedure('private.scenario_library()') as l, to_regprocedure('private.seed_scenario_library()') as sl, to_regprocedure('private.forecast_plans_before_write()') as fp, to_regprocedure('private.is_scenario_patch(jsonb)') as isp")).rows[0];
    expect(r).toEqual({ s: null, f: null, l: null, sl: null, fp: null, isp: "private.is_scenario_patch(jsonb)" });
  });
});
