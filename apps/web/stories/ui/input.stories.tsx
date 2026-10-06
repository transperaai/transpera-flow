import type { Meta, StoryObj } from "@storybook/react-vite";
import { Input } from "@/components/ui/input";

const meta: Meta = { title: "UI/Input" };
export default meta;

export const Variants: StoryObj = {
  render: () => (
    <div className="flex max-w-sm flex-col gap-3">
      <Input placeholder="Placeholder" />
      <Input defaultValue="With a value" />
      <Input type="number" defaultValue={42} />
      <Input type="date" defaultValue="2026-10-05" />
      <Input defaultValue="Disabled" disabled />
      <Input defaultValue="Invalid" aria-invalid />
    </div>
  ),
};
