// Screenshots for Q1 (docs/plans/capacity/q1-shots): the Overview's capacity-driven pieces on the engine fixture `capacityModel()` (the example agency): the whole
// business and the department cards, "What the time achieves" with the example's categories, and Team load by role. Test only, nothing here ships.

import { createRoot } from "react-dom/client";
import { capacitySetupFromModel, hiringAdvice, hiringDelayAt, type CapacitySetup } from "@transpera-flow/db";
import { calendarMonthStarts } from "@transpera-flow/db/sandbox";
import { capacityModel, simulate, type EngineModel } from "@transpera-flow/engine";
import { BusiestPeople } from "@/components/overview/busiest-people";
import { DepartmentTiles, useDepartmentFigures, WholeBusinessHero } from "@/components/overview/department-cards";
import { WhereTimeGoes } from "@/components/overview/where-time-goes";
import { TeamLoad } from "@/components/overview/team-load";
import { TimeAchieves } from "@/components/overview/time-achieves";
import { timelineMonths, type TimelineRow } from "@/lib/forecast/timeline";
import { EXAMPLE_PURPOSES, EXAMPLE_PURPOSE_KEY } from "../../../../packages/db/src/fixtures/capacity-example-purposes";

declare global {
  interface Window {
    workerScripts: Record<string, string>;
    mountShots: () => void;
    shotsReady: boolean;
  }
}

const NativeWorker = window.Worker;
window.Worker = class extends NativeWorker {
  constructor(url: string | URL) {
    const script = window.workerScripts[String(url).split("/").pop()!];
    if (!script) throw new Error("No bundled worker");
    super(URL.createObjectURL(new Blob([script], { type: "text/javascript" })));
  }
} as typeof Worker;

const START = "2026-11-02";

/** The Overview's department figures: Money's hero numbers and tiles, People's busiest people and where the time goes. */
function Departments({ setup, model, purposeNames }: { setup: CapacitySetup; model: EngineModel; purposeNames: Record<string, string> }) {
  const figures = useDepartmentFigures({ setup, model, purposeNames });
  return (
    <>
      <WholeBusinessHero setup={setup} base="/w/example" />
      <DepartmentTiles figures={figures} base="/w/example" currency={setup.currency} />
      <div className="grid gap-6 lg:grid-cols-2">
        <BusiestPeople people={figures.people} failed={!!figures.failure} capacityHref="/w/example/capacity" />
        <WhereTimeGoes rows={figures.rows} failed={!!figures.failure} />
      </div>
    </>
  );
}

window.mountShots = () => {
  const model = capacityModel();
  const setup = capacitySetupFromModel(model);
  // The example loader's mapping: each step's free-text purpose becomes one of the example workspace's categories.
  const withPurposes = { ...model, steps: model.steps.map((s) => ({ ...s, purpose: s.purpose ? (EXAMPLE_PURPOSE_KEY[s.purpose] ?? "client_job") : s.purpose })) };
  const horizon = { ...withPurposes, horizonWeeks: 26 };
  const result = simulate(horizon, 8, 1, { monthly: true, monthStarts: calendarMonthStarts(START, 26, horizon.hoursPerWeek) });
  const monthly = result.monthly!;
  const months = timelineMonths(START, monthly.months, horizon.hoursPerWeek);
  const rows: TimelineRow[] = setup.roles
    .filter((r) => monthly.roles[r.id])
    .map((r) => ({ id: r.id, name: r.name, series: monthly.roles[r.id]!, markers: [] }));
  const advice = hiringAdvice(setup, result, (m) => hiringDelayAt(horizon.market, m));
  createRoot(document.getElementById("root")!).render(
    <div className="mx-auto flex flex-col gap-8 p-4">
      <Departments setup={setup} model={model} purposeNames={Object.fromEntries(EXAMPLE_PURPOSES.map((p) => [p.key, p.name]))} />
      <section className="flex flex-col gap-2 rounded-lg border p-4" data-shot="achieves">
        <h3 className="text-sm font-semibold">What the time achieves</h3>
        <TimeAchieves monthly={monthly} hoursPerWeek={horizon.hoursPerWeek} start={START} categories={EXAMPLE_PURPOSES} sandboxHref="/w/example/sandbox" span="6 months" />
      </section>
      <section className="flex flex-col gap-2 rounded-lg border p-4" data-shot="load">
        <h3 className="text-sm font-semibold">Team load by role</h3>
        <TeamLoad rows={rows} months={months} lines={Object.fromEntries(setup.roles.map((r) => [r.id, r.line]))} fallbackLine={0.85} advice={advice} span="6 months" sandboxHref="/w/example/sandbox" />
      </section>
    </div>,
  );
  window.shotsReady = true;
};
