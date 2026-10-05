import { describe, expect, it } from "vitest";
import { simulate } from "@transpera-flow/engine";
import { northbeamBundle, northbeamClientIds, northbeamPersonIds, northbeamRoleIds, northbeamServiceIds, toEngineModel, type ClientRow, type ProcessBundle } from "../src";

// Clients added by hand (issue #182, B19; PRD D42) and the simulation. The rule:
//   * once any service has clients counted in its client group, the groups are what is simulated, and the named clients are a
//     record only: adding, editing or making one inactive changes nothing in the results;
//   * with no clients counted, the active named clients who have started by the run's start are simulated (as before D27),
//     and an inactive client counts exactly as if they weren't there (hidden, never deleted).

const START = "2026-10-05";
const WS = northbeamBundle().workspace.id;
const NEW_ID = "c1c1c1c1-0000-4000-8000-000000000b19";

const handMade = (over: Partial<ClientRow> = {}): ClientRow => ({
  id: NEW_ID,
  workspace_id: WS,
  name: "Hand Made Ltd",
  start_date: "2026-09-01",
  mrr: 4200,
  health: null,
  provenance: {},
  notes: null,
  active: true,
  ...over,
});

/** The bundle with one client added by hand: SEO, looked after by Sam Patel as the SEO specialist. */
function withHandMade(b: ProcessBundle, over: Partial<ClientRow> = {}): ProcessBundle {
  return {
    ...b,
    clients: [...(b.clients ?? []), handMade(over)],
    clientServices: [...(b.clientServices ?? []), { client_id: NEW_ID, service_id: northbeamServiceIds.seo!, workspace_id: WS, start_date: null }],
    clientAssignments: [
      ...(b.clientAssignments ?? []),
      { client_id: NEW_ID, role_id: northbeamRoleIds.seo!, person_id: northbeamPersonIds["Sam Patel"]!, workspace_id: WS },
    ],
  };
}

const headline = (b: ProcessBundle) => {
  const r = simulate(toEngineModel(b, { startDate: START }), 4, 7);
  return JSON.stringify({ kpi: r.kpi, samples: r.samples, people: r.people });
};

describe("with client groups counted, named clients are a record only", () => {
  const groups = northbeamBundle();

  it("adding, editing or making a client inactive leaves the model exactly as it was", () => {
    const base = toEngineModel(groups, { startDate: START });
    expect(toEngineModel(withHandMade(groups), { startDate: START })).toEqual(base);
    expect(toEngineModel(withHandMade(groups, { mrr: 99_000, start_date: "2020-01-01" }), { startDate: START })).toEqual(base);
    const edited = { ...groups, clients: groups.clients!.map((c) => (c.id === northbeamClientIds.c01 ? { ...c, active: false, mrr: 1 } : c)) };
    expect(toEngineModel(edited, { startDate: START })).toEqual(base);
  });

  it("and the simulated results are identical", () => {
    expect(headline(withHandMade(groups))).toBe(headline(groups));
  });
});

describe("with no clients counted, the active named clients are simulated", () => {
  const named = { ...northbeamBundle(), clientGroups: [] };

  it("a client added by hand joins the simulation, with their services, MRR and who looks after them", () => {
    const m = toEngineModel(withHandMade(named), { startDate: START });
    expect(m.activeClients).toBe(27);
    expect(m.clients![NEW_ID]).toEqual({
      name: "Hand Made Ltd",
      services: [northbeamServiceIds.seo],
      mrr: 4200,
      assignments: { [northbeamRoleIds.seo!]: northbeamPersonIds["Sam Patel"] },
    });
  });

  it("an inactive client is simulated exactly as if they weren't there", () => {
    const hidden = withHandMade(named, { active: false });
    expect(toEngineModel(hidden, { startDate: START })).toEqual(toEngineModel(named, { startDate: START }));
    expect(headline(hidden)).toBe(headline(named));
  });

  it("so is one who starts after the run does", () => {
    expect(toEngineModel(withHandMade(named, { start_date: "2027-01-01" }), { startDate: START })).toEqual(toEngineModel(named, { startDate: START }));
  });

  it("an active client added by hand changes the results", () => {
    expect(headline(withHandMade(named))).not.toBe(headline(named));
  });
});
