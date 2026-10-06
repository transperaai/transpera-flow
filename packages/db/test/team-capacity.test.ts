import { simulate, type SimulationResult } from "@transpera-flow/engine";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  LARKSPUR_WORKSPACE_ID,
  NORTHBEAM_WORKSPACE_ID,
  larkspurPersonIds,
  larkspurRoleIds,
  toEngineModel,
  type ProcessBundle,
} from "../src";
import { createTestDb, createUser, type TestDb } from "./harness";

// What a member's browser gets from `public.team_capacity` (B1 2a): labels, and each cost rate replaced by the role's
// hours-weighted average. Larkspur has a person in two roles (Hana: strat and am), a person with 30 hours (Theo), skills
// (Freya) and leave (Ruby, Kai).

const ws = LARKSPUR_WORKSPACE_ID;
const P = larkspurPersonIds;

let db: TestDb;
let member: { id: string; claims: Record<string, unknown> };
let editor: { id: string; claims: Record<string, unknown> };
let admin: { id: string; claims: Record<string, unknown> };

interface Raw {
  id: string;
  name: string;
  fte: number;
  hours: number | null;
  cost: number | null;
  active: boolean;
  created_at: string;
}
interface Shown {
  id: string;
  name: string;
  cost_rate: number | null;
  [k: string]: unknown;
}

beforeAll(async () => {
  db = await createTestDb();
  const link = async (email: string, role: string, person: string | null) => {
    const u = await createUser(db, email);
    await db.client.query("insert into memberships (workspace_id, user_id, role, person_id) values ($1, $2, $3, $4)", [ws, u.id, role, person]);
    return u;
  };
  member = await link("jess@tc.example", "member", P.jess!);
  editor = await link("editor@tc.example", "editor", null);
  admin = await createUser(db, "admin@tc.example", { agency_admin: true });
  // Rates: the am pool has three rated people (Hana, who also holds strat, Jess and Callum); design has two (Ruby and Theo, who
  // has 65 already); Priti has none; Marek is rated but inactive.
  for (const [key, rate] of [["hana", 80], ["jess", 50], ["callum", 40], ["ruby", 55], ["marek", 90]] as const) {
    await db.client.query("update people set cost_rate = $1 where id = $2", [rate, P[key]]);
  }
  await db.client.query("update people set active = false where id = $1", [P.marek]);
}, 120_000);

afterAll(async () => {
  await db?.close();
});

const teamAs = async (who: { claims: Record<string, unknown> }) =>
  db.as(who.claims, async (c) => (await c.query("select public.team_capacity($1) as t", [ws])).rows[0].t as { people: Shown[]; own_person_id: string | null });

/** The stored people, with how many hours each is, and the roles each holds. */
async function rawRows() {
  const settings = (await db.client.query("select settings from workspaces where id = $1", [ws])).rows[0].settings as Record<string, unknown>;
  const week = typeof settings.hours_per_week === "number" ? settings.hours_per_week : 40;
  const people = (
    await db.client.query("select id, name, fte::float8 as fte, capacity_hours_week::float8 as hours, cost_rate::float8 as cost, active, created_at::text from people where workspace_id = $1", [ws])
  ).rows as Raw[];
  const roles = (await db.client.query("select person_id, role_id from person_roles where workspace_id = $1", [ws])).rows as { person_id: string; role_id: string }[];
  return { week, people, roles };
}

/** The rule from the brief, written independently of the SQL: the rate a member sees for every person. */
function expectedRates(week: number, people: Raw[], roles: { person_id: string; role_id: string }[], minPool = 3): Map<string, number | null> {
  const hours = (p: Raw) => p.hours ?? p.fte * week;
  const heldBy = (id: string) => roles.filter((r) => r.person_id === id).map((r) => r.role_id);
  const weighted = (entries: { rate: number; weight: number }[]) => {
    const total = entries.reduce((a, e) => a + e.weight, 0);
    return total > 0 ? entries.reduce((a, e) => a + e.rate * e.weight, 0) / total : entries.reduce((a, e) => a + e.rate, 0) / entries.length;
  };
  const pool = people.filter((p) => p.active && p.cost !== null);
  const roleRate = new Map<string, number>();
  for (const role of new Set(roles.map((r) => r.role_id))) {
    const inRole = pool.filter((p) => heldBy(p.id).includes(role));
    if (inRole.length >= minPool) roleRate.set(role, weighted(inRole.map((p) => ({ rate: p.cost!, weight: hours(p) / heldBy(p.id).length }))));
  }
  const workspaceRate = pool.length >= minPool ? weighted(pool.map((p) => ({ rate: p.cost!, weight: hours(p) }))) : null;
  const out = new Map<string, number | null>();
  for (const p of people) {
    if (p.cost === null) {
      out.set(p.id, null);
      continue;
    }
    const rates = heldBy(p.id).flatMap((r) => (roleRate.has(r) ? [roleRate.get(r)!] : []));
    const shown = rates.length ? rates.reduce((a, b) => a + b, 0) / rates.length : workspaceRate;
    out.set(p.id, shown === null ? null : Math.round(shown * 10000) / 10000);
  }
  return out;
}

