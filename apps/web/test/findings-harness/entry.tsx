// Findings on a bare page, for the browser tests in ../findings-browser.test.ts (issue #175, B17). Bundled by esbuild and
// driven through `window.mountFindings`; nothing here ships. It is the process page's findings section as the page wires it
// (the analysis panel with its review list, and the accepted findings with Acknowledge as issue), in demo mode: findings
// and issues in memory, on Northbeam's sample, starting with the three findings the demo's analysis proposed.

import { useMemo } from "react";
import { createRoot } from "react-dom/client";
import { NORTHBEAM_PROCESS_ID, nameAnalysisRow, nameFinding, type AiAnalysisRow, type FindingRow, type NameSource } from "@transpera-flow/db";
import { AnalysisPanel } from "@/components/findings/analysis-panel";
import type { FindingDialogOptions } from "@/components/findings/finding-dialog";
import { InsightsSection } from "@/components/insights";
import { demoAiView } from "@/lib/ai/demo";
import { aiViewFromRow } from "@/lib/ai/types";
import { demoAnalyse, demoFindings } from "@/lib/findings/demo";
import { useFindings } from "@/lib/findings/use-findings";
import { findingsIn, pageDetections, proposedFindings } from "@/lib/findings/view";
import { issueFormOptions } from "@/lib/issues/draft";
import { useIssues } from "@/lib/issues/use-issues";
import { processSteps } from "@/lib/process-steps";
import { demoBundle } from "@/lib/sources/demo";

declare global {
  interface Window {
    /** `member`: the AI text is stored with labels and shown to a member linked to no one (B1 2b), named through `nameAnalysisRow` and `nameFinding`. */
    mountFindings: (options: { mode: "demo" | "readonly"; member?: boolean; connector?: boolean }) => void;
    /** `connector`: the first proposed finding came from Claude over the MCP connector (B20). */
  }
}

const MAYA = "00000000-0000-4000-8000-00000000000a";
const ROSA = "00000000-0000-4000-8000-00000000000b";
const LABELS = { "Team member A": MAYA, "Team member B": ROSA };
/** A member linked to no one: they see "A team member" wherever the saved text has a label. */
const MEMBER: NameSource = { viewer: { seesEveryone: false, ownPersonId: null }, people: [] };
const AT = "2026-10-01T09:00:00.000Z";

/** An analysis and a proposed finding as the app now saves them: the model's own text, with labels. */
function savedWithLabels(processId: string, workspaceId: string) {
  const analysis: AiAnalysisRow = {
    id: "00000000-0000-4000-8000-0000000000a1",
    workspace_id: workspaceId,
    process_id: processId,
    revision_id: "00000000-0000-4000-8000-0000000000a2",
    status: "ok",
    reason: null,
    trigger: "manual",
    summary: ["Team member A is overloaded, and Team member B covers for Team member A."],
    insights: [],
    review: [],
    checked: 1,
    dropped: 0,
    input_hash: "h",
    model: "fake",
    model_hash: null,
    usage: [],
    run_id: "00000000-0000-4000-8000-0000000000a3",
    person_labels: LABELS,
    created_by: "u",
    created_at: AT,
    updated_at: AT,
  };
  const finding: FindingRow = {
    id: "00000000-0000-4000-8000-0000000000f1",
    workspace_id: workspaceId,
    process_id: processId,
    step_id: null,
    origin: "ai",
    status: "proposed",
    rating: "bad",
    type: "capacity",
    title: "Team member A carries the whole line",
    evidence: "Team member B only reviews what Team member A writes.",
    why: "Team member A is the only one who can price.",
    facts: [],
    person_labels: LABELS,
    source_ids: [],
    ai_key: "ai:insight:333333333333",
    analysis_id: analysis.id,
    run_id: analysis.run_id,
    edited: false,
    proposed_via: null,
    created_by: null,
    created_at: AT,
    updated_by: null,
    updated_at: AT,
    decided_by: null,
    decided_at: null,
  };
  return { view: aiViewFromRow(nameAnalysisRow(analysis, MEMBER)), finding: nameFinding(finding, MEMBER) };
}

function Harness({ mode, member, connector }: { mode: "demo" | "readonly"; member: boolean; connector: boolean }) {
  const bundle = useMemo(() => demoBundle(), []);
  const labelled = useMemo(() => savedWithLabels(bundle.process.id, bundle.workspace.id), [bundle]);
  const initial = useMemo(() => demoFindings(NORTHBEAM_PROCESS_ID).map((f, i) => (connector && i === 0 ? { ...f, proposed_via: "connector" as const } : f)), [connector]);
  const findings = useFindings(bundle.workspace.id, member ? [labelled.finding] : initial, mode);
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
        ai={{ view: member ? labelled.view : demoAiView(bundle.process.id), configured: true, hasFirstPrinciples: true, versionNumber: 3 }}
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

window.mountFindings = ({ mode, member = false, connector = false }) => {
  createRoot(document.getElementById("root")!).render(<Harness mode={mode} member={member} connector={connector} />);
};
