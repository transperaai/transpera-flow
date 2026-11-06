// Group C pages of the UI sweep on the example agency's fixture, for ../q11c-sweep.test.ts (checks and screenshots). Test only, nothing here ships.

import { createRoot } from "react-dom/client";
import type { IssueEventRow, IssueRow, ProcessBundle, SolutionIssueRow, SolutionRow, SourceRow } from "@transpera-flow/db";
import { BlockLibrary } from "@/components/blocks/block-library";
import { HistoryPage } from "@/components/history/history-page";
import { IssuePage } from "@/components/issues/issue-page";
import { SolutionCards } from "@/components/solutions/solution-cards";
import { SolutionPage } from "@/components/solutions/solution-page";
import { NewSolutionButton, SolutionsList } from "@/components/solutions/solutions-list";
import { Page } from "@/components/shell/page";
import { SourcesPage } from "@/components/sources-page";
import { SidebarProvider } from "@/components/ui/sidebar";
import { demoBundle, demoCitations, demoLinkTargets, demoPageSources, demoSourceLinks } from "@/lib/sources/demo";
import type { VersionMeta } from "@/lib/history/versions";

declare global {
  interface Window {
    workerScripts: Record<string, string>;
    __serverActions?: { name: string; args: unknown[] }[];
    q11Data: {
      bundles: Record<string, ProcessBundle>;
      processes: { id: string; name: string }[];
      issues: IssueRow[];
      events: Record<string, IssueEventRow[]>;
      solutions: { solutions: SolutionRow[]; links: SolutionIssueRow[] };
      sources: SourceRow[];
      workspaceId: string;
    };
    mountSolutions: (o: { editor: boolean; empty?: boolean }) => void;
    mountSolution: (o: { id: string; editor: boolean }) => void;
    mountBlocks: (o: { mode: "live" | "readonly" | "demo"; empty?: boolean }) => void;
    mountHistory: (o: { company?: boolean; editor?: boolean; empty?: boolean }) => void;
    mountIssue: (o: { number: number; editor: boolean }) => void;
    mountOther: () => void;
    mountSources: (o: { editor: boolean }) => void;
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

const mount = (node: React.ReactNode) =>
  createRoot(document.getElementById("root")!).render(
    <SidebarProvider>
      <div className="mx-auto max-w-6xl p-4">{node}</div>
    </SidebarProvider>,
  );

const versions = (n: number): VersionMeta[] =>
  Array.from({ length: n }, (_, i) => {
    const number = n - i;
    return {
      revisionId: `r${number}`,
      number,
      live: i === 0,
      publishedAt: new Date(Date.UTC(2026, 10, 5 - i * 2, 9, 30)).toISOString(),
      authorKind: i === 3 ? "mcp" : "user",
      authorName: i === 3 ? null : ["Austin", "Priya", "Karl"][i % 3]!,
      changes: number === 1 ? null : { steps: { added: i % 2, removed: 0, changed: 2 + i }, edges: { added: 1, removed: i % 3 === 0 ? 1 : 0, changed: 0 } },
      note: null,
    };
  });

window.mountSolutions = ({ editor, empty }) => {
  const d = window.q11Data;
  mount(
    <Page
      title="Solutions"
      eyebrow="Improve"
      description="Every solution that has been built and simulated. Each one says which issues it solves, and how it did against each issue's target. They never change the live map."
      actions={editor ? <NewSolutionButton processes={d.processes} base="/w/example" /> : undefined}
    >
      <SolutionsList data={empty ? { solutions: [], links: [] } : d.solutions} issues={d.issues} processes={d.processes} base="/w/example" mode={editor ? "live" : "readonly"} viewerId={null} memberNames={{}} />
    </Page>,
  );
};

window.mountSolution = ({ id, editor }) => {
  const d = window.q11Data;
  const solution = d.solutions.solutions.find((s) => s.id === id)!;
  mount(
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
      compareBase={d.bundles[solution.process_id] ?? null}
    />,
  );
};

window.mountBlocks = ({ mode, empty }) =>
  mount(<BlockLibrary blocks={[]} mode={empty && mode === "demo" ? "readonly" : mode} newHref={mode === "readonly" ? null : "/w/example/p/x/edit?mode=block"} usage={{}} />);

window.mountHistory = ({ company, editor, empty }) => {
  const v = empty ? [] : versions(company ? 7 : 6);
  const actions = editor ? { restore: async () => ({ status: "error" as const, message: "" }), duplicate: async () => ({ status: "error" as const, message: "" }) } : undefined;
  mount(
    <HistoryPage
      company={company}
      nav={<span className="text-xs text-muted-foreground">Overview / {company ? "Company map" : "Sales"}</span>}
      processName="Sales"
      versions={v}
      viewBase="/w/example/p/x"
      actions={actions as never}
      links={{ edit: "/w/example/p/x/edit", newProcessEdit: "/w/example/p/{id}/edit" }}
    />,
  );
};

window.mountIssue = ({ number, editor }) => {
  const d = window.q11Data;
  const issue = d.issues.find((i) => i.number === number)!;
  const processId = issue.links.find((l) => l.process_id)?.process_id ?? issue.process_id!;
  mount(
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
      solutions={d.solutions}
      memberNames={{}}
    />,
  );
};

window.mountOther = () =>
  mount(
    <div className="max-w-xl">
      <SolutionCards data={{ solutions: [], links: [] }} issues={[]} processes={[]} base="/w/example" demo={false} canEdit from="/w/example" empty="Nothing else yet. Every solution here is for an issue above." />
    </div>,
  );

window.mountSources = ({ editor }) => {
  const bundle = demoBundle();
  mount(
    <Page title="Sources" eyebrow="Company" description="Your library of transcripts, notes and data. Search it, open one to read it, and link each to what it is evidence for.">
      <SourcesPage
        workspaceId={bundle.workspace.id}
        memory={demoPageSources()}
        citations={demoCitations(bundle)}
        links={demoSourceLinks()}
        targets={demoLinkTargets(bundle)}
        mode={editor ? "demo" : "readonly"}
        processBase="/demo/p"
      />
    </Page>,
  );
};
