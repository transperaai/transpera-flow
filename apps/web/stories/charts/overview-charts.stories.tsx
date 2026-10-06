import type { Meta, StoryObj } from "@storybook/react-vite";
import type { ReactNode } from "react";
import { partOf } from "@transpera-flow/db";
import { Card } from "@/components/ui/card";
import { MrrChart } from "@/components/overview/charts";
import { BeforeAfterChart, IssuesDonut, OpenedResolvedChart, TimeSplitChart } from "@/components/overview/trend-charts";
import { impactNumbers, type SolutionImpact } from "@/lib/overview/impact-run";
import { timeSplitByProcess, type MonthCount } from "@/lib/overview/health";
import type { MrrPoint } from "@/lib/overview/projection";
import { northbeamRun } from "../fixtures";

const meta: Meta = { title: "Charts/Overview" };
export default meta;

// The chart cards of the app: the real Card (its overflow-hidden also clips the charts' screen-reader tables).
const Frame = ({ children }: { children: ReactNode }) => <Card className="w-full max-w-3xl gap-3 px-4 py-4">{children}</Card>;

// Hand-written points: the chart takes plain arrays.
const mrr: MrrPoint[] = [
  { month: 0, mean: 41200, lo: 41200, hi: 41200 },
  { month: 1, mean: 42100, lo: 40800, hi: 43300 },
  { month: 2, mean: 43400, lo: 41200, hi: 45500 },
  { month: 3, mean: 44100, lo: 41300, hi: 46900 },
  { month: 4, mean: 45600, lo: 41900, hi: 49200 },
  { month: 5, mean: 46300, lo: 42000, hi: 50700 },
  { month: 6, mean: 47800, lo: 42600, hi: 52900 },
];
const withSolution: MrrPoint[] = mrr.map((p, i) => ({ month: p.month, mean: p.mean + i * 450, lo: p.lo + i * 300, hi: p.hi + i * 600 }));

export const Mrr: StoryObj = {
  name: "MrrChart",
  tags: ["visual-phone"],
  render: () => (
    <Frame>
      <MrrChart points={mrr} horizonMonths={6} currency="GBP" />
    </Frame>
  ),
};

export const MrrCompare: StoryObj = {
  name: "MrrChart (compare)",
  tags: ["visual-phone"],
  render: () => (
    <Frame>
      <MrrChart points={mrr} horizonMonths={6} currency="GBP" compare={withSolution} />
    </Frame>
  ),
};

export const Donut: StoryObj = {
  name: "IssuesDonut",
  tags: ["visual-phone"],
  render: () => (
    <Frame>
      <IssuesDonut
        byRating={[
          { rating: "risk", count: 2 },
          { rating: "bad", count: 5 },
          { rating: "good", count: 3 },
          { rating: "great", count: 1 },
        ]}
        byProcess={[
          { id: "p1", name: "Sales pipeline", count: 6 },
          { id: "p2", name: "Client delivery", count: 4 },
          { id: "p3", name: "Billing", count: 1 },
        ]}
      />
    </Frame>
  ),
};

export const DonutEmpty: StoryObj = {
  name: "IssuesDonut (empty)",
  render: () => (
    <Frame>
      <IssuesDonut
        byRating={[
          { rating: "risk", count: 0 },
          { rating: "bad", count: 0 },
          { rating: "good", count: 0 },
          { rating: "great", count: 0 },
        ]}
        byProcess={[]}
      />
    </Frame>
  ),
};

export const TimeSplit: StoryObj = {
  name: "TimeSplitChart",
  tags: ["visual-phone"],
  render: () => {
    const { bundle, model, result } = northbeamRun();
    const rows = timeSplitByProcess(model, result, [partOf(bundle)]);
    return (
      <Frame>
        <TimeSplitChart rows={rows} months={Math.round((model.horizonWeeks * 12) / 52)} />
      </Frame>
    );
  },
};

const months: MonthCount[] = [
  { month: "2026-05", label: "May 26", opened: 3, resolved: 1 },
  { month: "2026-06", label: "Jun", opened: 5, resolved: 2 },
  { month: "2026-07", label: "Jul", opened: 2, resolved: 4 },
  { month: "2026-08", label: "Aug", opened: 4, resolved: 3 },
  { month: "2026-09", label: "Sep", opened: 6, resolved: 2 },
  { month: "2026-10", label: "Oct", opened: 1, resolved: 1 },
];

export const OpenedResolved: StoryObj = {
  name: "OpenedResolvedChart",
  tags: ["visual-phone"],
  render: () => (
    <Frame>
      <OpenedResolvedChart months={months} />
    </Frame>
  ),
};

export const OpenedResolvedEmpty: StoryObj = {
  name: "OpenedResolvedChart (empty)",
  render: () => (
    <Frame>
      <OpenedResolvedChart months={months.map((m) => ({ ...m, opened: 0, resolved: 0 }))} />
    </Frame>
  ),
};

export const BeforeAfter: StoryObj = {
  name: "BeforeAfterChart",
  tags: ["visual-phone"],
  render: () => {
    const { bundle, model, result } = northbeamRun();
    const before = impactNumbers(model, result);
    const after = { handsOnPerItem: before.handsOnPerItem * 0.7, itemsPerMonth: before.itemsPerMonth * 1.1, cycleHours: before.cycleHours === null ? null : before.cycleHours * 0.8 };
    const impact = (id: string, name: string, implemented: boolean): SolutionImpact => ({
      id,
      name,
      implemented,
      processId: bundle.process.id,
      processName: bundle.process.name,
      baseRevisionId: bundle.revision.id,
      before,
      after,
    });
    return (
      <Frame>
        <BeforeAfterChart impacts={[impact("s1", "AI lead qualifier", true), impact("s2", "Faster proposals", false)]} hoursPerWeek={model.hoursPerWeek} />
      </Frame>
    );
  },
};

export const BeforeAfterEmpty: StoryObj = {
  name: "BeforeAfterChart (empty)",
  render: () => (
    <Frame>
      <BeforeAfterChart impacts={[]} hoursPerWeek={37.5} />
    </Frame>
  ),
};
