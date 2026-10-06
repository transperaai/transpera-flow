import type { Meta, StoryObj } from "@storybook/react-vite";
import { Separator } from "@/components/ui/separator";

const meta: Meta = { title: "UI/Separator" };
export default meta;

export const Variants: StoryObj = {
  render: () => (
    <div className="flex max-w-sm flex-col gap-3">
      <div>Above</div>
      <Separator />
      <div className="flex h-6 items-center gap-3">
        <span>Left</span>
        <Separator orientation="vertical" />
        <span>Right</span>
      </div>
    </div>
  ),
};
