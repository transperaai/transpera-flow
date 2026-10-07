// The real Editor in solution mode (demo), opened as "Build it" opens it for a visitor's play-link idea that brings lever changes and no
// steps (issue #33, B4), on a bare page for ../solution-levers-browser.test.ts. Bundled by esbuild and driven through
// `window.mountSolutionEditor`; nothing here ships. The demo store keeps the saved solution in the tab, so the test reads it back.

import { createRoot } from "react-dom/client";
import type { ScenarioPatch } from "@transpera-flow/engine";
import type { SolutionRow } from "@transpera-flow/db";
import { EditorView } from "@/components/editor/editor-view";
import { demoSolutionsNow } from "@/lib/solutions/demo";
import { demoBundle, demoSources } from "@/lib/sources/demo";

declare global {
  interface Window {
    mountSolutionEditor: (options: { levers: ScenarioPatch[]; notes?: string[] }) => { stepId: string; stepName: string };
    savedSolutions: () => SolutionRow[];
  }
}

window.savedSolutions = () => demoSolutionsNow().solutions;

window.mountSolutionEditor = ({ levers, notes = [] }) => {
  const live = demoBundle();
  const step = live.steps.find((s) => s.kind === "task")!;
  createRoot(document.getElementById("root")!).render(
    <EditorView
      live={live}
      draft={null}
      mode="demo"
      editorMode="solution"
      idea={{ id: "00000000-0000-4000-8000-0000000000f1", title: "One more strategist", block: { steps: [], edges: [], entry_step_id: null }, replaces: [], levers, leverNotes: notes }}
      sources={demoSources()}
      userId={null}
      tourDismissed
      historyHref="/history"
      exitHref="/"
    />,
  );
  return { stepId: step.id, stepName: step.name };
};
