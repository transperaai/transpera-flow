// The real Editor (demo mode) on a bare page, for the browser tests in ../editor-tour-browser.test.ts. Bundled by esbuild and
// driven through `window.mountEditor`; nothing here ships. Server Actions are stood in for by the test's build (see the plugin
// there); the Editor, its bar and its tour are the real ones, so a tour step that points at nothing fails the test.

import { createRoot } from "react-dom/client";
import { defaultCompanyPart, northbeamBundle, partOf, type ProcessBundle, type ProcessPart } from "@transpera-flow/db";
import { EditorView } from "@/components/editor/editor-view";
import { demoBundle, demoSources } from "@/lib/sources/demo";

export interface TourHarnessOptions {
  /** The company map (B11) instead of a process. */
  company?: boolean;
  /** Who is signed in; null is the demo. */
  userId?: string | null;
  /** Edit mode: a draft (default) or a block. */
  editorMode?: "draft" | "block";
}

declare global {
  interface Window {
    mountEditor: (options: TourHarnessOptions) => void;
  }
}

function companyBundle(): ProcessBundle {
  const base = northbeamBundle();
  const parts: ProcessPart[] = [partOf(base), ...(base.otherProcesses ?? [])];
  const company = defaultCompanyPart(base.workspace.id, parts);
  return { ...base, process: company.process, revision: company.revision, steps: company.steps, edges: company.edges, retired: [], otherProcesses: parts };
}

window.mountEditor = (options) => {
  const live = options.company ? companyBundle() : demoBundle();
  createRoot(document.getElementById("root")!).render(
    <EditorView
      live={live}
      draft={null}
      mode="demo"
      editorMode={options.editorMode ?? "draft"}
      sources={demoSources()}
      userId={options.userId ?? null}
      exitHref="/"
    />,
  );
};
