// The real free-play Sandbox page on a bare page with the example agency (made-up data), for ../q16-sandbox-map.test.ts: the company map with its version
// popover, the run in a real Web Worker. The test loads the example into a throwaway database with the real migrations,
// reads the workspace the way the Sandbox page does and hands the result over as JSON. Next's modules and Server Actions are stood in for by
// ../build-harness.ts. Nothing here ships.

import { createRoot } from "react-dom/client";
import type { CapacitySetup, IssueRow, ProcessBundle, ProcessPart, SolutionIssueRow, SolutionRow } from "@transpera-flow/db";
import { PlayPage } from "@/components/sandbox/play-page";
import type { DepartmentLaneInput } from "@/lib/overview/department-lanes";

export interface Q16Data {
  live: ProcessBundle;
  parts: ProcessPart[];
  company: ProcessPart | null;
  setup: CapacitySetup;
  solutions: SolutionRow[];
  solutionLinks: SolutionIssueRow[];
  issues: IssueRow[];
  laneInput: DepartmentLaneInput;
}

declare global {
  interface Window {
    workerScripts: Record<string, string>;
    mountQ16: (data: Q16Data, options?: { solution?: string; viewer?: boolean }) => void;
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

window.mountQ16 = (data, options = {}) =>
  createRoot(document.getElementById("root")!).render(
    <div className="mx-auto p-4">
      <PlayPage
        live={data.live}
        parts={data.parts}
        company={data.company}
        setup={data.setup}
        solutions={data.solutions}
        solutionLinks={data.solutionLinks}
        issues={data.issues}
        canEdit={!options.viewer}
        base="/w/example"
        laneInput={data.laneInput}
        initialSolutionId={options.solution ?? null}
      />
    </div>,
  );
