import type { Meta, StoryObj } from "@storybook/react-vite";
import type { ReactNode } from "react";
import { partOf } from "@transpera-flow/db";
import { Card } from "@/components/ui/card";
import { MrrChart } from "@/components/overview/charts";
import { OpenIssuesSummary, TimeSplitChart } from "@/components/overview/trend-charts";
import { timeSplitByProcess } from "@/lib/overview/health";
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

export const OpenIssues: StoryObj = {
  name: "OpenIssuesSummary",
  tags: ["visual-phone"],
  render: () => (
    <Frame>
      <OpenIssuesSummary
        byRating={[
          { rating: "risk", count: 2 },
          { rating: "bad", count: 5 },
          { rating: "good", count: 3 },
          { rating: "great", count: 1 },
        ]}
        byProcess={[
          { id: "p1", name: "Sales pipeline", count: 6, href: "#sales" },
          { id: "p2", name: "Client delivery", count: 4 },
          { id: "p3", name: "Billing", count: 1 },
          { id: "p4", name: "Reporting", count: 1 },
        ]}
      />
    </Frame>
  ),
};

export const OpenIssuesEmpty: StoryObj = {
  name: "OpenIssuesSummary (empty)",
  render: () => (
    <Frame>
      <OpenIssuesSummary
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
