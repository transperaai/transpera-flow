import type { Meta, StoryObj } from "@storybook/react-vite";
import { InfoIcon, TriangleAlertIcon } from "lucide-react";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

const meta: Meta = { title: "UI/Alert" };
export default meta;

export const Variants: StoryObj = {
  render: () => (
    <div className="flex max-w-xl flex-col gap-3">
      <Alert>
        <InfoIcon />
        <AlertTitle>Heads up</AlertTitle>
        <AlertDescription>The default alert, with an icon.</AlertDescription>
      </Alert>
      <Alert variant="destructive">
        <TriangleAlertIcon />
        <AlertTitle>Something went wrong</AlertTitle>
        <AlertDescription>The destructive alert, with an icon.</AlertDescription>
      </Alert>
      <Alert>
        <AlertTitle>No icon</AlertTitle>
        <AlertDescription>An alert without an icon.</AlertDescription>
      </Alert>
      <Alert>
        <InfoIcon />
        <AlertTitle>With an action</AlertTitle>
        <AlertDescription>An alert with an action button.</AlertDescription>
        <AlertAction>
          <Button size="xs" variant="outline">
            Undo
          </Button>
        </AlertAction>
      </Alert>
    </div>
  ),
};
