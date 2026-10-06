// The Forecast page on a bare page, for ../forecast-plan-browser.test.ts (B7, issue #36): the whole page component with its
// simulation in a real Web Worker, in demo mode (plans kept in the tab) or as a member sees it. Next's modules are stood in for
// by ../build-harness.ts (with the URL-keeping navigation stub). Nothing here ships.
//
// `Worker` is replaced by one that starts the bundled script the test hands over as `window.workerScripts`.

import { createRoot } from "react-dom/client";
import { northbeamIssues, northbeamPersonIds, type SolutionRow } from "@transpera-flow/db";
import { ForecastView } from "@/components/forecast/forecast-view";
import { DEMO_FORECAST_SOLUTION, DEMO_FORECAST_START, demoForecastBundle } from "@/lib/forecast/demo";
import { saveDemoPlan } from "@/lib/forecast/plans-demo";
import { demoSources } from "@/lib/sources/demo";
import { setHarnessUrl } from "../build-harness-stubs/navigation-url";

declare global {
  interface Window {
    workerScripts: Record<string, string>;
    __harnessUrl?: string;
    __simRuns?: number;
    mountForecast: (options: { mode: "demo" | "readonly"; url?: string; broken?: boolean; many?: boolean }) => void;
  }
}

// A page set up with `setContent` isn't a secure context, so it has no `crypto.randomUUID` (a real page, https or localhost, does).
if (!("randomUUID" in crypto)) {
  (crypto as { randomUUID?: () => string }).randomUUID = () =>
    "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) => (Number(c) ^ (crypto.getRandomValues(new Uint8Array(1))[0]! & (15 >> (Number(c) / 4)))).toString(16)) as `${string}-${string}-${string}-${string}-${string}`;
}

const NativeWorker = window.Worker;
window.Worker = class extends NativeWorker {
  constructor(url: string | URL) {
    const file = String(url).split("/").pop()!;
    const script = window.workerScripts[file];
    if (!script) throw new Error(`No bundled worker for ${file}`);
    super(URL.createObjectURL(new Blob([script], { type: "text/javascript" })));
  }
  // Counts the runs asked of any worker, for the tests that check what is reused.
  postMessage(message: unknown, ...rest: unknown[]) {
    window.__simRuns = (window.__simRuns ?? 0) + 1;
    (super.postMessage as (m: unknown, ...r: unknown[]) => void)(message, ...rest);
  }
} as typeof Worker;

/** A solution whose map the engine can't simulate (a connection to a step that isn't there), and a plan that puts it live. */
const BROKEN_SOLUTION: SolutionRow = {
  ...DEMO_FORECAST_SOLUTION,
  id: "00000000-0000-4000-8000-0000000f0299",
  name: "Broken setup",
  steps: {
    ...DEMO_FORECAST_SOLUTION.steps,
    edges: [...DEMO_FORECAST_SOLUTION.steps.edges, { id: "00000000-0000-4000-8000-0000000f0298", from_step_id: DEMO_FORECAST_SOLUTION.steps.steps[0]!.id, to_step_id: "00000000-0000-4000-8000-0000000f0297", probability: 1, condition_tag: null, label: null }],
  },
};

/** Four versions of the demo solution that cut PPC campaign setup by different amounts. */
const MANY_SOLUTIONS: SolutionRow[] = [3, 2.5, 2, 1.5].map((hours, i) => ({
  ...DEMO_FORECAST_SOLUTION,
  id: `00000000-0000-4000-8000-0000000f05${String(i).padStart(2, "0")}`,
  name: `Setup ${i + 1}`,
  steps: { ...DEMO_FORECAST_SOLUTION.steps, steps: DEMO_FORECAST_SOLUTION.steps.steps.map((st) => (st.id === DEMO_FORECAST_SOLUTION.changed_step_ids[0] ? { ...st, work_hours: hours } : st)) },
}));

window.mountForecast = ({ mode, url, broken, many }) => {
  if (many) {
    // Four go-live months, each for a different version of the solution (and so a different model): five runs.
    saveDemoPlan({ id: null, name: "Many runs", markers: ["2026-12-01", "2027-02-01", "2027-04-01", "2027-06-01"].map((date, i) => ({ id: `00000000-0000-4000-8000-0000000f04${String(i).padStart(2, "0")}`, kind: "solution" as const, date, solution_id: MANY_SOLUTIONS[i]!.id })) });
  }
  if (broken) {
    saveDemoPlan({ id: null, name: "Broken plan", markers: [{ id: "00000000-0000-4000-8000-0000000f0296", kind: "solution", date: "2027-01-01", solution_id: BROKEN_SOLUTION.id }] });
  }
  setHarnessUrl(url ?? "/demo/forecast");
  const base = demoForecastBundle();
  // A member sees their own row only (B1): the same bundle with a viewer who isn't everyone.
  const live = mode === "readonly" ? { ...base, viewer: { seesEveryone: false, ownPersonId: northbeamPersonIds["Dan Okafor"]! } } : base;
  createRoot(document.getElementById("root")!).render(
    <div className="p-4">
      <ForecastView
        live={live}
        issues={northbeamIssues()}
        sources={demoSources()}
        mode={mode}
        issuesHref="/demo/issues"
        startDate={DEMO_FORECAST_START}
        demoPlans={mode === "demo"}
        solutions={mode === "demo" ? (broken ? [DEMO_FORECAST_SOLUTION, BROKEN_SOLUTION] : many ? [DEMO_FORECAST_SOLUTION, ...MANY_SOLUTIONS] : [DEMO_FORECAST_SOLUTION]) : []}
      />
    </div>,
  );
};
