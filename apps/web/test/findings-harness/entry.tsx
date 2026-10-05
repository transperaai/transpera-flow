// Findings on a bare page, for the browser tests in ../findings-browser.test.ts (issue #175, B17). Bundled by esbuild and
// driven through `window.mountFindings`; nothing here ships. It is the process page's findings section as the page wires it
// (the analysis panel with its review list, and the accepted findings with Acknowledge as issue), in demo mode: findings
// and issues in memory, on Northbeam's sample, starting with the three findings the demo's analysis proposed.

import { useMemo } from "react";
import { createRoot } from "react-dom/client";
import { NORTHBEAM_PROCESS_ID } from "@transpera-flow/db";
import { AnalysisPanel } from "@/components/findings/analysis-panel";
import type { FindingDialogOptions } from "@/components/findings/finding-dialog";
import { InsightsSection } from "@/components/insights";
import { demoAiView } from "@/lib/ai/demo";
import { demoAnalyse, demoFindings } from "@/lib/findings/demo";
import { useFindings } from "@/lib/findings/use-findings";
import { findingsIn, pageDetections, proposedFindings } from "@/lib/findings/view";
import { issueFormOptions } from "@/lib/issues/draft";
import { useIssues } from "@/lib/issues/use-issues";
import { processSteps } from "@/lib/process-steps";
import { demoBundle } from "@/lib/sources/demo";

declare global {
  interface Window {
    mountFindings: (options: { mode: "demo" | "readonly" }) => void;
  }
}

function Harness({ mode }: { mode: "demo" | "readonly" }) {
  const bundle = useMemo(() => demoBundle(), []);
  const findings = useFindings(bundle.workspace.id, demoFindings(NORTHBEAM_PROCESS_ID), mode);
  const issues = useIssues(bundle.workspace.id, [], mode);
  const steps = useMemo(() => processSteps(bundle).filter((s) => s.kind !== "start" && s.kind !== "end"), [bundle]);
  const options: FindingDialogOptions = { processes: [{ id: bundle.process.id, name: bundle.process.name }], company: false, steps: steps.map((s) => ({ id: s.id, name: s.name, processId: bundle.process.id })) };
  const own = findingsIn(findings.findings, { processIds: new Set([bundle.process.id]) });
  const detected = pageDetections({ findings: own, issues: issues.issues, facts: [] });
  const names = new Map(steps.map((s) => [s.id, s.name]));
  return (
    <div className="flex flex-col gap-3 p-4">
      <AnalysisPanel
        mode={mode}
        scope="process"
        ai={{ view: demoAiView(bundle.process.id), configured: true, hasFirstPrinciples: true, versionNumber: 3 }}
        findings={findings}
        proposed={proposedFindings(own)}
        options={options}
        defaultProcessId={bundle.process.id}
        stepName={(id) => names.get(id) ?? null}
        analyse={() => demoAnalyse(findings, bundle.process.id)}
      />
      <InsightsSection
        state={issues}
        detected={detected}
        processId={bundle.process.id}
        scenarios={[]}
        currency={bundle.workspace.settings.currency}
        stepName={(id) => names.get(id) ?? null}
        onLight={() => {}}
        canEdit={mode !== "readonly"}
        formOptions={issueFormOptions({ processes: options.processes, steps, people: [], sources: [] })}
        findings={findings}
        findingOptions={options}
      />
    </div>
  );
}

window.mountFindings = ({ mode }) => {
  createRoot(document.getElementById("root")!).render(<Harness mode={mode} />);
};
