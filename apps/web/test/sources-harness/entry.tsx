// The Sources library on a bare page, for the browser tests in ../sources-library-browser.test.ts. Bundled by esbuild and
// driven through `window.mountSources`; nothing here ships. The library is the real page in demo mode (sources kept in memory
// in the tab), on Northbeam's sample, with more sources added on request so search, filters and sort have something to do.

import { createRoot } from "react-dom/client";
import type { SourceKind, SourceLinkRow, SourceRow } from "@transpera-flow/db";
import { SourcesPage } from "@/components/sources-page";
import { demoBundle, demoCitations, demoLinkTargets, demoPageSources, demoSourceLinks } from "@/lib/sources/demo";

export interface SourcesHarnessOptions {
  /** The three sample sources (default), twelve (`many`), 130 (`paged`: three pages of the library), or none. */
  sources?: "sample" | "many" | "paged" | "none";
  mode?: "demo" | "readonly";
}

declare global {
  interface Window {
    mountSources: (options: SourcesHarnessOptions) => void;
  }
}

const KINDS: SourceKind[] = ["transcript", "notes", "data", "screenshot"];

/** `n` more sources, each linked to a process, with titles that sort in order. */
function bulk(base: SourceRow[], n: number, processId: string): { sources: SourceRow[]; links: SourceLinkRow[] } {
  const sources: SourceRow[] = [];
  const links: SourceLinkRow[] = [];
  const at = "2026-09-29T09:00:00Z";
  for (let i = 0; i < n; i++) {
    const id = `32000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`;
    sources.push({ id, workspace_id: base[0]!.workspace_id, kind: "sop", title: `Procedure ${String(i + 1).padStart(3, "0")}`, speakers: [], recorded_at: "2026-07-01", body: `Step by step, number ${i + 1}.`, file_url: null, created_at: at, updated_at: at });
    links.push({ id: `b2000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`, workspace_id: base[0]!.workspace_id, source_id: id, kind: "process", process_id: processId, step_id: null, insight_key: null, issue_id: null, solution_id: null, created_at: at, created_by: null });
  }
  return { sources, links };
}

/** Nine more sources on top of the sample's three: every kind, several dates, two of them linked to nothing. */
function more(base: SourceRow[], processIds: string[]): { sources: SourceRow[]; links: SourceLinkRow[] } {
  const sources: SourceRow[] = [];
  const links: SourceLinkRow[] = [];
  const at = "2026-09-29T09:00:00Z";
  for (let i = 0; i < 9; i++) {
    const id = `31000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`;
    sources.push({
      id,
      workspace_id: base[0]!.workspace_id,
      kind: KINDS[i % 4]!,
      title: `Interview ${String.fromCharCode(65 + i)}${i % 3 === 0 ? " with Sam" : ""}`,
      speakers: i % 2 ? ["Sam Okafor"] : ["Priya Shah", "Tom Reed", "Leah Brooks"],
      recorded_at: `2026-08-${String(10 + i).padStart(2, "0")}`,
      body: `Call ${i + 1}: the team talked about handoffs, waiting and rework.${i === 4 ? " Banana bread was mentioned." : ""}`,
      file_url: null,
      created_at: at,
      updated_at: at,
    });
    // The last two are linked to nothing.
    if (i < 7) {
      links.push({
        id: `b1000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
        workspace_id: base[0]!.workspace_id,
        source_id: id,
        kind: "process",
        process_id: processIds[i % processIds.length]!,
        step_id: null,
        insight_key: null,
        issue_id: null,
        solution_id: null,
        created_at: at,
        created_by: null,
      });
    }
  }
  return { sources, links };
}

window.mountSources = (options) => {
  const bundle = demoBundle();
  const targets = demoLinkTargets(bundle);
  let sources = demoPageSources();
  let links = demoSourceLinks();
  if (options.sources === "many") {
    const extra = more(sources, targets.processes.map((p) => p.id));
    sources = [...sources, ...extra.sources];
    links = [...links, ...extra.links];
  }
  if (options.sources === "paged") {
    const extra = bulk(sources, 127, targets.processes[0]!.id);
    sources = [...sources, ...extra.sources];
    links = [...links, ...extra.links];
  }
  if (options.sources === "none") {
    sources = [];
    links = [];
  }
  createRoot(document.getElementById("root")!).render(
    <SourcesPage
      workspaceId={bundle.workspace.id}
      memory={sources}
      citations={demoCitations(bundle)}
      links={links}
      targets={targets}
      mode={options.mode ?? "demo"}
      processBase="/demo/p"
    />,
  );
};
