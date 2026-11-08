import type { Meta, StoryObj } from "@storybook/react-vite";
import { DEFAULT_PURPOSES } from "@transpera-flow/db";
import { SandboxExportMenu } from "@/components/sandbox/export-menu";
import { PrintSummary } from "@/components/sandbox/print-summary";
import { Timing } from "@/components/sandbox/timing";
import { GoalSeekDialog } from "@/components/sandbox/goal-seek-dialog";
import { Tornado, TornadoBars } from "@/components/sandbox/tornado";
import { timelineMonths } from "@/lib/forecast/timeline";
import { ENGINE_VERSION } from "@transpera-flow/engine";
import { DEMO_FORECAST_START, northbeamForecast, northbeamSandboxPair } from "../fixtures";

const meta: Meta = { title: "Shared/Sandbox extras" };
export default meta;

function pair() {
  const p = northbeamSandboxPair();
  const { cutoffs } = northbeamForecast();
  const eff = [{ change: p.hireChange, scenarioId: "s", scenarioName: "Hire in January", inherited: false }];
  const columns = [
    { name: "No changes", monthly: p.live, priceRise: null, changes: [] },
    { name: "Hire in January", monthly: p.hire, priceRise: null, changes: eff },
  ];
  const months = timelineMonths(DEMO_FORECAST_START, p.live.months, p.model.hoursPerWeek);
  return { ...p, cutoffs, columns, months, eff, ctx: { bundle: p.bundle, solutions: [] } };
}

export const ExportMenu: StoryObj = {
  render: () => {
    const p = pair();
    return (
      <SandboxExportMenu
        fileName="Northbeam Hire in January"
        disabledReason={null}
        data={{ columns: p.columns, months: p.months, model: p.model, categories: DEFAULT_PURPOSES, currency: "GBP", ctx: p.ctx }}
        hasCosts
        includeCosts
        onIncludeCosts={() => {}}
        onPrint={() => {}}
      />
    );
  },
};

export const ExportMenuWaiting: StoryObj = {
  render: () => <SandboxExportMenu fileName="Northbeam" disabledReason="Wait for the run to finish." data={null} hasCosts={false} includeCosts onIncludeCosts={() => {}} onPrint={() => {}} />,
};

export const PrintedSummary: StoryObj = {
  render: () => {
    const p = pair();
    return (
      <PrintSummary
        inline
        workspaceName="Northbeam Digital"
        title="Hire in January"
        printedOn="2026-10-05"
        startDate={DEMO_FORECAST_START}
        horizonMonths={12}
        engineVersion={ENGINE_VERSION}
        model={p.model}
        bundle={p.bundle}
        columns={p.columns}
        cutoffs={p.cutoffs}
        categories={DEFAULT_PURPOSES}
        currency="GBP"
        costs
        timingLine="Capacity runs out in February 2027: PPC specialist is 91% busy on average."
        ctx={p.ctx}
      />
    );
  },
};

export const When: StoryObj = {
  tags: ["visual-phone"],
  render: () => {
    const p = pair();
    return (
      <div className="w-full max-w-3xl">
        <Timing monthly={p.live} months={p.months} model={p.model} roleNames={Object.fromEntries(Object.entries(p.model.roles).map(([id, r]) => [id, r.name]))} cutoffs={p.cutoffs} horizonMonths={12} changes={[]} live={p.bundle} solutions={[]} startDate={DEMO_FORECAST_START} ctx={p.ctx} currency="GBP" canSeeMoney />
      </div>
    );
  },
};

export const TornadoBarsChart: StoryObj = {
  tags: ["visual-phone"],
  render: () => {
    const bar = (leverId: string, label: string, lowDelta: number, highDelta: number, negligible = false) => ({ leverId, label, lowLabel: "−10%", highLabel: "+10%", low: 100 + lowDelta, high: 100 + highDelta, lowDelta, highDelta, size: Math.max(Math.abs(lowDelta), Math.abs(highDelta)), negligible });
    return (
      <div className="w-full max-w-3xl">
        <TornadoBars
          measure="Profit over the run"
          fmtDelta={(v) => (v === null ? "no number" : `${v < 0 ? "−" : "+"}£${Math.abs(v).toLocaleString("en-GB")}`)}
          bars={[bar("A1", "Opportunities coming in", -8200, 8400), bar("B2", "Fees", -6100, 6300), bar("D5", "Headcount: PPC specialist", 2400, -3100), bar("A3", "Conversion rate", -900, 950), bar("E2", "Waiting time", -20, 15, true)]}
        />
      </div>
    );
  },
};

export const TornadoIdle: StoryObj = {
  render: () => {
    const p = pair();
    return <Tornado run={{ bundle: p.bundle, solutions: [], months: 12, startDate: DEMO_FORECAST_START }} base={[]} model={p.model} hiddenLevers={[]} cutoffs={p.cutoffs} categories={DEFAULT_PURPOSES} currency="GBP" canSeeMoney canAnalyse canAdd onUse={() => {}} />;
  },
};

export const GoalSeek: StoryObj = {
  render: () => {
    const p = pair();
    return (
      <GoalSeekDialog
        run={{ bundle: p.bundle, solutions: [], months: 12, startDate: DEMO_FORECAST_START }}
        base={[]}
        cutoffs={p.cutoffs}
        roles={Object.entries(p.model.roles).map(([id, r]) => ({ id, name: r.name }))}
        steps={[]}
        services={[]}
        months={p.months.map((m, i) => ({ value: `2026-${String(i + 1).padStart(2, "0")}`, label: m.long }))}
        currency="GBP"
        canSeeMoney
        canAnalyse
        canAdd
        onAdd={() => {}}
        onClose={() => {}}
      />
    );
  },
};
