// The real Editor (demo mode) on a bare page, for the browser tests in ../editor-tour-browser.test.ts. Bundled by esbuild and
// driven through `window.mountEditor`; nothing here ships. Server Actions are stood in for by the test's build (see the plugin
// there); the Editor, its bar and its tour are the real ones, so a tour step that points at nothing fails the test.

import { createRoot } from "react-dom/client";
import { defaultCompanyPart, northbeamBundle, partOf, workspacePurposes, type ProcessBundle, type ProcessPart, type StoredStepChange } from "@transpera-flow/db";
import { placeProcesses } from "@/lib/editor/library";
import { applyEdit } from "@/lib/editor/ops";
import { EditorView } from "@/components/editor/editor-view";
import { changesOnStepsOf } from "@/lib/solutions/step-changes";
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
  /** The step panel as on a saved solution's version (D53 part B): these are its changes, and Automate… and Augment… are offered. */
  solutionChanges?: StoredStepChange[];
  /** The step panel as on the live process: it points at making a solution. */
  makeSolution?: boolean;
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
  const SOLUTION = "a0000000-0000-4000-8000-0000000000aa";
  const changesOnSteps = options.solutionChanges
    ? { sandboxHref: "/sandbox?solution=a", changes: changesOnStepsOf(SOLUTION, options.solutionChanges), edit: { workspaceId: live.workspace.id, solutionId: SOLUTION, stepIds: live.steps.map((s) => s.id) } }
    : options.makeSolution
      ? { sandboxHref: "/sandbox", changes: [], makeSolutionHref: "/p/edit?mode=solution" }
      : undefined;
  createRoot(document.getElementById("root")!).render(
    <EditorView
      live={live}
      draft={null}
      mode="demo"
      editorMode={options.editorMode ?? "draft"}
      userId={options.userId ?? null}
      canAddPurpose={options.canAddPurpose}
      library={options.company ? { processes: [], templates: [
          { id: "agency-sales-pipeline", name: "Agency sales pipeline", kind: "pipeline", category: "sales", description: "" },
          { id: "client-onboarding", name: "Client onboarding", kind: "servicing", category: "onboarding", description: "" },
          { id: "monthly-reporting", name: "Monthly client reporting", kind: "servicing", category: "routine_client_work", description: "" },
        ],
        onCreate: async () => ({ error: "Not available in this test." }),
      } : undefined}
      changesOnSteps={changesOnSteps}
      // A saved solution's version opens with its own issue and name (as the app does for `?solution=`), not as a new solution.
      issue={options.solutionChanges ? { id: "a0000000-0000-4000-8000-0000000000bb", number: 12, title: "Pacing alerts go out late", stepIds: [DISCOVERY_STEP], whole: false, target: { measure: null, now: null, goal: null } } : undefined}
      solutionSeed={options.solutionChanges ? { id: SOLUTION, bundle: live, name: "Pace it by machine" } : undefined}
      tourDismissed={options.dismissed ?? false}
      historyHref="/history"
      exitHref="/"
    />,
  );
};
