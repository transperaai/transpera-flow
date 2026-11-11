// Screenshots for Q3 (docs/plans/capacity/q3-shots): the Processes page and a process page on the example agency's fixture, loaded into a
// database by ../q3-shots.test.ts. Test only, nothing here ships.

import { createRoot } from "react-dom/client";
import type { ProcessBundle } from "@transpera-flow/db";
import { DetailBreadcrumb } from "@/components/issues/detail-layout";
import { ProcessPage } from "@/components/process-page";
import { ProcessesPage } from "@/components/processes/processes-page";
import { SidebarProvider } from "@/components/ui/sidebar";
import type { ProcessRowData } from "@/lib/processes/rows";
import type { TierSetup } from "@/lib/tier-setup";

declare global {
  interface Window {
    workerScripts: Record<string, string>;
    q3ShotData: { rows: ProcessRowData[]; bundle: ProcessBundle; tierSetup: TierSetup };
    mountQ3Shots: (what: "processes" | "process") => void;
  }
}

const NativeWorker = window.Worker;
window.Worker = class extends NativeWorker {
  constructor(url: string | URL) {
    const script = window.workerScripts[String(url).split("/").pop()!];
    if (!script) throw new Error("No bundled worker");
    super(URL.createObjectURL(new Blob([script], { type: "text/javascript" })));
  }
} as typeof Worker;

window.mountQ3Shots = (what) => {
  const { rows, bundle, tierSetup } = window.q3ShotData;
  const root = createRoot(document.getElementById("root")!);
  if (what === "processes") {
    root.render(
      <SidebarProvider>
        <main className="mx-auto w-full p-4">
          <ProcessesPage rows={rows} hrefs={Object.fromEntries(rows.map((r) => [r.id, `/w/example/p/${r.id}`]))} loadCard={async () => null} />
        </main>
      </SidebarProvider>,
    );
  } else {
    root.render(
      <SidebarProvider>
        <div className="p-4">
          <ProcessPage bundle={bundle} liveVersion={1} mode="readonly" historyHref="#" tierSetup={tierSetup} breadcrumb={<DetailBreadcrumb items={[{ label: "Processes", href: "#" }, { label: bundle.process.name }]} />} />
        </div>
      </SidebarProvider>,
    );
  }
};
