// The Issue page on the example agency's fixture, for ../q10-issue-page.test.ts (checks and screenshots). Test only, nothing here ships.

import { createRoot } from "react-dom/client";
import type { IssueEventRow, IssueRow, ProcessBundle, SolutionIssueRow, SolutionRow, SourceRow } from "@transpera-flow/db";
import { IssuePage } from "@/components/issues/issue-page";
import { SolutionPage } from "@/components/solutions/solution-page";
import { SidebarProvider } from "@/components/ui/sidebar";

declare global {
  interface Window {
    workerScripts: Record<string, string>;
    __serverActions?: { name: string; args: unknown[] }[];
    q10Data: {
      bundles: Record<string, ProcessBundle>;
      processes: { id: string; name: string }[];
      issues: IssueRow[];
      events: Record<string, IssueEventRow[]>;
      solutions: { solutions: SolutionRow[]; links: SolutionIssueRow[] };
      sources: SourceRow[];
      workspaceId: string;
    };
    mountIssue: (o: { number: number; editor: boolean; noSolutions?: boolean }) => void;
    mountSolution: (o: { id: string; editor: boolean }) => void;
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

window.mountIssue = ({ number, editor, noSolutions }) => {
  const d = window.q10Data;
  const issue = d.issues.find((i) => i.number === number)!;
  const processId = issue.links.find((l) => l.process_id)?.process_id ?? issue.process_id!;
  createRoot(document.getElementById("root")!).render(
    <SidebarProvider>
      <div className="p-4">
        <IssuePage
          issue={issue}
          issues={d.issues}
          bundle={d.bundles[processId]!}
          processes={d.processes}
          sources={d.sources}
          events={d.events[issue.id] ?? []}
          mode={editor ? "live" : "readonly"}
          base="/w/example"
          buildHref={`/w/example/p/${processId}/edit?mode=solution&issue=${issue.id}`}
          viewerId={null}
          solutions={noSolutions ? { solutions: [], links: [] } : d.solutions}
          memberNames={{}}
        />
      </div>
    </SidebarProvider>,
  );
};

window.mountSolution = ({ id, editor }) => {
  const d = window.q10Data;
  const solution = d.solutions.solutions.find((s) => s.id === id)!;
  createRoot(document.getElementById("root")!).render(
    <SidebarProvider>
      <div className="p-4">
        <SolutionPage
          workspaceId={d.workspaceId}
          solutionId={solution.id}
          data={d.solutions}
          issues={d.issues}
          processes={d.processes}
          base="/w/example"
          mode={editor ? "live" : "readonly"}
          viewerId={null}
          memberNames={{}}
          compareBase={null}
        />
      </div>
    </SidebarProvider>,
  );
};
