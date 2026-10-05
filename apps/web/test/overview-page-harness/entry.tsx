// The real Overview (issue #173, B15) on a bare page, for ../overview-page-browser.test.ts: the whole page component, with
// its simulations in real Web Workers, so a test can count the runs it asks for. Next's modules and Server Actions are
// stood in for by ../build-harness.ts. Nothing here ships.
//
// The page's workers are made with `new Worker(new URL("../../workers/<name>.ts", import.meta.url))`. The test bundles each
// worker script and hands it over as `window.workerScripts`; `Worker` is replaced by one that starts the bundled script for
// the file asked for, and notes every message posted to it in `window.workerPosts` (one per run asked for).

import { createRoot } from "react-dom/client";
import { northbeamIssues, partOf, type IssueRow, type SolutionRow } from "@transpera-flow/db";
import { Overview } from "@/components/overview/overview";
import { SidebarProvider } from "@/components/ui/sidebar";
import { DEMO_FORECAST_START } from "@/lib/forecast/demo";
import { solutionCopy } from "@/lib/solutions/bundle";
import { demoBundle } from "@/lib/sources/demo";

declare global {
  interface Window {
    workerScripts: Record<string, string>;
    /** The worker file of each message posted to a worker, in order. */
    workerPosts: string[];
    mountOverview: () => void;
  }
}

const NativeWorker = window.Worker;
window.workerPosts = [];
window.Worker = class extends NativeWorker {
  private readonly file: string;
  constructor(url: string | URL) {
    const file = String(url).split("/").pop()!;
    const script = window.workerScripts[file];
    if (!script) throw new Error(`No bundled worker for ${file}`);
    super(URL.createObjectURL(new Blob([script], { type: "text/javascript" })));
    this.file = file;
  }
  postMessage(message: unknown, options?: StructuredSerializeOptions | Transferable[]) {
    window.workerPosts.push(this.file);
    super.postMessage(message, options as StructuredSerializeOptions);
  }
} as typeof Worker;

const live = demoBundle();
const parts = [partOf(live), ...(live.otherProcesses ?? [])];

// One solution, implemented (an issue was resolved by it): a copy of Lead to live with one task made quicker.
const copy = solutionCopy(live);
const target = copy.steps.find((s) => s.kind === "task" && Number(s.work_hours) > 1)!;
target.work_hours = 0.1 as never;
const solution: SolutionRow = {
  id: "s-faster",
  workspace_id: live.workspace.id,
  process_id: live.process.id,
  base_revision_id: live.revision.id,
  name: "Faster audits",
  notes: "",
  steps: copy,
  changed_step_ids: [target.id],
  lever_changes: [],
  created_at: "2026-09-01T00:00:00Z",
  updated_at: "2026-09-01T00:00:00Z",
  created_by: null,
};
const resolved: IssueRow = {
  ...northbeamIssues()[0]!,
  id: "i-resolved",
  workspace_id: live.workspace.id,
  number: 1,
  title: "Audits take too long",
  process_id: live.process.id,
  step_id: target.id,
  links: [],
  severity: "serious",
  status: "resolved",
  detected_key: null,
  resolved_solution_id: solution.id,
  created_at: "2026-09-01T00:00:00Z",
  resolved_at: "2026-09-20T00:00:00Z",
};

window.mountOverview = () =>
  createRoot(document.getElementById("root")!).render(
    <SidebarProvider>
      <Overview
        workspaceName="Harness"
        live={live}
        parts={parts}
        issues={[resolved]}
        mode="live"
        solutions={{ solutions: [solution], links: [] }}
        startDate={DEMO_FORECAST_START}
        hrefs={{}}
        processesHref="/processes"
        issuesHref="/issues"
      />
    </SidebarProvider>,
  );
