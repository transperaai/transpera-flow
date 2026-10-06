import type { Meta, StoryObj } from "@storybook/react-vite";
import { Skeleton } from "@/components/ui/skeleton";

const meta: Meta = { title: "UI/Skeleton" };
export default meta;

export const Variants: StoryObj = {
  render: () => (
    <div className="flex items-center gap-4">
      <Skeleton className="size-10 rounded-full" />
      <div className="flex flex-col gap-2">
        <Skeleton className="h-4 w-60" />
        <Skeleton className="h-4 w-40" />
      </div>
    </div>
  ),
};
