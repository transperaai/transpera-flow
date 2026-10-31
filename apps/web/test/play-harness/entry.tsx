// The free-play Sandbox's view on a bare page, for ../play-browser.test.ts: the real components with their simulations in a real Web Worker, fed with the
// engine fixture `capacityModel()` as today's model (its changes taken out, as a real workspace has none swapped in, and kept as the library) and the Set up
// data that agrees with it (made-up data). Next's modules are stood in for by ../build-harness.ts. Nothing here ships.
//
// A bare page has no workspace bundle, so the levers the runner takes through the bundle (hires, someone leaving, a map version) are done here on the model, in
// `prepareOnModel`; the bundle path itself is covered by apps/web/test/sandbox-play.test.ts. `Worker` is replaced by one that starts the bundled script the
// test hands over as `window.workerScripts`.

import { createRoot, type Root } from "react-dom/client";
import { applyPlay, capacitySetupFromModel, defaultPlay, hireIds, winMix, type CapacityChangeRow, type PlayContext, type PlayState } from "@transpera-flow/db";
import { calendarMonthStarts, warmupOf, type PreparedPlay } from "@transpera-flow/db/sandbox";
import { capacityModel, type EngineModel } from "@transpera-flow/engine";
import { PlayView } from "@/components/sandbox/play-view";
import type { PlayProcess } from "@/components/sandbox/play-types";

declare global {
  interface Window {
    workerScripts: Record<string, string>;
    mountPlay: (options?: { viewer?: boolean; payHidden?: boolean }) => void;
    unmountPlay: () => void;
    __saved: CapacityChangeRow[];
  }
}

const NativeWorker = window.Worker;
window.Worker = class extends NativeWorker {
  constructor(url: string | URL) {
    const file = String(url).split("/").pop()!;
    const script = window.workerScripts[file];
    if (!script) throw new Error(`No bundled worker for ${file}`);
    super(URL.createObjectURL(new Blob([script], { type: "text/javascript" })));
  }
} as typeof Worker;

const START = "2026-11-02";
const full = capacityModel();
const { changes: engineChanges, ...today } = full;
const model: EngineModel = today;

const library: CapacityChangeRow[] = (engineChanges ?? []).map((c) => ({
  id: c.id,
  name: c.name,
  kind: c.kind,
  effects: c.effects,
  adoption: c.adoption,
  ramp_months: c.rampMonths,
  tiers: c.tiers ?? null,
  cost_monthly: null,
  issue_id: null,
  source: "estimate",
  provenance: {},
}));

const stepName = new Map(model.steps.map((s) => [s.id, s.name]));
const roleName = (id: string | null) => (id ? (model.roles[id]?.name ?? id) : "No one assigned");
const processes: PlayProcess[] = Object.entries(model.servicingProcesses ?? {}).map(([id, p], i) => ({
  id,
  name: p.name,
  steps: p.steps.map((sid) => {
    const s = model.steps.find((x) => x.id === sid)!;
    return { id: sid, name: stepName.get(sid) ?? sid, who: s.toClientManager ? "The client's manager" : roleName(s.role) };
  }),
  // A stand-in for a solution: the process's steps take half the time. (A real one is a copied map; see sandbox-play.test.ts.)
  solutions: [{ id: `sol-${id}`, name: `Faster ${p.name}`, issue: i === 0 ? "Reporting takes too long" : null }],
}));

/** The run's segments on the model alone: hires, leavers and a map version are done here (the bundle path does them in the runner). */
function prepareOnModel(play: PlayState, ctx: PlayContext): PreparedPlay {
  const monthStarts = calendarMonthStarts(START, 52, model.hoursPerWeek);
  const at = (m: number) => (m <= 0 ? 0 : (monthStarts[m - 1] ?? 0));
  let m: EngineModel = { ...model, horizonWeeks: 52 };
  const people = { ...m.people! };
  const planPeople = new Set<string>();
  const ids = hireIds(play);
  play.hires.forEach((h, i) => {
    people[ids[i]!] = { name: "New hire", roles: [h.role], capacity: 40, tiers: ["T1", "T2", "T3"], from: at(h.month) };
    planPeople.add(ids[i]!);
  });
  for (const l of play.leavers) if (people[l.person]) people[l.person] = { ...people[l.person]!, until: at(l.month) };
  m = { ...m, people };
  if (play.churn) {
    const k = 1 + play.churn / 100;
    m = {
      ...m,
      churnMonthly: m.churnMonthly * k,
      services: Object.fromEntries(Object.entries(m.services ?? {}).map(([id, s]) => [id, { ...s, churnMonthly: s.churnMonthly * k }])),
      clientGroups: m.clientGroups ? Object.fromEntries(Object.entries(m.clientGroups).map(([id, g]) => [id, { ...g, churnMonthly: g.churnMonthly * k }])) : m.clientGroups,
    };
  }
  if (play.leads) m = { ...m, leadsPerWeek: m.leadsPerWeek * (1 + play.leads / 100) };
  if (play.price) m = { ...m, churnDrivers: [{ id: "price", weight: 1, enabled: true, value: Math.abs(play.price), month: play.priceFrom + 1 }] };
  m = applyPlay(m, play, ctx, planPeople);
  const start = warmupOf(model);
  const segments = [{ from: 0, model: m }];
  for (const [pid, v] of Object.entries(play.versions)) {
    if (v.month <= 0) {
      segments[0] = { from: 0, model: halve(segments[0]!.model, pid) };
      continue;
    }
    segments.push({ from: v.month, model: halve(segments[segments.length - 1]!.model, pid) });
  }
  const prepared = { segments, pair: null, riseMonths: [], start, monthStarts, markersModel: model, planPeople, problems: [], later: [], error: null } as unknown as PreparedPlay["prepared"];
  return { segments, monthStarts, start, problems: [], error: null, later: [], prepared };
}

function halve(m: EngineModel, processId: string): EngineModel {
  const ids = new Set(m.servicingProcesses?.[processId]?.steps ?? []);
  return { ...m, steps: m.steps.map((s) => (ids.has(s.id) ? { ...s, work: s.work / 2 } : s)) };
}

let root: Root | null = null;

window.mountPlay = ({ viewer, payHidden } = {}) => {
  window.__saved = [];
  const setup = capacitySetupFromModel(model, { payHidden });
  for (const s of setup.services) s.price_rise_churn = 0.5;
  const ctx: PlayContext = { startDate: START, setup, library, winMix: (d) => winMix(setup, model, d) };
  const todayPlan = prepareOnModel(defaultPlay(), ctx);
  root = createRoot(document.getElementById("root")!);
  root.render(
    <div className="p-4">
      <PlayView
        setup={setup}
        library={library}
        processes={processes}
        startDate={START}
        today={todayPlan}
        prepare={(play, current) => prepareOnModel(play, { ...ctx, library: current })}
        canEdit={!viewer}
        issues={[{ id: "00000000-0000-4000-8000-0000000000e1", number: 3, title: "Reporting takes too long" }]}
        saveChange={async (id, input) => {
          const row: CapacityChangeRow = { id: id ?? `new-${window.__saved.length}`, provenance: {}, ...input };
          window.__saved = [...window.__saved.filter((r) => r.id !== row.id), row];
          return { status: "ok", change: row };
        }}
        removeChange={async (id) => {
          window.__saved = window.__saved.filter((r) => r.id !== id);
          return { status: "ok" };
        }}
        base="/w/example"
      />
    </div>,
  );
};

window.unmountPlay = () => {
  root?.unmount();
  root = null;
};
