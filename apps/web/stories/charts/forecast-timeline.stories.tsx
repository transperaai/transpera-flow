import type { Meta, StoryObj } from "@storybook/react-vite";
import { ForecastTimeline, TimelineLegend } from "@/components/forecast/forecast-timeline";
import { northbeamForecast } from "../fixtures";

const meta: Meta = { title: "Charts/ForecastTimeline" };
export default meta;

export const ByRole: StoryObj = {
  tags: ["visual-phone"],
  render: () => {
    const { data, cutoffs } = northbeamForecast();
    return (
      <div className="flex w-full max-w-5xl flex-col gap-3 rounded-xl border bg-card p-4">
        <ForecastTimeline data={data} rows="roles" cutoffs={cutoffs} label="How busy each role is, month by month" />
        <TimelineLegend busyLine={cutoffs[1]} hasMarkers={data.markers.length > 0} hasMarket />
      </div>
    );
  },
};

export const ByPerson: StoryObj = {
  tags: ["visual-phone"],
  render: () => {
    const { data, cutoffs } = northbeamForecast();
    return (
      <div className="w-full max-w-5xl rounded-xl border bg-card p-4">
        <ForecastTimeline data={data} rows="people" cutoffs={cutoffs} label="How busy each person is, month by month" />
      </div>
    );
  },
};

export const Legend: StoryObj = {
  tags: ["visual-phone"],
  render: () => (
    <div className="flex flex-col gap-4">
      <TimelineLegend busyLine={0.85} hasMarkers hasMarket hasUncovered />
      <TimelineLegend busyLine={0.85} hasMarkers={false} hasMarket={false} />
    </div>
  ),
};
