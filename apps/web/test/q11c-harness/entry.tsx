// Group C pages of the UI sweep on the example agency's fixture, for ../q11c-sweep.test.ts (checks and screenshots). Test only, nothing here ships.

import { createRoot } from "react-dom/client";
import type { IssueEventRow, IssueRow, ProcessBundle, SolutionIssueRow, SolutionRow, SourceRow } from "@transpera-flow/db";
import { BlockLibrary } from "@/components/blocks/block-library";
import { HistoryPage } from "@/components/history/history-page";
import { IssuePage } from "@/components/issues/issue-page";
import { SolutionCards } from "@/components/solutions/solution-cards";
import { SolutionPage } from "@/components/solutions/solution-page";
import { SolutionsHeader, SolutionsList } from "@/components/solutions/solutions-list";
import { Page } from "@/components/shell/page";
import { SourcesPage } from "@/components/sources-page";
import { SidebarProvider } from "@/components/ui/sidebar";
import { demoBundle, demoCitations, demoLinkTargets, demoPageSources, demoSourceLinks } from "@/lib/sources/demo";
import type { VersionMeta } from "@/lib/history/versions";

declare global {
  interface Window {
    workerScripts: Record<string, string>;
    __serverActions?: { name: string; args: unknown[] }[];
    q11cData: {
      bundles: Record<string, ProcessBundle>;
      processes: { id: string; name: string }[];
      issues: IssueRow[];
      events: Record<string, IssueEventRow[]>;
      solutions: { solutions: SolutionRow[]; links: SolutionIssueRow[] };
      sources: SourceRow[];
      workspaceId: string;
    };
    q11cMountSolutions: (o: { editor: boolean; empty?: boolean }) => void;
    q11cMountSolution: (o: { id: string; editor: boolean }) => void;
    q11cMountBlocks: (o: { mode: "live" | "readonly" | "demo"; empty?: boolean }) => void;
    q11cMountHistory: (o: { company?: boolean; editor?: boolean; empty?: boolean }) => void;
    q11cMountIssue: (o: { number: number; editor: boolean }) => void;
    q11cMountOther: () => void;
    q11cMountSources: (o: { editor: boolean }) => void;
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
      <div className="mx-auto w-full min-w-0 p-4">{node}</div>
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

window.q11cMountSolutions = ({ editor, empty }) => {
  const d = window.q11cData;
  mount(
    <Page title="Solutions" hideHeader>
      <SolutionsHeader count={empty ? 0 : d.solutions.solutions.length} canEdit={editor} processes={d.processes} issues={d.issues} base="/w/example" />
      <SolutionsList data={empty ? { solutions: [], links: [] } : d.solutions} issues={d.issues} processes={d.processes} base="/w/example" mode={editor ? "live" : "readonly"} viewerId={null} memberNames={{}} />
    </Page>,
  );
};

window.q11cMountSolution = ({ id, editor }) => {
  const d = window.q11cData;
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

window.q11cMountBlocks = ({ mode, empty }) => {
  const base = Object.values(window.q11cData.bundles)[0]!;
  return mount(
    <BlockLibrary
      blocks={[]}
      mode={empty && mode === "demo" ? "readonly" : mode}
      newHref={mode === "readonly" ? null : "/w/example/p/x/edit?mode=block"}
      editBase={mode === "readonly" ? null : "/w/example/p/x/edit"}
      libraryHref="/w/example/blocks"
      slug="example"
      baseProcessId={base.process.id}
      openBase={async () => base}
    />,
  );
};

window.q11cMountHistory = ({ company, editor, empty }) => {
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

window.q11cMountIssue = ({ number, editor }) => {
  const d = window.q11cData;
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

window.q11cMountOther = () =>
  mount(
    <div className="max-w-xl">
      <SolutionCards data={{ solutions: [], links: [] }} issues={[]} processes={[]} base="/w/example" demo={false} canEdit from="/w/example" empty="Nothing else yet. Every solution here is for an issue above." />
    </div>,
  );

window.q11cMountSources = ({ editor }) => {
  const bundle = demoBundle();
  mount(
    <Page title="Sources" hideHeader>
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
