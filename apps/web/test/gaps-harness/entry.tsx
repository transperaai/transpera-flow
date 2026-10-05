// The "Missing for simulation" warning on a bare page, for ../simulation-gaps-browser.test.ts. Bundled by esbuild and driven
// through `window.mountGaps`; nothing here ships. The process is a small bundle whose steps lack values, and the buttons stand in
// for what a person does in the Editor (fill a value in), so the warning and its "based on incomplete data" note are the real ones.

import { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { findGaps, gapInputFromBundle, SERVER_DEFAULT_NOTE_PREFIX } from "@transpera-flow/db/simulation-gaps";
import { IncompleteDataNote, MissingForSimulation } from "@/components/simulation-gaps";

type Step = { id: string; name: string; kind: string; role_id: string | null; provenance: Record<string, unknown> };

const defaulted = (kind: string) => ({ source: "estimated", assumption: true, note: `${SERVER_DEFAULT_NOTE_PREFIX} ${kind} step.` });

const initial = (): { steps: Step[]; edges: { from_step_id: string; to_step_id: string; probability: number }[] } => ({
  steps: [
    { id: "w", name: "Write proposal", kind: "task", role_id: null, provenance: { work_hours: defaulted("task") } },
    { id: "p", name: "Wait for payment", kind: "wait", role_id: null, provenance: { wait_hours: defaulted("wait") } },
    { id: "d", name: "Client decides", kind: "decision", role_id: null, provenance: { branch_odds: { source: "estimated", defaulted: true, was: { y: 0.5, n: 0.5 } } } },
    { id: "y", name: "Client signs", kind: "end", role_id: null, provenance: {} },
    { id: "n", name: "Client declines", kind: "end", role_id: null, provenance: {} },
  ],
  edges: [
    { from_step_id: "d", to_step_id: "y", probability: 0.5 },
    { from_step_id: "d", to_step_id: "n", probability: 0.5 },
  ],
});

declare global {
  interface Window {
    mountGaps: (opts: { volume: boolean }) => void;
    /** The step ids the warning's links selected. */
    selected: string[];
  }
}

function Harness({ volume }: { volume: boolean }) {
  const [state, setState] = useState(initial);
  const gaps = useMemo(
    () => findGaps(gapInputFromBundle({ ...state, process: { id: "p1", kind: "pipeline" }, leadSources: volume ? [{ volume_week: 5 }] : [], servicingLinks: [] } as never)),
    [state, volume],
  );
  const set = (id: string, change: Partial<Step>) => setState((s) => ({ ...s, steps: s.steps.map((x) => (x.id === id ? { ...x, ...change } : x)) }));
  return (
    <div style={{ maxWidth: 720, padding: 16 }}>
      <MissingForSimulation gaps={gaps} onSelectStep={(id) => window.selected.push(id)} settingsHref="/w/acme/settings" />
      <p data-results>Projection: 12 wins</p>
      <IncompleteDataNote count={gaps.length} />
      <div style={{ display: "flex", gap: 8, marginTop: 16, flexWrap: "wrap" }}>
        <button onClick={() => set("w", { role_id: "r1" })}>Give Write proposal a role</button>
        <button onClick={() => set("w", { provenance: { work_hours: { source: "entered" } } })}>Enter hands-on time</button>
        <button onClick={() => set("p", { provenance: { wait_hours: { source: "entered" } } })}>Enter the wait</button>
        <button onClick={() => setState((s) => ({ ...s, edges: s.edges.map((e) => (e.to_step_id === "y" ? { ...e, probability: 0.7 } : { ...e, probability: 0.3 })) }))}>Enter the odds</button>
      </div>
    </div>
  );
}

window.selected = [];
window.mountGaps = (opts) => {
  createRoot(document.getElementById("root")!).render(<Harness volume={opts.volume} />);
};
