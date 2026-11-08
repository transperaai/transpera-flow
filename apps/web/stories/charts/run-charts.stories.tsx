import type { Meta, StoryObj } from "@storybook/react-vite";
import { simulate } from "@transpera-flow/engine";
import { TooltipProvider } from "@/components/ui/tooltip";
import { KpiStrip } from "@/components/kpi-strip";
import { HeaviestSteps, HoursByRole, KeyPersonPanel, SupportingHeadline, TimeSplit } from "@/components/process-supporting-data";
import { processHeadline, processHours } from "@/lib/process-page/hours";
import { keyPersonRows, timeSplitRows } from "@/lib/process-page/supporting";
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

/** The time split (the totals, then the steps that wait longest) and key-person risk grouped by person, side by side as on the page. */
export const SupportingTimeAndPeople: StoryObj = {
  name: "Supporting data: time split and key people",
  tags: ["visual-phone"],
  render: () => {
    const { model } = northbeamRun();
    const result = simulate(model, 10, 1, { personTime: true });
    const ids = new Set(model.steps.map((s) => s.id));
    return (
      <div className="grid w-full max-w-5xl gap-4 lg:grid-cols-2">
        <TimeSplit rows={timeSplitRows(model, result, ids)} result={result} />
        <KeyPersonPanel rows={keyPersonRows(model, result, ids)} hours={processHours(model, result, ids)} result={result} />
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

/** Nine roles: six by name, the last three folded into "Others" (their names on hover and when opened). */
export const HoursPieOthers: StoryObj = {
  name: "Supporting data: hours by role (Others)",
  render: () => {
    const hours = [120, 80, 60, 40, 25, 15, 6, 4, 2];
    const roles = hours.map((h, i) => ({ id: `r${i}`, label: `Role ${i + 1}`, hours: h, people: [{ id: `p${i}`, name: `Person ${i + 1}`, hours: h }] }));
    return (
      <div className="w-full max-w-md">
        <HoursByRole hours={{ total: hours.reduce((a, b) => a + b, 0), roles, steps: [], cells: [] }} result={null} />
      </div>
    );
  },
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
