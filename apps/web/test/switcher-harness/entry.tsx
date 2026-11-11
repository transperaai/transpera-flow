// The sidebar's workspace switcher on a bare page, for ../workspace-switcher-browser.test.ts. Bundled by esbuild and driven
// through `window.mountSwitcher`; nothing here ships.

import { createRoot, type Root } from "react-dom/client";
import { WorkspaceSwitcher } from "@/components/shell/workspace-switcher";
import { SidebarProvider } from "@/components/ui/sidebar";

declare global {
  interface Window {
    mountSwitcher: (count: number) => void;
  }
}

const ALL = [
  { name: "Northbeam Digital", href: "/w/northbeam" },
  { name: "Larkspur Studio", href: "/w/larkspur" },
];

let root: Root | null = null;
window.mountSwitcher = (count) => {
  root?.unmount();
  root = createRoot(document.getElementById("root")!);
  root.render(
    <SidebarProvider>
      <div style={{ width: 260 }}>
        <WorkspaceSwitcher current="Northbeam Digital" subtitle="Workspace" workspaces={ALL.slice(0, count)} />
      </div>
    </SidebarProvider>,
  );
};
