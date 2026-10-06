import { detectIssues, simulate, type DetectedIssue, type SimulationResult } from "@transpera-flow/engine";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  LARKSPUR_WORKSPACE_ID,
  NORTHBEAM_WORKSPACE_ID,
  larkspurPersonIds,
  toEngineModel,
  type ProcessBundle,
} from "../src";
import { createTestDb, createUser, type TestDb } from "./harness";

// What a member's browser gets from `public.team_capacity` (B1 2a): labels and NO pay (Austin, 6 Oct: every cost rate is
// null except the caller's own; no averages, so nothing leaks by subtraction). Larkspur has a person in two roles (Hana: strat and am), a person with 30 hours (Theo), skills
// (Freya) and leave (Ruby, Kai).

type Json = { kpi: Record<string, unknown>; samples: Record<string, unknown>; resolvedPeople: Record<string, Record<string, unknown>> };

const ws = LARKSPUR_WORKSPACE_ID;
const P = larkspurPersonIds;

let db: TestDb;
let member: { id: string; claims: Record<string, unknown> };
let editor: { id: string; claims: Record<string, unknown> };
let admin: { id: string; claims: Record<string, unknown> };

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

describe("team_capacity cost rates", () => {
  it("a member gets none but their own; an editor and an admin get the stored rates", async () => {
    const shown = (await teamAs(member)).people;
    const byId = new Map(shown.map((p) => [p.id, p.cost_rate]));
    // Jess is the member's own person: her own rate, unchanged. Everyone else is null, rated or not.
    expect(byId.get(P.jess!)).toBe(50);
    for (const p of shown) if (p.id !== P.jess) expect(p.cost_rate, p.id).toBeNull();
    for (const key of ["hana", "callum", "ruby", "marek", "theo", "priti"] as const) expect(byId.get(P[key]!), key).toBeNull();
    for (const who of [editor, admin]) {
      const t = await teamAs(who);
      expect(t.people.find((p) => p.id === P.hana)!.cost_rate).toBe(80);
      expect(t.people.find((p) => p.id === P.ruby)!.cost_rate).toBe(55);
      expect(t.people.find((p) => p.id === P.priti)!.cost_rate).toBeNull();
    }
  });

  it("a member with no linked person gets no rate at all, and nothing derived from rates", async () => {
    const u = await createUser(db, "unlinked@tc.example");
    await db.client.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, 'viewer')", [ws, u.id]);
    const t = await teamAs(u);
    expect(t.people.length).toBeGreaterThan(0);
    for (const p of t.people) expect(p.cost_rate, p.id).toBeNull();
    // The whole response: no rate of anyone's appears as a number anywhere in it.
    const text = JSON.stringify(t);
    expect(text).not.toMatch(/"cost_rate":\s*[0-9]/);
    // No averaging code is left in the function.
    const src = (await db.client.query("select prosrc from pg_proc where proname = 'team_capacity' and pronamespace = 'public'::regnamespace")).rows[0].prosrc as string;
    expect(src).not.toMatch(/avg\(|role_rate|ws_rate|weight/i);
  });

  it("a member cannot read other people's rates from the tables either", async () => {
    const rows = await db.as(member.claims, async (c) => (await c.query("select id from people where workspace_id = $1", [ws])).rows as { id: string }[]);
    expect(rows.map((r) => r.id)).toEqual([P.jess]);
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
        ...(team ? { viewer: { seesEveryone: team.sees_everyone as unknown as boolean, ownPersonId: (team.own_person_id as unknown as string | null) ?? null } } : {}),
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

  /** Replaces each person's real name with the label the member's run used for them, in any JSON (names also appear in the engine's own text). */
  const relabel = <T,>(value: T, editorRun: SimulationResult, memberRun: SimulationResult): T => {
    let text = JSON.stringify(value);
    for (const [id, p] of Object.entries(editorRun.resolvedPeople)) {
      text = text.split(JSON.stringify(p.name)).join(JSON.stringify(memberRun.resolvedPeople[id]!.name));
      text = text.split(p.name).join(memberRun.resolvedPeople[id]!.name);
    }
    return JSON.parse(text) as T;
  };
  /** A result without what may differ for a member: people's own cost rates (the engine's overtime cost is null for the member, checked apart). */
  const strip = (r: Json) => {
    const copy = JSON.parse(JSON.stringify(r)) as Json;
    delete copy.kpi.overtimeCost;
    for (const p of Object.values(copy.resolvedPeople) as Record<string, unknown>[]) delete p.cost;
    return copy;
  };

  it("Larkspur: a member's numbers equal an editor's exactly, except the figures that depend on pay, which are unavailable (not 0)", async () => {
    const opts = { startDate: "2026-10-05" };
    const editorModel = toEngineModel(await bundleFor(editor, ws, false), opts);
    const memberModel = toEngineModel(await bundleFor(member, ws, true), opts);
    expect(editorModel.payHidden).toBeUndefined();
    expect(memberModel.payHidden).toBe(true);
    // No person in the member's model has a rate, not even a role's default standing in for it.
    for (const p of Object.values(memberModel.people ?? {})) expect(p.cost).toBeUndefined();
    const viaTables = simulate(editorModel, 30, 1);
    const viaTeam = simulate(memberModel, 30, 1);
    // The member's rows must carry labels, or the comparison proves nothing.
    expect(Object.values(viaTeam.resolvedPeople).some((p) => /^Team member \d+$/.test(p.name))).toBe(true);
    // Overtime cost: a number for the editor (it is real money), unavailable for the member: null, not 0.
    expect(viaTables.kpi.overtimeCost!.mean).toBeGreaterThan(0);
    expect(viaTeam.kpi.overtimeCost).toBeNull();
    expect(strip(viaTeam as unknown as Json)).toEqual(strip(relabel(viaTables, viaTables, viaTeam) as unknown as Json));

    // Detected issues: the same issues, ratings, titles and evidence; the costs that need pay are unavailable.
    const byKey = (list: DetectedIssue[]) => new Map(list.map((i) => [i.key, i]));
    const mine = byKey(detectIssues(memberModel, viaTeam));
    const theirs = byKey(relabel(detectIssues(editorModel, viaTables), viaTables, viaTeam));
    expect([...mine.keys()].sort()).toEqual([...theirs.keys()].sort());
    let hidden = 0;
    for (const [key, m] of mine) {
      const e = theirs.get(key)!;
      if (m.cost.payHidden) {
        hidden++;
        expect(m.cost, key).toMatchObject({ perMonth: null, hoursPerMonth: null, payHidden: true });
        // Everything else about it is the same, evidence and metrics included: since B1 2b they state no money.
        expect({ ...m, cost: null }, key).toEqual({ ...e, cost: null });
        expect(m.metrics, key).not.toHaveProperty("overtime_cost");
      } else {
        expect(m, key).toEqual(e);
      }
    }
    // Larkspur's copywriter works overtime: that issue's cost is one of the unavailable ones.
    expect(hidden).toBeGreaterThan(0);
    expect([...mine.values()].some((i) => i.cost.payHidden && i.key.startsWith("overtime:person:"))).toBe(true);
  });

  it("Northbeam (no person rates): deep-equal with only the names removed, and the overtime cost still unavailable", async () => {
    const opts = { startDate: "2026-10-05" };
    const nbMember = await createUser(db, "nb-member@tc.example");
    await db.client.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, 'member')", [NORTHBEAM_WORKSPACE_ID, nbMember.id]);
    const nbEditor = await createUser(db, "nb-editor@tc.example");
    await db.client.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, 'editor')", [NORTHBEAM_WORKSPACE_ID, nbEditor.id]);
    const viaTables = simulate(toEngineModel(await bundleFor(nbEditor, NORTHBEAM_WORKSPACE_ID, false), opts), 30, 1);
    const viaTeam = simulate(toEngineModel(await bundleFor(nbMember, NORTHBEAM_WORKSPACE_ID, true), opts), 30, 1);
    expect(viaTeam.kpi.overtimeCost).toBeNull();
    expect(strip(viaTeam as unknown as Json)).toEqual(strip(relabel(viaTables, viaTables, viaTeam) as unknown as Json));
  });
});
