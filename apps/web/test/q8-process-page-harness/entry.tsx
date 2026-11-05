// The process page on the example agency's fixture, for ../q8-process-page.test.ts (checks and screenshots). Test only, nothing here ships.

import { createRoot } from "react-dom/client";
import type { CapacityChangeRow, IssueRow, ProcessBundle, SolutionIssueRow, SolutionRow } from "@transpera-flow/db";
import { ProcessPage } from "@/components/process-page";
import { SidebarProvider } from "@/components/ui/sidebar";
import type { DepartmentFieldData } from "@/lib/process-page/department";
import type { TierSetup } from "@/lib/tier-setup";

declare global {
  interface Window {
    workerScripts: Record<string, string>;
    q8Data: {
      bundle: ProcessBundle;
      tierSetup: TierSetup;
      issues: IssueRow[];
      solutions: { solutions: SolutionRow[]; links: SolutionIssueRow[] };
      changes: CapacityChangeRow[];
      department: DepartmentFieldData;
    };
    mountQ8: (o: { editor: boolean; issues: boolean; unpublished?: boolean }) => void;
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

window.mountQ8 = ({ editor, issues, unpublished }) => {
  const d = window.q8Data;
  const solutions = issues ? d.solutions : { solutions: [], links: [] };
  createRoot(document.getElementById("root")!).render(
    <SidebarProvider>
      <ProcessPage
        bundle={d.bundle}
        liveVersion={unpublished ? 0 : 3}
        mode={editor ? "live" : "readonly"}
        historyHref="#history"
        editHref={editor ? "#edit" : undefined}
        tierSetup={d.tierSetup}
        department={d.department}
        editCategory={editor ? async () => ({ status: "ok" as const }) : undefined}
        issues={issues ? d.issues : []}
        changes={issues ? d.changes : []}
        solutions={{ data: solutions, base: "/w/example" }}
        registerHref="/w/example/issues"
      />
    </SidebarProvider>,
  );
};
