import { northbeamIssues } from "@transpera-flow/db";
import { SandboxView } from "@/components/sandbox/sandbox-view";
import { Page } from "@/components/shell/page";
import { DEMO_FORECAST_SOLUTION, DEMO_FORECAST_START, demoForecastBundle } from "@/lib/forecast/demo";
import { demoSources } from "@/lib/sources/demo";

/** The Sandbox on the demo: Northbeam with sample scenarios (a hire in January, a hire in March with a solution, and one that builds on it). */
export default function DemoSandboxPage() {
  return (
    <Page title="Sandbox" width="max-w-6xl" hideHeader>
      <SandboxView
        live={demoForecastBundle()}
        issues={northbeamIssues()}
        sources={demoSources()}
        mode="demo"
        issuesHref="/demo/issues"
        startDate={DEMO_FORECAST_START}
        solutions={[DEMO_FORECAST_SOLUTION]}
        note={
          <>
            Try a change before you make it. Demo mode: Northbeam from 5 October 2026 with Jade Hart joining as a PPC specialist in February,
            Leah Brooks on leave over Christmas, and the sample market schedule. Open the sample scenarios “Hire in January”, “Hire in March” and
            “Hire in March, then more leads” (which builds on it), or start your own
            {/* A phone can't move changes (issue #44). */}
            <span className="max-sm:hidden">, or drag a change along the months</span>. Scenarios are kept in this tab only.
          </>
        }
      />
    </Page>
  );
}
