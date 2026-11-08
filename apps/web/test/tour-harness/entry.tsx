// The real Editor (demo mode) on a bare page, for the browser tests in ../editor-tour-browser.test.ts. Bundled by esbuild and
// driven through `window.mountEditor`; nothing here ships. Server Actions are stood in for by the test's build (see the plugin
// there); the Editor, its bar and its tour are the real ones, so a tour step that points at nothing fails the test.

import { createRoot } from "react-dom/client";
import { defaultCompanyPart, northbeamBundle, partOf, workspacePurposes, type ProcessBundle, type ProcessPart, type SolutionRow, type StoredStepChange } from "@transpera-flow/db";
import { placeProcesses } from "@/lib/editor/library";
import { applyEdit } from "@/lib/editor/ops";
import { EditorView } from "@/components/editor/editor-view";
import { demoSolutionsNow } from "@/lib/solutions/demo";
import { demoBundle } from "@/lib/sources/demo";

export interface TourHarnessOptions {
  /** The company map (B11) instead of a process. */
  company?: boolean;
  /** Who is signed in; null is the demo. */
  userId?: string | null;
  /** The database says this person has already dismissed the tour. */
  dismissed?: boolean;
  /** A step that holds another process (a link made before the Editor stopped making them), unconnected, on the map. */
  holder?: boolean;
  /** Offer "+ New purpose…" (the demo has nowhere to save one; the server action is stood in for by the test's build). */
  canAddPurpose?: boolean;
  /** Give the workspace this many purposes (up to 12), to see the limit. */
  purposes?: number;
  /** Edit mode: a draft (default) or a block. */
  editorMode?: "draft" | "block" | "solution";
  /** Solution mode: the automations and augmentations already stored on the solution (D53), carried into Save solution as they are. */
  solutionChanges?: StoredStepChange[];
  /** A new solution in solution mode: for an issue, with no seed and no changes yet. */
  newSolution?: boolean;
}

declare global {
  interface Window {
    /** The solutions the demo has saved in this tab. */
    demoSolutions: () => SolutionRow[];
    mountEditor: (options: TourHarnessOptions) => void;
  }
}

function companyBundle(): ProcessBundle {
  const base = northbeamBundle();
  const parts: ProcessPart[] = [partOf(base), ...(base.otherProcesses ?? [])];
  const company = defaultCompanyPart(base.workspace.id, parts);
  return { ...base, process: company.process, revision: company.revision, steps: company.steps, edges: company.edges, retired: [], otherProcesses: parts };
}

window.demoSolutions = () => demoSolutionsNow().solutions;

window.mountEditor = (options) => {
  let live = options.company ? companyBundle() : demoBundle();
  // No lead volume anywhere: "Missing for simulation" lists it.
  if (options.holder) {
    const other = live.otherProcesses![0]!;
    live = applyEdit(live, placeProcesses(live, [other.process.id])!.edit);
  }
  if (options.purposes) {
    const list = workspacePurposes(live.workspace.settings);
    for (let i = list.length; i < options.purposes; i++) list.push({ key: `c${String(i).padStart(8, "0")}`, name: `Purpose ${i + 1}`, description: "" });
    live.workspace = { ...live.workspace, settings: { ...live.workspace.settings, purposes: list } };
  }
  const DISCOVERY_STEP = "e0000000-0000-4000-8000-000000000002";
  createRoot(document.getElementById("root")!).render(
    <EditorView
      live={live}
      draft={null}
      mode="demo"
      editorMode={options.editorMode ?? "draft"}
      userId={options.userId ?? null}
      canAddPurpose={options.canAddPurpose}
      library={options.company ? { processes: [],
        onCreate: async () => ({ error: "Not available in this test." }),
      } : undefined}
      stepChanges={options.solutionChanges}
      // A saved solution's version opens with its own issue and name (as the app does for `?solution=`), not as a new solution.
      issue={options.solutionChanges || options.newSolution ? { id: "a0000000-0000-4000-8000-0000000000bb", number: 12, title: "Pacing alerts go out late", stepIds: [DISCOVERY_STEP], whole: false, target: { measure: null, now: null, goal: null } } : undefined}
      solutionSeed={options.solutionChanges ? { bundle: live, name: "Pace it by machine" } : undefined}
      tourDismissed={options.dismissed ?? false}
      historyHref="/history"
      exitHref="/"
    />,
  );
};
