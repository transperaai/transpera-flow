import type { Meta, StoryObj } from "@storybook/react-vite";
import { RATINGS } from "@transpera-flow/engine";
import { RatingPill as OverviewRatingPill } from "@/components/overview/rating-pill";
import { RatingDot, RatingPill } from "@/components/processes/rating";

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

export const ProcessPillsAndDots: StoryObj = {
  name: "Processes RatingPill and RatingDot",
  render: () => (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        {[...RATINGS, null].map((r) => (
          <RatingPill key={r ?? "none"} rating={r} />
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        {[...RATINGS, null].map((r) => (
          <RatingDot key={r ?? "none"} rating={r} />
        ))}
      </div>
    </div>
  ),
};
