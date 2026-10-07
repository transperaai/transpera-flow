import type { Meta, StoryObj } from "@storybook/react-vite";
import type { ReactNode } from "react";
import { SidebarProvider } from "@/components/ui/sidebar";
import {
  CardGridSkeleton,
  ChartSkeleton,
  EditorSkeleton,
  FormSkeleton,
  IssuePageSkeleton,
  ListSkeleton,
  OverviewSkeleton,
  PageSkeleton,
  ProcessPageSkeleton,
  SettingsSkeleton,
  SolutionPageSkeleton,
  TableSkeleton,
} from "@/components/shell/skeletons";

// What each workspace page shows while its server loaders run (issue #44). `Page` needs the shell's sidebar provider for its toggle.

const meta: Meta = { title: "Shared/Skeletons", parameters: { layout: "fullscreen" } };
export default meta;

const Shell = ({ children }: { children: ReactNode }) => (
  <SidebarProvider className="min-h-0">
    <div className="w-full">{children}</div>
  </SidebarProvider>
);

export const Overview: StoryObj = {
  tags: ["visual-phone"],
  render: () => (
    <Shell>
      <OverviewSkeleton />
    </Shell>
  ),
};

export const ProcessPage: StoryObj = {
  tags: ["visual-phone"],
  render: () => (
    <Shell>
      <ProcessPageSkeleton />
    </Shell>
  ),
};

export const Editor: StoryObj = {
  tags: ["visual-phone"],
  render: () => (
    <Shell>
      <EditorSkeleton />
    </Shell>
  ),
};

export const Settings: StoryObj = {
  tags: ["visual-phone"],
  render: () => (
    <Shell>
      <PageSkeleton title="Settings" eyebrow="Company">
        <SettingsSkeleton />
      </PageSkeleton>
    </Shell>
  ),
};

export const List: StoryObj = {
  tags: ["visual-phone"],
  render: () => (
    <Shell>
      <PageSkeleton title="Issues" eyebrow="Improve">
        <ListSkeleton />
      </PageSkeleton>
    </Shell>
  ),
};

export const CardGrid: StoryObj = {
  tags: ["visual-phone"],
  render: () => (
    <Shell>
      <PageSkeleton title="Solutions" eyebrow="Improve">
        <CardGridSkeleton />
      </PageSkeleton>
    </Shell>
  ),
};

export const Table: StoryObj = {
  tags: ["visual-phone"],
  render: () => (
    <Shell>
      <PageSkeleton title="People" eyebrow="Company" width="max-w-6xl">
        <TableSkeleton />
      </PageSkeleton>
    </Shell>
  ),
};

export const Form: StoryObj = {
  tags: ["visual-phone"],
  render: () => (
    <Shell>
      <PageSkeleton title="Restore a backup" eyebrow="Workspace" width="max-w-3xl">
        <FormSkeleton />
      </PageSkeleton>
    </Shell>
  ),
};

export const Chart: StoryObj = {
  tags: ["visual-phone"],
  render: () => (
    <Shell>
      <PageSkeleton title="Forecast" eyebrow="Company" width="max-w-6xl">
        <ChartSkeleton />
      </PageSkeleton>
    </Shell>
  ),
};

export const IssuePage: StoryObj = {
  tags: ["visual-phone"],
  render: () => (
    <Shell>
      <IssuePageSkeleton />
    </Shell>
  ),
};

export const SolutionPage: StoryObj = {
  tags: ["visual-phone"],
  render: () => (
    <Shell>
      <SolutionPageSkeleton />
    </Shell>
  ),
};
