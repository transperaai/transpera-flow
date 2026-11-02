import type { Meta, StoryObj } from "@storybook/react-vite";
import { FloatingTip } from "@/components/ui/floating-tip";

const meta: Meta = { title: "UI/Floating tip" };
export default meta;

// The chart tooltip, drawn on the page rather than in its card, so the card's edge never clips it (Q5).
export const Above: StoryObj = {
  render: () => (
    <div className="h-40">
      <FloatingTip at={{ x: 160, y: 120 }}>
        <p className="font-semibold">Mar 27</p>
        <p>Performance managers 91% busy</p>
      </FloatingTip>
    </div>
  ),
};

export const Side: StoryObj = {
  render: () => (
    <div className="h-40">
      <FloatingTip at={{ x: 160, y: 80 }} placement="side">
        <p>Content: 612 h a month (37%)</p>
      </FloatingTip>
    </div>
  ),
};
