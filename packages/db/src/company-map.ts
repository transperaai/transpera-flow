// The company map's default layout (issue #163, B11): where each top-level process sits on the map and which handoff
// lines join them, before anyone has moved anything. This is what the migration's backfill (20261126000000) writes
// into every workspace's stored company map, and what the demo shows (it has no database). Pure: the same processes
// always give the same map.
//
// Sales pipelines go in the first column, then the processes that serve clients after a win in the second; each
// column is centred on the taller one, and every pipeline hands its wins to every servicing process.

import type { EdgeRow, ProcessPart, StepRow } from "./types";

/** One closed card of a process on the map, and the space between cards (the Overview's `GROUP_CARD`). */
export const COMPANY_CARD = { width: 192, height: 124 } as const;
export const COMPANY_GAP = { x: 96, y: 36 } as const;

/** The id the demo gives the company process (it has no row to take one from). */
export const DEMO_COMPANY_PROCESS_ID = "company";

/** The holder step of a process on the company map. */
export const holderStepId = (processId: string) => `company:${processId}`;

function holder(workspaceId: string, revisionId: string, part: ProcessPart, x: number, y: number): StepRow {
  return {
    id: holderStepId(part.process.id),
    revision_id: revisionId,
    workspace_id: workspaceId,
    process_id: DEMO_COMPANY_PROCESS_ID,
    name: part.process.name,
    kind: "subprocess",
    outcome: null,
    role_id: null,
    person_id: null,
    work_hours: 0,
    work_dist: "lognormal",
    work_params: {},
    wait_hours: 0,
    wait_dist: "lognormal",
    wait_params: {},
    rework_rate: 0,
    rework_to_step_id: null,
    tool: null,
    purpose: null,
    split: null,
    split_notes: null,
    tier_multiplier: null,
    to_client_manager: false,
    notes: null,
    sla_hours: null,
    expected_wait_hours: null,
    lost_per_day_waiting: null,
    dropoff_benchmark: null,
    target_cycle_hours: null,
    current_wip: null,
    x,
    y,
    parent_step_id: null,
    entry_step_id: null,
    child_process_id: part.process.id,
    assumption: false,
    conflict: false,
    provenance: {},
  };
}

/**
 * The company map of `parts` (every process at its live revision, in the order the workspace lists them) as a stored
 * map would hold it: a holder step per top-level process and the pipeline-to-servicing handoff edges. A top-level
 * process is one with no parent among `parts`.
 */
export function defaultCompanyPart(workspaceId: string, parts: readonly ProcessPart[]): ProcessPart {
  const known = new Set(parts.map((p) => p.process.id));
  const tops = parts.filter((p) => !p.process.parent_process_id || !known.has(p.process.parent_process_id) || p.process.parent_process_id === p.process.id);
  const revisionId = `${DEMO_COMPANY_PROCESS_ID}:revision`;
  const columns = [tops.filter((p) => p.process.kind !== "servicing"), tops.filter((p) => p.process.kind === "servicing")].filter((c) => c.length);
  const heights = columns.map((col) => col.length * COMPANY_CARD.height + COMPANY_GAP.y * (col.length - 1));
  const tallest = Math.max(0, ...heights);
  const steps: StepRow[] = [];
  columns.forEach((col, ci) => {
    // Pipelines are always column 0 and servicing processes column 1, even when the other kind is missing.
    const x = col[0]!.process.kind === "servicing" ? COMPANY_CARD.width + COMPANY_GAP.x : 0;    let y = (tallest - heights[ci]!) / 2;
    for (const part of col) {
      steps.push(holder(workspaceId, revisionId, part, x, y));
      y += COMPANY_CARD.height + COMPANY_GAP.y;
    }
  });
  const edges: EdgeRow[] = [];
  const pipelines = columns.length === 2 ? columns[0]! : [];
  const servicing = columns.length === 2 ? columns[1]! : [];
  for (const from of pipelines) {
    for (const to of servicing) {
      edges.push({
        id: `company:${from.process.id}:${to.process.id}`,
        revision_id: revisionId,
        workspace_id: workspaceId,
        process_id: DEMO_COMPANY_PROCESS_ID,
        from_step_id: holderStepId(from.process.id),
        to_step_id: holderStepId(to.process.id),
        probability: 1,
        condition_tag: null,
        label: null,
      });
    }
  }
  return {
    process: { id: DEMO_COMPANY_PROCESS_ID, workspace_id: workspaceId, name: "Company map", kind: "pipeline", entity_name: "process", description: null, live_revision_id: revisionId, parent_process_id: null, is_company: true },
    revision: { id: revisionId, workspace_id: workspaceId, process_id: DEMO_COMPANY_PROCESS_ID, number: 1, status: "published" },
    steps,
    edges,
  };
}
