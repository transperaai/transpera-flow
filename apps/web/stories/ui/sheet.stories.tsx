import type { Meta, StoryObj } from "@storybook/react-vite";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";

const meta: Meta = { title: "UI/Sheet" };
export default meta;

export const Closed: StoryObj = {
  render: () => (
    <Sheet>
      <SheetTrigger asChild>
        <Button variant="outline">Open sheet</Button>
      </SheetTrigger>
    </Sheet>
  ),
};

export const Open: StoryObj = {
  tags: ["visual-page", "visual-phone"],
  render: () => (
    <Sheet open>
      <SheetContent>
        <SheetHeader>
          <SheetTitle>Step details</SheetTitle>
          <SheetDescription>Edit how long this step takes and who does it.</SheetDescription>
        </SheetHeader>
        <SheetFooter>
          <Button>Save</Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  ),
};

export const OpenBottom: StoryObj = {
  tags: ["visual-page"],
  render: () => (
    <Sheet open>
      <SheetContent side="bottom">
        <SheetHeader>
          <SheetTitle>Bottom sheet</SheetTitle>
          <SheetDescription>A sheet that slides up from the bottom.</SheetDescription>
        </SheetHeader>
      </SheetContent>
    </Sheet>
  ),
};
