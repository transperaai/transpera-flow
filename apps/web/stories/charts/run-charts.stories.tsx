import type { Meta, StoryObj } from "@storybook/react-vite";
import { simulate } from "@transpera-flow/engine";
import { TooltipProvider } from "@/components/ui/tooltip";
import { KpiStrip } from "@/components/kpi-strip";
import { HeaviestSteps, HoursByRole, SupportingHeadline } from "@/components/process-supporting-data";
import { processHeadline, processHours } from "@/lib/process-page/hours";
import { northbeamRun } from "../fixtures";

const meta: Meta = { title: "Charts/Run" };
export default meta;

export const SupportingHours: StoryObj = {
  name: "Supporting data: hours",
  tags: ["visual-phone"],
  render: () => {
    const { bundle, model } = northbeamRun();
    // The hours panels read the run's per-person times, which a run only carries when asked.
    const result = simulate(model, 10, 1, { personTime: true });
    const ids = new Set(model.steps.map((s) => s.id));
    const hours = processHours(model, result, ids);
    return (
      <div className="flex w-full max-w-3xl flex-col gap-3">
        <SupportingHeadline headline={processHeadline(model, result, ids, null)} result={result} />
        <HoursByRole hours={hours} result={result} viewer={bundle.viewer} />
        <HeaviestSteps hours={hours} result={result} />
      </div>
    );
  },
};

export const SupportingHoursNoRun: StoryObj = {
  name: "Supporting data: hours (no run yet)",
  render: () => (
    <div className="flex w-full max-w-3xl flex-col gap-3">
      <SupportingHeadline headline={null} result={null} />
      <HoursByRole hours={null} result={null} />
      <HeaviestSteps hours={null} result={null} />
    </div>
  ),
};

export const Kpis: StoryObj = {
  name: "KpiStrip",
  tags: ["visual-phone"],
  render: () => {
    const { bundle, model, result } = northbeamRun();
    return (
      <TooltipProvider>
        <KpiStrip model={model} currency={bundle.workspace.settings.currency} result={result} status="done" durationMs={420} />
      </TooltipProvider>
    );
  },
};

export const KpisRunning: StoryObj = {
  name: "KpiStrip (running)",
  render: () => {
    const { bundle, model } = northbeamRun();
    return (
      <TooltipProvider>
        <KpiStrip model={model} currency={bundle.workspace.settings.currency} result={null} status="running" />
      </TooltipProvider>
    );
  },
};
