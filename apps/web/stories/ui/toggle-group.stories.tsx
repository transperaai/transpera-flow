import type { Meta, StoryObj } from "@storybook/react-vite";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

const meta: Meta = { title: "UI/ToggleGroup" };
export default meta;

export const Variants: StoryObj = {
  render: () => (
    <div className="flex flex-col gap-4">
      {(["default", "outline"] as const).flatMap((variant) =>
        (["sm", "default", "lg"] as const).map((size) => (
          <ToggleGroup key={`${variant}-${size}`} type="single" variant={variant} size={size} defaultValue="b">
            <ToggleGroupItem value="a">
              {variant} {size}
            </ToggleGroupItem>
            <ToggleGroupItem value="b">Selected</ToggleGroupItem>
            <ToggleGroupItem value="c" disabled>
              Disabled
            </ToggleGroupItem>
          </ToggleGroup>
        )),
      )}
      <ToggleGroup type="single" variant="outline" spacing={0} defaultValue="b">
        <ToggleGroupItem value="a">Joined</ToggleGroupItem>
        <ToggleGroupItem value="b">Selected</ToggleGroupItem>
        <ToggleGroupItem value="c">Joined</ToggleGroupItem>
      </ToggleGroup>
    </div>
  ),
};
