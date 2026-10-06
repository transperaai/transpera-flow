import type { Meta, StoryObj } from "@storybook/react-vite";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";

const meta: Meta = { title: "UI/ScrollArea" };
export default meta;

export const Variants: StoryObj = {
  render: () => (
    <div className="flex flex-wrap gap-6">
      <ScrollArea className="h-40 w-56 rounded-lg border" type="always">
        <div className="flex flex-col gap-2 p-3">
          {Array.from({ length: 12 }, (_, i) => (
            <div key={i}>Row {i + 1}</div>
          ))}
        </div>
      </ScrollArea>
      <ScrollArea className="w-56 rounded-lg border" type="always">
        <div className="flex w-max gap-4 p-3">
          {Array.from({ length: 10 }, (_, i) => (
            <div key={i} className="w-20 rounded-md bg-muted p-2">
              Col {i + 1}
            </div>
          ))}
        </div>
        <ScrollBar orientation="horizontal" />
      </ScrollArea>
    </div>
  ),
};
