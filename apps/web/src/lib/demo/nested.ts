// A nested view of the demo process (issue #102), for trying groups on the map
// without a database: `/demo?nested=1`. The same Northbeam, with its first two
// sales steps in one group and its campaign set-up steps in another. Nothing
// about the numbers changes (the engine simulates the steps inside), which
// the tests check against the flat model.

import { northbeamStepIds as ids, type EdgeRow, type ProcessBundle, type StepRow } from "@transpera-flow/db";
import { GROUP_PADDING } from "@/lib/map/groups";

export const DEMO_GROUP_IDS = {
  conversation: "e0000000-0000-4000-8000-0000000000a1",
  setup: "e0000000-0000-4000-8000-0000000000a2",
} as const;

const GROUPS: { id: string; name: string; steps: string[]; entry: string }[] = [
  { id: DEMO_GROUP_IDS.conversation, name: "Sales conversation", steps: [ids.qualify, ids.discovery], entry: ids.qualify },
  { id: DEMO_GROUP_IDS.setup, name: "Campaign set-up", steps: [ids.seo, ids.ppc, ids.live], entry: ids.seo },
];

const NESTED_AT: Record<string, { x: number; y: number }> = {
  [ids.kickoff]: { x: 290, y: 374 },
  [ids.seo]: { x: 520, y: 290 },
  [ids.ppc]: { x: 520, y: 436 },
};

/** The bundle with two groups: steps inside them are placed relative to their box, and the start step leads into the first. */
export function withDemoGroups(bundle: ProcessBundle): ProcessBundle {
  const template = bundle.steps[0]!;
  // The closed "Campaign set-up" card sits 56 px above its highest step, so at the flat map's positions it would cover the
  // line from Client decision back to Contract & onboarding (y ≈ 220). Its steps and Kickoff (whose branch labels need
  // room between SEO and PPC) move down here, in the nested view only.
  let steps = bundle.steps.map((s) => {
    const at = NESTED_AT[s.id];
    return at ? { ...s, ...at } : s;
  });
  for (const g of GROUPS) {
    const inside = steps.filter((s) => g.steps.includes(s.id));
    const x = Math.min(...inside.map((s) => Number(s.x))) - GROUP_PADDING.left;
    const y = Math.min(...inside.map((s) => Number(s.y))) - GROUP_PADDING.top;
    const group: StepRow = {
      ...template,
      id: g.id,
      name: g.name,
      kind: "group",
      outcome: null,
      role_id: null,
      person_id: null,
      work_hours: 0,
      wait_hours: 0,
      rework_rate: 0,
      rework_to_step_id: null,
      tool: null,
      notes: null,
      sla_hours: null,
      current_wip: null,
      parent_step_id: null,
      entry_step_id: g.entry,
      child_process_id: null,
      assumption: false,
      conflict: false,
      provenance: {},
      x,
      y,
    };
    steps = [...steps.map((s) => (g.steps.includes(s.id) ? { ...s, parent_step_id: g.id, x: Number(s.x) - x, y: Number(s.y) - y } : s)), group];
  }
  const edges: EdgeRow[] = bundle.edges.map((e) => (e.from_step_id === ids.start ? { ...e, to_step_id: DEMO_GROUP_IDS.conversation } : e));
  return { ...bundle, steps, edges };
}
