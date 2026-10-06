import type { Meta, StoryObj } from "@storybook/react-vite";
import { Button } from "@/components/ui/button";

const meta: Meta = { title: "UI/Button" };
export default meta;

const variants = ["default", "outline", "secondary", "ghost", "destructive", "link"] as const;
const sizes = ["xs", "sm", "default", "lg"] as const;
const iconSizes = ["icon-xs", "icon-sm", "icon", "icon-lg"] as const;

export const Variants: StoryObj = {
  render: () => (
    <div className="flex flex-col gap-4">
      {variants.map((v) => (
        <div key={v} className="flex flex-wrap items-center gap-3">
          {sizes.map((s) => (
            <Button key={s} variant={v} size={s}>
              {v} {s}
            </Button>
          ))}
          <Button variant={v} disabled>
            disabled
          </Button>
          <Button variant={v} aria-invalid>
            invalid
          </Button>
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-3">
        {iconSizes.map((s) => (
          <Button key={s} variant="outline" size={s} aria-label={s}>
            +
          </Button>
        ))}
      </div>
    </div>
  ),
};
