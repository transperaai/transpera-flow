import type { Meta, StoryObj } from "@storybook/react-vite";
import { NativeSelect } from "@/components/ui/native-select";

const meta: Meta = { title: "UI/NativeSelect" };
export default meta;

const options = (
  <>
    <option>First option</option>
    <option>Second option</option>
  </>
);

export const Variants: StoryObj = {
  render: () => (
    <div className="flex max-w-sm flex-col gap-3">
      <NativeSelect defaultValue="First option">{options}</NativeSelect>
      <NativeSelect disabled>{options}</NativeSelect>
      <NativeSelect aria-invalid>{options}</NativeSelect>
    </div>
  ),
};