const matchRate = (got: number | null, want: number | null, label: string) => {
  if (want === null) expect(got, label).toBeNull();
  else expect(got, label).toBeCloseTo(want, 4);
};

describe("team_capacity cost rates for a member", () => {
  it("follow the rule: role average where three people are rated, else the workspace average, else null", async () => {
    const { week, people, roles } = await rawRows();
    const want = expectedRates(week, people, roles);
    const shown = (await teamAs(member)).people;
    for (const p of shown) matchRate(p.cost_rate, want.get(p.id) ?? null, p.id);
    const byId = new Map(shown.map((p) => [p.id, p.cost_rate]));
    // Priti has no rate of her own: she stays null, so the engine uses her role's default.
    expect(byId.get(P.priti!)).toBeNull();
    // The am people share one rate; Hana's is the same because strat has fewer than three rated people.
    const am = byId.get(P.jess!);
    expect(am).not.toBeNull();
    expect(byId.get(P.hana!)).toBe(am);
    expect(byId.get(P.callum!)).toBe(am);
    // The designers (two rated) get the workspace average, which is neither of their own rates.
    const designers = byId.get(P.ruby!);
    expect(byId.get(P.theo!)).toBe(designers);
    expect(designers).not.toBe(55);
    expect(designers).not.toBe(65);
    // Marek is inactive: shown a rate by the same rule, but in no pool (so nobody's average includes his 90).
    expect(byId.get(P.marek!)).toBe(designers);
    const without = expectedRates(week, people.map((p) => (p.id === P.marek ? { ...p, active: true } : p)), roles);
    expect(without.get(P.ruby!)).not.toBeCloseTo(want.get(P.ruby!)!, 4);
    // An editor and an admin get the stored rates.
    for (const who of [editor, admin]) {
      const t = await teamAs(who);
      expect(t.people.find((p) => p.id === P.hana)!.cost_rate).toBe(80);
      expect(t.people.find((p) => p.id === P.priti)!.cost_rate).toBeNull();
    }
  });

  it("keep the am role's overtime-driving total: sum of rate x hours / roles held over its pool is the same as from the raw rows", async () => {
    const { week, people, roles } = await rawRows();
    const am = larkspurRoleIds.am!;
    const shown = new Map((await teamAs(member)).people.map((p) => [p.id, p.cost_rate]));
    const total = (rate: (p: Raw) => number) =>
      people
        .filter((p) => p.active && p.cost !== null && roles.some((r) => r.person_id === p.id && r.role_id === am))
        .reduce((a, p) => a + (rate(p) * (p.hours ?? p.fte * week)) / roles.filter((r) => r.person_id === p.id).length, 0);
    expect(total((p) => shown.get(p.id)!)).toBeCloseTo(total((p) => p.cost!), 2);
  });

  it("with zero hours everywhere the averages are plain averages and nothing divides by zero", async () => {
    await db.client.query("begin");
    try {
      await db.client.query("update workspaces set settings = jsonb_set(settings, '{hours_per_week}', '0') where id = $1", [ws]);
      await db.client.query("update people set capacity_hours_week = null where workspace_id = $1", [ws]);
      const { week, people, roles } = await rawRows();
      expect(week).toBe(0);
      const want = expectedRates(week, people, roles);
      await db.client.query("set local role authenticated");
      await db.client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(member.claims)]);
      const t = (await db.client.query("select public.team_capacity($1) as t", [ws])).rows[0].t as { people: Shown[] };
      for (const p of t.people) matchRate(p.cost_rate, want.get(p.id) ?? null, p.id);
      // The am rate is the plain average of 80, 50 and 40.
      expect(t.people.find((p) => p.id === P.jess)!.cost_rate).toBeCloseTo(170 / 3, 4);
    } finally {
      await db.client.query("rollback");
    }
  });
});

