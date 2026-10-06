// The Forecast page on a bare page, for ../forecast-plan-browser.test.ts (B7, issue #36): the whole page component with its
// simulation in a real Web Worker, in demo mode (plans kept in the tab) or as a member sees it. Next's modules are stood in for
// by ../build-harness.ts (with the URL-keeping navigation stub). Nothing here ships.
//
// `Worker` is replaced by one that starts the bundled script the test hands over as `window.workerScripts`.

import { createRoot } from "react-dom/client";
import { northbeamIssues, northbeamPersonIds } from "@transpera-flow/db";
import { ForecastView } from "@/components/forecast/forecast-view";
import { DEMO_FORECAST_SOLUTION, DEMO_FORECAST_START, demoForecastBundle } from "@/lib/forecast/demo";
import { demoSources } from "@/lib/sources/demo";
import { setHarnessUrl } from "../build-harness-stubs/navigation-url";

declare global {
  interface Window {
    workerScripts: Record<string, string>;
    __harnessUrl?: string;
    mountForecast: (options: { mode: "demo" | "readonly"; url?: string }) => void;
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
} as typeof Worker;

window.mountForecast = ({ mode, url }) => {
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
        solutions={mode === "demo" ? [DEMO_FORECAST_SOLUTION] : []}
      />
    </div>,
  );
};
