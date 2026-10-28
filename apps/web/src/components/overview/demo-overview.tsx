import { defaultCompanyPart, northbeamIssues, partOf, processesOf } from "@transpera-flow/db";
import { Overview } from "@/components/overview/overview";
import { DEMO_FORECAST_START } from "@/lib/forecast/demo";
import { demoBundle } from "@/lib/sources/demo";

/** The Overview of the Northbeam demo (issue #100): the landing page of `/demo`, also at `/demo/overview`. No database. */
export function DemoOverview() {
  const live = demoBundle();
  const parts = [partOf(live), ...(live.otherProcesses ?? [])];
  const hrefs = Object.fromEntries(processesOf(live).map((p) => [p.id, `/demo/p/${p.id}`]));
  return (
    <Overview
      workspaceName={live.workspace.name}
      live={live}
      parts={parts}
      company={defaultCompanyPart(live.workspace.id, parts)}
      issues={northbeamIssues()}
      mode="demo"
      hrefs={hrefs}
      processesHref="/demo/processes"
      issuesHref="/demo/issues"
      forecastHref="/demo/sandbox"
      // The demo's months don't move, so its screenshots and tests don't either.
      startDate={DEMO_FORECAST_START}
    />
  );
}
