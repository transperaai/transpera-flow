import type { Meta, StoryObj } from "@storybook/react-vite";
import { RATINGS } from "@transpera-flow/engine";
import { RatingPill as OverviewRatingPill } from "@/components/overview/rating-pill";

const meta: Meta = { title: "Shared/Ratings" };
export default meta;

export const OverviewPills: StoryObj = {
  name: "Overview RatingPill",
  render: () => (
    <div className="flex flex-wrap items-center gap-3">
      {RATINGS.map((r) => (
        <OverviewRatingPill key={r} rating={r} />
      ))}
    </div>
  ),
};
