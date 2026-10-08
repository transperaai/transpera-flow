// The start page (issue #243) on a bare page, for ../start-overview-browser.test.ts. Bundled by esbuild and driven through
// `window.mountStart`; nothing here ships.

import { createRoot, type Root } from "react-dom/client";
import { StartOverview } from "@/components/overview/start-overview";
import { SidebarProvider } from "@/components/ui/sidebar";
import { setupChecklist } from "@/lib/overview/setup";

declare global {
  interface Window {
    mountStart: (opts: { canEdit: boolean }) => void;
    created: string[];
  }
}

const ZERO = { roles: 1, people: 0, clients: 0, clientGroups: 0, processes: 0, published: 0 };
const base = "/w/acme";

let root: Root | null = null;
window.created = [];
window.mountStart = ({ canEdit }) => {
  root?.unmount();
  root = createRoot(document.getElementById("root")!);
  root.render(
    <SidebarProvider className="min-h-0">
      <div className="w-full">
        <StartOverview
          slug="acme"
          name="Acme Ltd"
          canEdit={canEdit}
          checklist={canEdit ? setupChecklist(ZERO, base, null) : null}
          drafts={[]}
          companyEditHref={canEdit ? `${base}/p/co1/edit?from=${encodeURIComponent(base)}` : null}
          create={
            canEdit
              ? async (_prev, form) => {
                  window.created.push(String(form.get("name")));
                  return {};
                }
              : undefined
          }
          upload={canEdit ? { preview: async () => ({}) as never, create: async () => ({}) as never } : undefined}
          canRestore={false}
        />
      </div>
    </SidebarProvider>,
  );
};
