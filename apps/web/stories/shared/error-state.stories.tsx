import type { Meta, StoryObj } from "@storybook/react-vite";
import { ErrorState } from "@/components/shell/error-state";

const meta: Meta<typeof ErrorState> = { title: "Shared/ErrorState", component: ErrorState };
export default meta;

type Story = StoryObj<typeof ErrorState>;

export const Default: Story = {
  tags: ["visual-phone"],
  args: { onRetry: () => undefined, homeHref: "/" },
};

export const WithReference: Story = {
  tags: ["visual-phone"],
  args: { digest: "2814639521", onRetry: () => undefined, homeHref: "/w/northbeam" },
};
