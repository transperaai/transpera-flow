// The Sandbox on a bare page, for ../sandbox-browser.test.ts: the whole page component with its simulation in a real Web Worker,
// in demo mode (scenarios kept in the tab) or as a Viewer sees it (saved scenarios passed in, nothing to save). Next's modules are stood in for
// by ../build-harness.ts (with the URL-keeping navigation stub). Nothing here ships.
//
// `Worker` is replaced by one that starts the bundled script the test hands over as `window.workerScripts`.

import { createRoot } from "react-dom/client";
import { northbeamIssues, northbeamPersonIds, type SolutionRow } from "@transpera-flow/db";
import { SandboxView } from "@/components/sandbox/sandbox-view";
import { DEMO_FORECAST_SOLUTION, DEMO_FORECAST_START, demoForecastBundle } from "@/lib/forecast/demo";
import { DEMO_SCENARIOS, saveDemoScenario } from "@/lib/sandbox/demo";
import { demoSources } from "@/lib/sources/demo";
import { setHarnessUrl } from "../build-harness-stubs/navigation-url";

declare global {
  interface Window {
    workerScripts: Record<string, string>;
    __harnessUrl?: string;
    __simRuns?: number;
    /** The address changing from outside the page, as a link or the sidebar would change it. */
    __setHarnessUrl: (url: string) => void;
    mountSandbox: (options: { mode: "demo" | "readonly"; url?: string; broken?: boolean; many?: boolean; dan?: boolean; nobody?: boolean; leah?: boolean }) => void;
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

/** A solution whose map the engine can't simulate (a connection to a step that isn't there), and a scenario that puts it live. */
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

const change = (id: string, solutionId: string, from: string) => ({ id, lever: "E6" as const, target: solutionId, op: "set" as const, value: 1, from });
const scenario = (name: string, changes: ReturnType<typeof change>[]) => saveDemoScenario({ id: null, name, description: null, parent_id: null, changes, horizon_months: 12 });

window.__setHarnessUrl = setHarnessUrl;

window.mountSandbox = ({ mode, url, broken, many, dan, nobody, leah }) => {
  if (many) {
    // Four go-live months, each for a different version of the solution (and so a different model): five runs.
    scenario("Many runs", ["2026-12", "2027-02", "2027-04", "2027-06"].map((month, i) => change(`00000000-0000-4000-8000-0000000f04${String(i).padStart(2, "0")}`, MANY_SOLUTIONS[i]!.id, month)));
  }
  if (broken) scenario("Broken scenario", [change("00000000-0000-4000-8000-0000000f0296", BROKEN_SOLUTION.id, "2027-01")]);
  setHarnessUrl(url ?? "/demo/sandbox");
  const base = demoForecastBundle();
  // A Viewer who sees only their own row (B1): the same bundle with a viewer who isn't everyone, and the names the database gives
  // such a reader (`team_capacity`): their own, "Team member N" for everyone else. `nobody`: a Viewer who isn't linked to a person.
  const ownPersonId = nobody ? null : dan ? northbeamPersonIds["Dan Okafor"]! : undefined;
  const live =
    mode === "readonly" && ownPersonId !== undefined
      ? { ...base, viewer: { seesEveryone: false, ownPersonId }, people: base.people.map((p, i) => (p.id === ownPersonId ? p : { ...p, name: `Team member ${i + 1}`, cost_rate: null })) }
      : base;
  // A saved scenario that names a person (Leah Brooks, away for two weeks), for what a Viewer reads of her.
  const leaveScenario = {
    ...DEMO_SCENARIOS[0]!,
    id: "50000000-0000-4000-8000-0000000000a1",
    name: "Leah away",
    changes: [{ id: "5b0000f4-0000-4000-8000-000000000001", lever: "D3" as const, target: northbeamPersonIds["Leah Brooks"]!, op: "set" as const, value: 2, from: "2027-02-08" }],
  };
  const solutions = mode === "demo" ? (broken ? [DEMO_FORECAST_SOLUTION, BROKEN_SOLUTION] : many ? [DEMO_FORECAST_SOLUTION, ...MANY_SOLUTIONS] : [DEMO_FORECAST_SOLUTION]) : [DEMO_FORECAST_SOLUTION];
  createRoot(document.getElementById("root")!).render(
    <div className="p-4">
      <SandboxView
        live={live}
        issues={northbeamIssues()}
        sources={demoSources()}
        mode={mode}
        issuesHref="/demo/issues"
        leversHref="/demo/settings/levers"
        startDate={DEMO_FORECAST_START}
        scenarios={mode === "readonly" ? (leah ? [...DEMO_SCENARIOS, leaveScenario] : DEMO_SCENARIOS) : undefined}
        solutions={solutions}
      />
    </div>,
  );
};
