import type { Meta, StoryObj } from "@storybook/react-vite";
import { Switch } from "@/components/ui/switch";

const meta: Meta = { title: "UI/Switch" };
export default meta;

export const Variants: StoryObj = {
  render: () => (
    <div className="flex items-center gap-4">
      <Switch aria-label="Off" />
      <Switch aria-label="On" defaultChecked />
      <Switch aria-label="Disabled off" disabled />
      <Switch aria-label="Disabled on" disabled defaultChecked />
    </div>
  ),
};
