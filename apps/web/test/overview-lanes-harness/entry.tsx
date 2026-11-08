// The real Overview on a bare page with the example agency's company map (made-up data), for ../overview-lanes-browser.test.ts: the department
// lanes on the company map. The test loads the example into a throwaway database with the real migrations, reads the workspace the way the
// Overview page does, and hands the result over as JSON. Next's modules and Server Actions are stood in for by ../build-harness.ts.
// Nothing here ships.

import { createRoot } from "react-dom/client";
import type { ProcessBundle, ProcessPart } from "@transpera-flow/db";
import { Overview } from "@/components/overview/overview";
import { SidebarProvider } from "@/components/ui/sidebar";
import type { DepartmentLaneInput } from "@/lib/overview/department-lanes";

export interface LanesData {
  live: ProcessBundle;
  parts: ProcessPart[];
  company: ProcessPart | null;
  laneInput: DepartmentLaneInput;
}

declare global {
  interface Window {
    workerScripts: Record<string, string>;
    mountLanes: (data: LanesData) => void;
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

window.mountLanes = (data) =>
  createRoot(document.getElementById("root")!).render(
    <SidebarProvider>
      <Overview
        workspaceName="Example agency"
        live={data.live}
        parts={data.parts}
        company={data.company}
        laneInput={data.laneInput}
        issues={[]}
        mode="live"
        startDate="2026-11-02"
        hrefs={Object.fromEntries(data.parts.map((p) => [p.process.id, `/w/example/p/${p.process.id}`]))}
        processesHref="/w/example/processes"
        forecastHref="/w/example/sandbox"
      />
    </SidebarProvider>,
  );
