import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SHARE_SNAPSHOT_VERSION, northbeamBundle, redactShareSnapshot, shareSnapshotLeaks, type ScenarioShare, type ShareSecrets, type ShareToggles } from "@transpera-flow/db";
import { ScenarioShareView } from "@/components/sandbox/scenario-share-view";

// The visitor's page of a scenario link (sandbox phase 5b), server-rendered from a redacted copy: what it says before any run finishes, and what it
// must not say. (The runs and the charts are in the browser test.)

const live = northbeamBundle();
const people = live.people.map((p, i) => ({ id: p.id, name: p.name, label: `Team member ${i + 1}` }));
const clients = (live.clients ?? []).map((c, i) => ({ id: c.id, name: c.name, label: `Client ${i + 1}` }));
const secrets: ShareSecrets = { people, clients };
const A = "5c000000-0000-4000-8000-0000000000a1";
const B = "5c000000-0000-4000-8000-0000000000a2";
const role = live.roles[0]!.id;
const ch = (n: number, lever: "A1" | "C1" | "D1", over: Record<string, unknown> = {}) => ({ id: `5c000000-0000-4000-8000-0000000001${String(n).padStart(2, "0")}`, lever, target: null, op: "multiply" as const, value: 1.1, ...over });

function render(toggles: ShareToggles) {
  const raw = {
    v: SHARE_SNAPSHOT_VERSION,
    kind: "scenario",
    toggles,
    workspaceName: "Northbeam",
    scenarioId: B,
    bundle: live,
    scenarios: [
      { id: A, name: "Base plan", description: `${people[0]!.name} wrote this`, parent_id: null, horizon_months: 6, changes: [ch(1, "A1", { value: 1.2, note: "Assumes leads rise" }), ch(2, "C1", { target: role })] },
      { id: B, name: "Hire in March", description: null, parent_id: A, horizon_months: 6, changes: [ch(3, "D1", { target: role, op: "set", value: 1, from: "2027-03", params: { name: people[1]!.name } })] },
    ],
    solutions: [],
    startDate: "2027-01-04",
    months: 6,
    hiddenCostChanges: 0,
  } as unknown as ScenarioShare;
  const snap = redactShareSnapshot(raw, toggles, secrets) as ScenarioShare;
  expect(shareSnapshotLeaks(snap, secrets, toggles)).toEqual([]);
  return { snap, html: renderToStaticMarkup(createElement(ScenarioShareView, { snapshot: snap })) };
}

describe("the scenario link's page", () => {
  it("People off, Financials off: the scenario, its changes with notes and where they come from, a hire without a name, the hidden cost count", () => {
    const { html } = render({ people: false, financials: false });
    expect(html).toContain("Hire in March");
    expect(html).toContain("Builds on");
    expect(html).toContain("Assumes leads rise");
    expect(html).toContain("(from Base plan)");
    expect(html).toMatch(/starts/);
    expect(html).toContain("1 change about costs is hidden on this link.");
    expect(html).toContain("Compare with No changes");
    for (const p of people) expect(html, p.name).not.toContain(p.name);
    for (const c of clients) expect(html, c.name).not.toContain(c.name);
    expect(html).not.toMatch(/Find a value|What matters most|Add change|Acknowledge/);
  });

  it("Financials on: the role cost change is worded, nothing is counted as hidden", () => {
    const { html } = render({ people: false, financials: true });
    expect(html).toContain("Role cost");
    expect(html).not.toContain("about costs");
  });
});
