import type { Meta, StoryObj } from "@storybook/react-vite";
import { DEFAULT_PURPOSES } from "@transpera-flow/db";
import { Card } from "@/components/ui/card";
import { TimeBar, TimeChart, TimeLegend } from "@/components/sandbox/time-chart";
import { timeView } from "@/lib/sandbox/time";
import { larkspurTime } from "../fixtures";

const meta: Meta = { title: "Charts/TimeChart" };
export default meta;

const view = () => {
  const { monthly, months } = larkspurTime();
  return timeView(monthly, months, DEFAULT_PURPOSES, { kind: "team" });
};

export const Team: StoryObj = {
  tags: ["visual-phone"],
  render: () => {
    const v = view();
    return (
      <Card className="w-full max-w-5xl gap-3 px-4 py-4">
        <TimeLegend rows={v.rows} />
        <TimeChart view={v} label="Where the team's time goes each month" />
      </Card>
    );
  },
};

export const WholeRunBars: StoryObj = {
  render: () => {
    const v = view();
    const rows = v.rows.map((r) => ({ id: r.id, name: r.name, share: r.runShare, kind: r.kind }));
    return (
      <Card className="w-full max-w-xl gap-3 px-4 py-4">
        <TimeBar rows={rows} label="Where the team's time goes over the run" />
        <TimeBar rows={rows.map((r) => (r.id === "fixing" ? { ...r, share: r.share / 2 } : r))} label="With less fixing" />
      </Card>
    );
  },
};