describe("a member's simulation equals an editor's", () => {
  /** The pipeline bundle read from the tables as `who` sees them, with the team's inputs replaced by `team_capacity`'s when asked. */
  async function bundleFor(who: { claims: Record<string, unknown> }, wsId: string, viaTeam: boolean): Promise<ProcessBundle> {
    return db.as(who.claims, async (c) => {
      const one = async (sql: string, params: unknown[]) => (await c.query(sql, params)).rows[0];
      const many = async (sql: string, params: unknown[]) => (await c.query(sql, params)).rows;
      const workspace = await one("select id, name, slug, settings from workspaces where id = $1", [wsId]);
      const process = await one("select * from processes where workspace_id = $1 and kind = 'pipeline' and not is_company", [wsId]);
      const servicing = await many("select * from processes where workspace_id = $1 and kind = 'servicing' order by id", [wsId]);
      const otherProcesses = [];
      for (const p of servicing) {
        otherProcesses.push({
          process: p,
          revision: await one("select * from process_revisions where id = $1", [p.live_revision_id]),
          steps: await many("select * from steps where revision_id = $1", [p.live_revision_id]),
          edges: await many("select * from edges where revision_id = $1", [p.live_revision_id]),
        });
      }
      const team = viaTeam ? ((await one("select public.team_capacity($1) as t", [wsId])).t as Record<string, unknown[]>) : null;
      return {
        workspace,
        process,
        revision: await one("select * from process_revisions where id = $1", [process.live_revision_id]),
        roles: await many("select * from roles where workspace_id = $1", [wsId]),
        steps: await many("select * from steps where revision_id = $1", [process.live_revision_id]),
        edges: await many("select * from edges where revision_id = $1", [process.live_revision_id]),
        people: team?.people ?? (await many("select * from people where workspace_id = $1", [wsId])),
        personRoles: team?.person_roles ?? (await many("select * from person_roles where workspace_id = $1", [wsId])),
        personSkills: team?.person_skills ?? (await many("select * from person_skills where workspace_id = $1", [wsId])),
        personLeave: team?.person_leave ?? (await many("select id, person_id, workspace_id, start_date::text, end_date::text from person_leave where workspace_id = $1", [wsId])),
        services: await many("select * from services where workspace_id = $1", [wsId]),
        leadSources: await many("select * from lead_sources where workspace_id = $1", [wsId]),
        seasonality: await many("select * from seasonality where workspace_id = $1", [wsId]),
        demand: (await one("select * from demand_settings where workspace_id = $1", [wsId])) ?? null,
        clients: await many("select id, workspace_id, name, start_date::text, mrr, health, provenance, notes, active from clients where workspace_id = $1", [wsId]),
        clientServices: await many("select * from client_services where workspace_id = $1", [wsId]),
        clientAssignments: team?.client_assignments ?? (await many("select * from client_assignments where workspace_id = $1", [wsId])),
        otherProcesses,
      } as unknown as ProcessBundle;
    });
  }

  /**
   * The editor's result with each person's real name replaced by the label the member's run used for them (names also appear in
   * the engine's own text, such as a key person or an overload issue), and without what may differ: overtime cost, which
   * uses person rates (`dropRates`), and the people's own cost rates.
   */
  const relabelled = (editorRun: SimulationResult, memberRun: SimulationResult, dropRates: boolean) => {
    let text = JSON.stringify(editorRun);
    for (const [id, p] of Object.entries(editorRun.resolvedPeople)) {
      text = text.split(JSON.stringify(p.name)).join(JSON.stringify(memberRun.resolvedPeople[id]!.name));
      text = text.split(p.name).join(memberRun.resolvedPeople[id]!.name);
    }
    return strip(JSON.parse(text), dropRates);
  };
  const strip = (r: Record<string, any>, dropRates: boolean) => {
    const copy = JSON.parse(JSON.stringify(r)) as Record<string, any>;
    if (dropRates) {
      delete copy.kpi.overtimeCost;
      delete copy.samples.overtimeCost;
      for (const p of Object.values(copy.resolvedPeople) as Record<string, unknown>[]) delete p.cost;
    }
    return copy;
  };

  it("Larkspur: deep-equal apart from overtime cost and names and rates, and the overtime cost is close", async () => {
    const opts = { startDate: "2026-10-05" };
    const viaTables = simulate(toEngineModel(await bundleFor(editor, ws, false), opts), 30, 1);
    const viaTeam = simulate(toEngineModel(await bundleFor(member, ws, true), opts), 30, 1);
    // The member's rows must carry labels, or the comparison proves nothing.
    expect(Object.values(viaTeam.resolvedPeople).some((p) => /^Team member \d+$/.test(p.name))).toBe(true);
    const a = viaTables.kpi.overtimeCost.mean;
    const b = viaTeam.kpi.overtimeCost.mean;
    expect(Number.isFinite(a) && Number.isFinite(b)).toBe(true);
    expect(a).toBeGreaterThan(0);
    expect(Math.abs(a - b)).toBeLessThanOrEqual(0.25 * Math.abs(a));
    expect(strip(viaTeam as unknown as Record<string, any>, true)).toEqual(relabelled(viaTables, viaTeam, true));
  });

  it("Northbeam (no person rates): deep-equal with only the names removed", async () => {
    const opts = { startDate: "2026-10-05" };
    const nbMember = await createUser(db, "nb-member@tc.example");
    await db.client.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, 'member')", [NORTHBEAM_WORKSPACE_ID, nbMember.id]);
    const nbEditor = await createUser(db, "nb-editor@tc.example");
    await db.client.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, 'editor')", [NORTHBEAM_WORKSPACE_ID, nbEditor.id]);
    const viaTables = simulate(toEngineModel(await bundleFor(nbEditor, NORTHBEAM_WORKSPACE_ID, false), opts), 30, 1);
    const viaTeam = simulate(toEngineModel(await bundleFor(nbMember, NORTHBEAM_WORKSPACE_ID, true), opts), 30, 1);
    expect(strip(viaTeam as unknown as Record<string, any>, false)).toEqual(relabelled(viaTables, viaTeam, false));
  });
});
