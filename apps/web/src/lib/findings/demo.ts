// The public demo's findings (issue #175, B17): the AI findings its analysis (written in advance, lib/ai/demo.ts)
// proposed for the Northbeam sample, waiting for review in this tab. "Analyse" on the demo calls no AI: it waits a moment
// and proposes the same findings again (those already decided stay decided).

import { NORTHBEAM_PROCESS_ID, NORTHBEAM_WORKSPACE_ID, type FindingRow } from "@transpera-flow/db";
import { demoAiView } from "@/lib/ai/demo";
import type { AiRunReply } from "@/lib/ai/reply";
import type { FindingsState } from "./use-findings";

const AT = "2026-09-30T09:00:00.000Z";

/** The demo analysis's findings, proposed: on the pipeline's own steps, or the pipeline as a whole. */
export function demoFindings(processId: string = NORTHBEAM_PROCESS_ID): FindingRow[] {
  const view = demoAiView(processId);
  if (!view) return [];
  return view.insights.map((i, n) => ({
    id: `00000000-0000-4000-9000-${String(n + 1).padStart(12, "0")}`,
    workspace_id: NORTHBEAM_WORKSPACE_ID,
    process_id: processId,
    step_id: i.stepId,
    origin: "ai",
    status: "proposed",
    rating: i.rating,
    type: i.type,
    title: i.title,
    evidence: i.evidence,
    why: i.why,
    facts: (i.facts ?? []) as unknown as FindingRow["facts"],
    person_labels: {},
    source_ids: [],
    ai_key: i.key,
    analysis_id: null,
    run_id: null,
    edited: false,
    created_by: null,
    created_at: AT,
    updated_by: null,
    updated_at: AT,
    decided_by: null,
    decided_at: null,
  }));
}

/** "Analyse" on the demo: nothing is sent anywhere. */
export async function demoAnalyse(state: Pick<FindingsState, "findings" | "receive">, processId: string): Promise<AiRunReply> {
  await new Promise((r) => setTimeout(r, 700));
  const fresh = demoFindings(processId).filter((f) => !state.findings.some((g) => g.ai_key === f.ai_key));
  state.receive(fresh);
  return {
    status: "ok",
    message: fresh.length
      ? `Analysis done: ${fresh.length} finding${fresh.length === 1 ? "" : "s"} to review. (Demo: written in advance; nothing was sent to an AI.)`
      : "Nothing has changed since the last analysis, so it wasn't run again. (Demo: nothing was sent to an AI.)",
  };
}
