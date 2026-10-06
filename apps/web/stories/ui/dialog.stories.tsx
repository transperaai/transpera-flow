import type { Meta, StoryObj } from "@storybook/react-vite";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";

const meta: Meta = { title: "UI/Dialog" };
export default meta;

export const Closed: StoryObj = {
  render: () => (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="outline">Open dialog</Button>
      </DialogTrigger>
    </Dialog>
  ),
};

export const Open: StoryObj = {
  tags: ["visual-page", "visual-phone"],
  render: () => (
    <Dialog open>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Archive this process?</DialogTitle>
          <DialogDescription>It moves out of the list but its history is kept, and you can restore it later.</DialogDescription>
        </DialogHeader>
        <DialogFooter showCloseButton>
          <Button>Archive</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  ),
};
