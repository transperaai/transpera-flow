import type { Meta, StoryObj } from "@storybook/react-vite";
import { DEFAULT_PURPOSES } from "@transpera-flow/db";
import { SandboxExportMenu } from "@/components/sandbox/export-menu";
import { PrintSummary } from "@/components/sandbox/print-summary";
import { Timing } from "@/components/sandbox/timing";
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
