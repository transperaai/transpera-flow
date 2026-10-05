// The Overview's map tier and findings tier on a bare page, for ../overview-browser.test.ts (issue #173): the company map
// with Play and the horizon picker, run for the horizon picked, and the findings by process. Bundled by esbuild and driven
// through `window.mountOverview`; nothing here ships. The simulation runs on the page (a few runs, so the test is quick);
// the app runs the same model in a worker.

import { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { partOf, toEngineModel } from "@transpera-flow/db";
import { simulate } from "@transpera-flow/engine";
import { HorizonPicker } from "@/components/horizon-picker";
import { NO_SELECTION, ProcessCanvas } from "@/components/process-canvas";
import { FindingsByProcess } from "@/components/overview/findings-by-process";
import { DEMO_FORECAST_START } from "@/lib/forecast/demo";
import { forecastModel } from "@/lib/forecast/forecast";
import { horizonLabel, horizonWeeks } from "@/lib/horizon";
import { buildInsights } from "@/lib/insights/insights";
import { registerEntries } from "@/lib/issues/register";
import { findingsByProcess } from "@/lib/overview/by-process";
import { companyMap } from "@/lib/overview/company-map";
import { timeSplitOf, workingShare } from "@/lib/overview/health";
import { rerate } from "@/lib/rules/edit";
import { demoBundle } from "@/lib/sources/demo";

declare global {
  interface Window {
    mountOverview: () => void;
    /** Runs simulated so far, by horizon in weeks: the page simulates once per horizon. */
    runs: number[];
  }
}

const live = demoBundle();
const parts = [partOf(live), ...(live.otherProcesses ?? [])];
const base = toEngineModel(live);
const baseResult = simulate(base, 3, 1);
const groups = findingsByProcess({ parts, pipelineId: live.process.id, insights: buildInsights(registerEntries([], rerate(base, baseResult, {}, live.process.id))), issues: [], solutions: [] });

function Harness() {
  const [months, setMonths] = useState(3);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const result = useMemo(() => {
    const built = forecastModel(live, months, DEMO_FORECAST_START);
    window.runs.push(built.model!.horizonWeeks);
    return { model: built.model!, result: simulate(built.model!, 3, 1, { monthly: true, monthStarts: built.monthStarts! }) };
  }, [months]);
  const map = useMemo(() => companyMap(live, parts, expanded), [expanded]);
  const share = workingShare(timeSplitOf(result.model, result.result)!)!;
  return (
    <div style={{ width: 1200, display: "flex", flexDirection: "column", gap: 16 }}>
      <div data-map-controls>
        <HorizonPicker weeks={horizonWeeks(months)} onChange={setMonths} help={false} />
        <p data-horizon-note>Playing {horizonLabel(months)} of work</p>
        <p data-flow-share>{Math.round(share * 100)}% working</p>
      </div>
      <div style={{ display: "flex", flexDirection: "column", height: 520 }}>
        <ProcessCanvas
          key={[...expanded].sort().join("|")}
          bundle={map.bundle}
          result={result.result}
          selection={NO_SELECTION}
          expanded={expanded}
          onExpandedChange={setExpanded}
          playbackRollUp
          showLanes={false}
          handoffs
          height="fill"
          stepDetail={false}
        />
      </div>
      <FindingsByProcess groups={groups} renderFindings={(g) => <ul data-rendered>{g.insights.map((i) => <li key={i.key}>{i.title}</li>)}</ul>} />
    </div>
  );
}

window.runs = [];
window.mountOverview = () => createRoot(document.getElementById("root")!).render(<Harness />);
