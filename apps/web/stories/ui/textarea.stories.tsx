import type { Meta, StoryObj } from "@storybook/react-vite";
import { Textarea } from "@/components/ui/textarea";

const meta: Meta = { title: "UI/Textarea" };
export default meta;

export const Variants: StoryObj = {
  render: () => (
    <div className="flex max-w-sm flex-col gap-3">
      <Textarea placeholder="Placeholder" />
      <Textarea defaultValue="With a value, over more than one line of text so that it wraps inside the box." />
      <Textarea defaultValue="Disabled" disabled />
      <Textarea defaultValue="Invalid" aria-invalid />
    </div>
  ),
};
