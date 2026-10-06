import type { Meta, StoryObj } from "@storybook/react-vite";
import { Help, HelpLabel } from "@/components/help";

const meta: Meta = { title: "Shared/Help" };
export default meta;

const text = {
  description: "How many weeks a client must stay before the work counts as delivered.",
  example: "With 12 weeks, a client who leaves in week 9 is counted as lost.",
};

export const Closed: StoryObj = {
  render: () => (
    <div className="flex flex-col gap-3">
      <HelpLabel label="Minimum stay" {...text} />
      <p className="flex items-center">
        A sentence with an (i) after it
        <Help label="Minimum stay" {...text} />
      </p>
    </div>
  ),
};

/** Clicking the (i) pins its popover open; the component has no `open` prop, so a plain click does it. */
export const Open: StoryObj = {
  tags: ["visual-page", "visual-phone"],
  render: () => (
    <div className="pt-2">
      <HelpLabel label="Minimum stay" {...text} />
    </div>
  ),
  play: ({ canvasElement }) => {
    canvasElement.querySelector<HTMLButtonElement>("[data-slot=help]")?.click();
  },
};
