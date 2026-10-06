import type { Meta, StoryObj } from "@storybook/react-vite";
import { Toggle } from "@/components/ui/toggle";

const meta: Meta = { title: "UI/Toggle" };
export default meta;

const variants = ["default", "outline"] as const;
const sizes = ["sm", "default", "lg"] as const;

export const Variants: StoryObj = {
  render: () => (
    <div className="flex flex-col gap-3">
      {variants.map((v) => (
        <div key={v} className="flex flex-wrap items-center gap-3">
          {sizes.map((s) => (
            <Toggle key={s} variant={v} size={s}>
              {v} {s}
            </Toggle>
          ))}
          <Toggle variant={v} defaultPressed>
            pressed
          </Toggle>
          <Toggle variant={v} disabled>
            disabled
          </Toggle>
        </div>
      ))}
    </div>
  ),
};
