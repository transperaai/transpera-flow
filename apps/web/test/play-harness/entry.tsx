// The free-play Sandbox's view on a bare page, for ../play-browser.test.ts: the real components with their simulations in a real Web Worker, fed with the
// engine fixture `capacityModel()` as today's model (its changes taken out: a real workspace's changes are part of solutions, D53) and the Set up
// data that agrees with it (made-up data). Next's modules are stood in for by ../build-harness.ts. Nothing here ships.
//
// A bare page has no workspace bundle, so the levers the runner takes through the bundle (hires, someone leaving, a map version) are done here on the model, in
// `prepareOnModel`; the bundle path itself is covered by apps/web/test/sandbox-play.test.ts. `Worker` is replaced by one that starts the bundled script the
// test hands over as `window.workerScripts`.

import { useMemo, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { applyPlay, capacitySetupFromModel, defaultPlay, hireIds, winMix, type PlayContext, type PlayState } from "@transpera-flow/db";
import { calendarMonthStarts, warmupOf, type PreparedPlay } from "@transpera-flow/db/sandbox";
import { capacityModel, type EngineModel } from "@transpera-flow/engine";
import { PlayView } from "@/components/sandbox/play-view";
import type { PlayHorizon, PlayProcess } from "@/components/sandbox/play-types";

declare global {
  interface Window {
    workerScripts: Record<string, string>;
    mountPlay: (options?: { payHidden?: boolean }) => void;
    unmountPlay: () => void;
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
const { changes: _changes, ...today } = full;
void _changes;
// The fixture's steps name no purpose; give them the workspace's, in turn, so "Where the time goes" has something to split.
const PURPOSES = ["client_job", "required", "winning", "coordination", "fixing", "removable"];
const model: EngineModel = { ...today, steps: today.steps.map((s, i) => ({ ...s, purpose: PURPOSES[i % PURPOSES.length] })) };

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
  solutions: [{ id: `sol-${id}`, name: `Faster ${p.name}`, issue: i === 0 ? "Reporting takes too long" : null, status: "testing" as const }],
}));

/** The run's segments on the model alone: hires, leavers and a map version are done here (the bundle path does them in the runner). */
function prepareOnModel(play: PlayState, ctx: PlayContext, horizon = 12): PreparedPlay {
  const monthStarts = calendarMonthStarts(START, Math.round((horizon * 52) / 12), model.hoursPerWeek);
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
  // The run's length follows the horizon, as the page's prepareScenario sets it.
  m = { ...m, horizonWeeks: Math.round((horizon * 52) / 12) };
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

window.mountPlay = ({ payHidden } = {}) => {
  const setup = capacitySetupFromModel(model, { payHidden });
  for (const s of setup.services) s.price_rise_churn = 0.5;
  const ctx: PlayContext = { startDate: START, setup, winMix: (d) => winMix(setup, model, d) };
  root = createRoot(document.getElementById("root")!);
  root.render(<Harness setup={setup} ctx={ctx} />);
};

/** The page's part: how far ahead the run goes (the filter above the charts), and every run prepared for it. */
function Harness({ setup, ctx }: { setup: ReturnType<typeof capacitySetupFromModel>; ctx: PlayContext }) {
  const [horizon, setHorizon] = useState<PlayHorizon>(12);
  const todayPlan = useMemo(() => prepareOnModel(defaultPlay(), ctx, horizon), [ctx, horizon]);
  const prepare = useMemo(() => (play: PlayState) => prepareOnModel(play, ctx, horizon), [ctx, horizon]);
  return (
    // The page's frame: one page that scrolls as a whole (no viewport-height frame).
    <div className="flex min-w-0 flex-col">
      <PlayView
        setup={setup}
        processes={processes}
        startDate={START}
        horizon={horizon}
        onHorizon={setHorizon}
        today={todayPlan}
        prepare={prepare}
        // A stand-in for the company map's canvas (a bare page has no workspace bundle): a card per process, the page's click and badge hooks.
        map={(_runs, api) => (
          <div data-company-map className="flex h-[65svh] min-h-[28rem] flex-wrap content-start gap-6 overflow-hidden rounded-xl border p-6">
            {processes.map((p) => (
              <div key={p.id} className="relative">
                <button
                  type="button"
                  data-id={p.id}
                  data-new-version={api.badges.has(p.id) ? "true" : undefined}
                  onClick={() => api.onProcess(p.id, p.id)}
                  className={`w-48 rounded-lg border-2 border-dashed px-3 py-3 text-left text-sm font-semibold ${api.badges.has(p.id) ? "border-accent" : ""}`}
                >
                  {p.name}
                </button>
                {api.badges.has(p.id) && <span data-version-badge className="absolute -bottom-3 left-2 rounded-full border border-accent bg-white px-2 text-xs">{api.badges.get(p.id)}</span>}
              </div>
            ))}
          </div>
        )}
        base="/w/example"
      />
    </div>
  );
}

window.unmountPlay = () => {
  root?.unmount();
  root = null;
};
