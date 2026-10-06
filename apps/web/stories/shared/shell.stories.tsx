import type { Meta, StoryObj } from "@storybook/react-vite";
import { Button } from "@/components/ui/button";
import { SidebarProvider } from "@/components/ui/sidebar";
import { Page, PageHeader } from "@/components/shell/page";
import { ShellHeader } from "@/components/shell/shell-header";

const meta: Meta = { title: "Shared/Shell" };
export default meta;

export const PageHeaderFull: StoryObj = {
  name: "PageHeader",
  tags: ["visual-phone"],
  render: () => (
    <PageHeader
      eyebrow="Improve"
      title="Solutions"
      description="Changes to a process that you have tried out, and what each one fixes."
      actions={
        <>
          <Button variant="outline">Compare</Button>
          <Button>New solution</Button>
        </>
      }
    />
  ),
};

export const PageHeaderPlain: StoryObj = {
  name: "PageHeader (title only)",
  render: () => <PageHeader title="Sources" />,
};

export const ShellHeaderBar: StoryObj = {
  name: "ShellHeader",
  tags: ["visual-phone"],
  render: () => (
    <SidebarProvider className="min-h-0">
      <div className="w-full">
        <ShellHeader title="Overview" />
      </div>
    </SidebarProvider>
  ),
};

export const WholePage: StoryObj = {
  name: "Page",
  tags: ["visual-page", "visual-phone"],
  parameters: { layout: "fullscreen" },
  render: () => (
    <SidebarProvider className="min-h-0">
      <div className="w-full">
        <Page eyebrow="Company" title="People" description="Everyone who does the work, and the roles they cover." actions={<Button>Add person</Button>}>
          <div className="rounded-xl border p-4">Page content sits here, under the header.</div>
        </Page>
      </div>
    </SidebarProvider>
  ),
};
