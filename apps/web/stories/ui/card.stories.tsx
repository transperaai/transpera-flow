import type { Meta, StoryObj } from "@storybook/react-vite";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";

const meta: Meta = { title: "UI/Card" };
export default meta;

export const Variants: StoryObj = {
  render: () => (
    <div className="flex flex-wrap items-start gap-4">
      {(["default", "sm"] as const).map((size) => (
        <Card key={size} size={size} className="w-80">
          <CardHeader>
            <CardTitle>Card {size}</CardTitle>
            <CardDescription>A short description of the card.</CardDescription>
            <CardAction>
              <Button size="xs" variant="outline">
                Edit
              </Button>
            </CardAction>
          </CardHeader>
          <CardContent>Content goes here.</CardContent>
        </Card>
      ))}
      <Card className="w-80">
        <CardHeader>
          <CardTitle>With a footer</CardTitle>
        </CardHeader>
        <CardContent>Content goes here.</CardContent>
        <CardFooter className="gap-2 border-t bg-muted/50 p-3">
          <Button size="sm">Save</Button>
          <Button size="sm" variant="ghost">
            Cancel
          </Button>
        </CardFooter>
      </Card>
    </div>
  ),
};
