import type { Meta, StoryObj } from "@storybook/react-vite";
import { Badge } from "@/components/ui/badge";

const meta: Meta = { title: "UI/Badge" };
export default meta;

const variants = ["default", "secondary", "destructive", "outline", "ghost", "link"] as const;

export const Variants: StoryObj = {
  render: () => (
    <div className="flex flex-wrap items-center gap-3">
      {variants.map((v) => (
        <Badge key={v} variant={v}>
          {v}
        </Badge>
      ))}
      <Badge aria-invalid>invalid</Badge>
    </div>
  ),
};
