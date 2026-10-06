import { detectIssues, simulate, type DetectedIssue, type SimulationResult } from "@transpera-flow/engine";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  LARKSPUR_WORKSPACE_ID,
  NORTHBEAM_WORKSPACE_ID,
  larkspurPersonIds,
  toEngineModel,
  type ProcessBundle,
} from "../src";
import { headerRollback } from "./header-rollback";
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

describe("team_capacity per-person times (C6)", () => {
  interface Factor {
    person_id: string;
    step_id: string | null;
    workspace_id: string;
    factor: number;
    source: string;
    [k: string]: unknown;
  }
  type WithFactors = { person_capacity_factors: Factor[]; [k: string]: unknown };
  const factorsAs = async (who: { claims: Record<string, unknown> }) => ((await teamAs(who)) as unknown as WithFactors).person_capacity_factors;
  let steps: string[];
  const key = (f: Factor) => `${f.person_id}:${f.step_id ?? "default"}:${f.factor}`;

  beforeAll(async () => {
    steps = (await db.client.query("select id from steps where workspace_id = $1 order by id limit 2", [ws])).rows.map((r) => r.id as string);
    // Jess (the member's own person) and two others, one default and one step each.
    for (const [person, def, step] of [[P.jess!, 0.9, 1.2], [P.callum!, 0.8, 1.5], [P.hana!, 1.1, 0.7]] as const) {
      await db.client.query("insert into person_capacity_factors (person_id, workspace_id, step_id, factor) values ($1, $2, null, $3), ($1, $2, $4, $5)", [person, ws, def, steps[0], step]);
    }
  });
  afterAll(async () => {
    await db.client.query("delete from person_capacity_factors");
  });

  it("an editor and an agency admin get all six; the member gets only Jess's two; nothing carries provenance or created_by", async () => {
    const all = [`${P.hana}:default:1.1`, `${P.hana}:${steps[0]}:0.7`, `${P.callum}:default:0.8`, `${P.callum}:${steps[0]}:1.5`, `${P.jess}:default:0.9`, `${P.jess}:${steps[0]}:1.2`].sort();
    for (const who of [editor, admin]) {
      const f = await factorsAs(who);
      expect(f.map(key).sort()).toEqual(all);
      for (const row of f) {
        expect(Object.keys(row).sort()).toEqual(["factor", "person_id", "source", "step_id", "workspace_id"]);
        expect(row.source).toBe("entered");
        expect(row.workspace_id).toBe(ws);
        expect(typeof row.factor).toBe("number");
      }
    }
    const mine = await factorsAs(member);
    expect(mine.map(key).sort()).toEqual([`${P.jess}:default:0.9`, `${P.jess}:${steps[0]}:1.2`].sort());
    // The default comes first for a person, then by step.
    expect((await factorsAs(editor)).filter((r) => r.person_id === P.jess).map((r) => r.step_id)).toEqual([null, steps[0]]);
  });

  it("a member linked to nobody and a viewer linked to someone else get only their own or an empty list; no one else's number appears anywhere in the text", async () => {
    const unlinked = await createUser(db, "cf-unlinked@tc.example");
    await db.client.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, 'member')", [ws, unlinked.id]);
    expect(await factorsAs(unlinked)).toEqual([]);
    const viewer = await createUser(db, "cf-viewer@tc.example");
    await db.client.query("insert into memberships (workspace_id, user_id, role, person_id) values ($1, $2, 'viewer', $3)", [ws, viewer.id, P.callum!]);
    expect((await factorsAs(viewer)).map(key).sort()).toEqual([`${P.callum}:default:0.8`, `${P.callum}:${steps[0]}:1.5`].sort());
    // A viewer linked to a person with no factors gets none.
    const bare = await createUser(db, "cf-bare@tc.example");
    await db.client.query("insert into memberships (workspace_id, user_id, role, person_id) values ($1, $2, 'viewer', $3)", [ws, bare.id, P.priti!]);
    expect(await factorsAs(bare)).toEqual([]);
    // Jess's text holds no one else's value.
    const text = await db.as(member.claims, async (c) => (await c.query("select public.team_capacity($1)::text as t", [ws])).rows[0].t as string);
    expect(text).not.toMatch(/"factor": (0\.8|1\.5|1\.1|0\.7)\b/);
    expect(text).not.toContain(P.callum!.toString() + '", "step_id"');
  });

  it("a person's factor rows are also read through the table by their own person only (RLS), as person_skills", async () => {
    const rows = await db.as(member.claims, async (c) => (await c.query("select person_id from person_capacity_factors")).rows.map((r) => r.person_id as string));
    expect(new Set(rows)).toEqual(new Set([P.jess]));
    expect(rows).toHaveLength(2);
  });

  it("everything else the function returns is what it returned before C6: the new key removed, the old body gives the same", async () => {
    const t = (await db.as(editor.claims, async (c) => (await c.query("select public.team_capacity($1) as t", [ws])).rows[0].t)) as Record<string, unknown>;
    expect(Object.keys(t).sort()).toEqual(["client_assignments", "own_person_id", "people", "person_capacity_factors", "person_leave", "person_roles", "person_skills", "sees_everyone"]);
    // The old body: run as written in the migration's rollback, in a transaction that is rolled back.
    const rollback = headerRollback("20261223000000_capacity_factors.sql");
    const start = rollback.indexOf("create or replace function public.team_capacity");
    const end = rollback.indexOf("$$;", start) + 3;
    await db.client.query("begin");
    try {
      await db.client.query(rollback.slice(start, end));
      const old = (await db.as(editor.claims, async (c) => (await c.query("select public.team_capacity($1) as t", [ws])).rows[0].t)) as Record<string, unknown>;
      const { person_capacity_factors: _new, ...rest } = t;
      expect(old).toEqual(rest);
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
