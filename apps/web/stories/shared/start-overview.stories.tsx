import type { Meta, StoryObj } from "@storybook/react-vite";
import { StartOverview } from "@/components/overview/start-overview";
import { SidebarProvider } from "@/components/ui/sidebar";
import { setupChecklist } from "@/lib/overview/setup";

// The Overview of a workspace with nothing published (issue #243): editors build it out from here; members and viewers read one
// sentence. Fixed data only.

const meta: Meta = { title: "Shared/StartOverview", parameters: { layout: "fullscreen" } };
export default meta;

const ZERO = { roles: 0, people: 0, clients: 0, clientGroups: 0, processes: 0, published: 0 };
const base = "/w/acme";
const create = async () => ({});
const upload = { preview: async () => ({}), create: async () => ({}) } as never;
const draft = { id: "p1", name: "Sales pipeline" };

const frame = (node: React.ReactNode) => (
  <SidebarProvider className="min-h-0">
    <div className="w-full pb-8">{node}</div>
  </SidebarProvider>
);

/** Nothing done yet. Narrow, the edit buttons go and the notice says why. */
export const Editor: StoryObj = {
  tags: ["visual-page", "visual-phone"],
  render: () =>
    frame(
      <StartOverview
        slug="acme"
        name="Acme Ltd"
        canEdit
        checklist={setupChecklist(ZERO, base, null)}
        drafts={[]}
        companyEditHref={`${base}/p/co1/edit?from=${encodeURIComponent(base)}`}
        create={create}
        upload={upload}
        canRestore={false}
      />,
    ),
};

/** Roles and people added, a first process drafted and not yet published. */
export const EditorHalfway: StoryObj = {
  tags: ["visual-page"],
  render: () =>
    frame(
      <StartOverview
        slug="acme"
        name="Acme Ltd"
        canEdit
        checklist={setupChecklist({ ...ZERO, roles: 3, people: 5, processes: 1 }, base, draft)}
        drafts={[draft]}
        companyEditHref={`${base}/p/co1/edit?from=${encodeURIComponent(base)}`}
        create={create}
        upload={upload}
        canRestore={false}
      />,
    ),
};

/** A brand-new workspace, empty enough to restore a backup into. */
export const EditorFresh: StoryObj = {
  tags: ["visual-page"],
  render: () =>
    frame(
      <StartOverview
        slug="acme"
        name="Acme Ltd"
        canEdit
        checklist={setupChecklist(ZERO, base, null)}
        drafts={[]}
        companyEditHref={`${base}/p/co1/edit?from=${encodeURIComponent(base)}`}
        create={create}
        upload={upload}
        canRestore
      />,
    ),
};

/** A member or viewer: one plain sentence, no buttons, names or counts. */
export const Reader: StoryObj = {
  tags: ["visual-page"],
  render: () => frame(<StartOverview slug="acme" name="Acme Ltd" canEdit={false} checklist={null} drafts={[]} companyEditHref={null} canRestore={false} />),
};
