// Settings, Churn drivers and Services on a bare page, for ../drivers-browser.test.ts (sandbox phase 3): the real components, the
// simulation in a real Web Worker, the Server Actions stood in for by ../build-harness.ts. Nothing here ships.

import { createRoot } from "react-dom/client";
import { ChurnDriversSettings } from "@/app/w/[slug]/settings/churn-drivers-settings";
import { ServicesSettings } from "@/app/w/[slug]/settings/services-settings";
import { demoBundle } from "@/lib/sources/demo";
import type { WorkspaceSettingsData } from "@/lib/data";

declare global {
  interface Window {
    workerScripts: Record<string, string>;
    mountDrivers: (options: { readonly?: boolean }) => void;
    __serverActions?: { name: string; args: unknown[] }[];
  }
}

const NativeWorker = window.Worker;
window.Worker = class extends NativeWorker {
  constructor(url: string | URL) {
    const file = String(url).split("/").pop()!;
    const script = window.workerScripts[file];
    if (!script) throw new Error(`No bundled worker for ${file}`);
    super(URL.createObjectURL(new Blob([script], { type: "text/javascript" })));
  }
} as typeof Worker;

window.mountDrivers = ({ readonly = false }) => {
  const bundle = demoBundle();
  const data = { workspace: bundle.workspace, canEdit: !readonly, canManage: !readonly, services: bundle.services, roles: bundle.roles, processes: [], conditionTags: [], servicingLinks: [] } as unknown as WorkspaceSettingsData;
  createRoot(document.getElementById("root")!).render(
    <div className="flex flex-col gap-6 p-4">
      <ChurnDriversSettings mode={readonly ? "readonly" : "demo"} workspaceId={null} bundle={bundle} rows={[]} />
      <ServicesSettings data={data} />
    </div>,
  );
};
