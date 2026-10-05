import { northbeamIssues } from "@transpera-flow/db";
import { ForecastView } from "@/components/forecast/forecast-view";
import { Page } from "@/components/shell/page";
import { DEMO_FORECAST_START, demoForecastBundle } from "@/lib/forecast/demo";
import { demoSources } from "@/lib/sources/demo";

/** The Forecast on the demo (issue #35): Northbeam with a sample plan (a hire in February, leave over Christmas, a market schedule). */
export default function DemoForecastPage() {
  return (
    <Page title="Forecast" width="max-w-6xl" hideHeader>
      <ForecastView
        live={demoForecastBundle()}
        issues={northbeamIssues()}
        sources={demoSources()}
        mode="demo"
        issuesHref="/demo/issues"
        startDate={DEMO_FORECAST_START}
        note="Who gets too busy, and when. Demo mode: Northbeam from 5 October 2026 with a sample plan: Jade Hart joins as a PPC specialist in February, Leah Brooks is on leave over Christmas, and the sample market schedule applies."
      />
    </Page>
  );
}
