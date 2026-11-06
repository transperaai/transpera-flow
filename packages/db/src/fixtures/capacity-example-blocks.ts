// Example blocks for the preview's example agency (capacity QA package Q12), for QA of the Block library.
//
// `addExampleBlocks(db, workspaceId)` adds four reusable blocks built from the example's real steps (their base values, split and tier
// multipliers travel with them), and one solution that puts "Client approval loop" in place of the step it was taken from, so the
// library shows "Used in 1 solution" on it:
//   - Client approval loop: send, wait for approval, revise;
//   - QA and sign-off: check, sign off;
//   - Monthly report: pull data, commentary, send;
//   - Link vetting pair: pre-screen, final look.
//
// THE DATA IS MADE UP, like the example's. A block is saved with the insert the app makes ("Save to library": `blocks`, type "manual"),
// the solution through `save_solution`, which checks the caller from the JWT claims: as in capacity-example-issues.ts this sets the
// claims of an agency admin for the length of the caller's transaction and puts the old ones back.
//
// Run it inside a transaction. It is idempotent: a block whose name is already in the workspace's library is left alone, and the
// solution is only added with the block it uses, once, and only if the issue it solves is there.

import { randomUUID } from "node:crypto";
import { capacityModel } from "@transpera-flow/engine";
import type { Queryable } from "../capacity-starter";
import { EXAMPLE_MARKER_PROCESS } from "./capacity-example-issues";

export type ExampleBlocksResult =
  | { applied: true; blocks: number; solutions: number }
  | { applied: false; reason: string };

interface Row {
  [column: string]: unknown;
}

/** The columns of a step a block keeps (the same list the app keeps, apps/web/src/lib/blocks/blocks.ts). */
const STEP_KEYS = [
  "id", "name", "kind", "outcome", "role_id", "person_id", "work_hours", "work_dist", "work_params", "wait_hours", "wait_dist", "wait_params",
  "rework_rate", "rework_to_step_id", "tool", "purpose", "split", "split_notes", "tier_multiplier", "to_client_manager", "notes", "sla_hours", "expected_wait_hours", "lost_per_day_waiting", "dropoff_benchmark",
  "target_cycle_hours", "current_wip", "x", "y", "parent_step_id", "entry_step_id", "child_process_id", "assumption", "conflict", "provenance",
] as const;

interface PartSpec {
  name: string;
  work_hours: number;
  wait_hours?: number;
  to_client_manager?: boolean;
}

interface BlockSpec {
  key: string;
  name: string;
  description: string;
  /** The example process (by key in the model) and the real step the parts are made from: they keep its role, split and tier multipliers. */
  process: string;
  from: string;
  parts: PartSpec[];
}

const BLOCKS: BlockSpec[] = [
  {
    key: "approval", name: "Client approval loop", process: "org-monthly", from: "Project plan & approvals",
    description: "Send the plan to the client, wait for their approval, then revise what they ask for. Taken from the monthly plan and approvals step.",
    parts: [{ name: "Send for approval", work_hours: 0.5 }, { name: "Wait for client approval", work_hours: 0, wait_hours: 24 }, { name: "Revise after feedback", work_hours: 1.5 }],
  },
  {
    key: "qa", name: "QA and sign-off", process: "perf-builds", from: "Ad QA",
    description: "Check the work, then a manager signs it off before it goes to the client. Taken from Ad QA.",
    parts: [{ name: "Check the work", work_hours: 0.25 }, { name: "Sign off", work_hours: 0.0833, to_client_manager: true }],
  },
  {
    key: "report", name: "Monthly report", process: "perf-monthly", from: "Monthly report commentary",
    description: "Pull the month's numbers, write the commentary and send the report. Taken from the Performance monthly report.",
    parts: [{ name: "Pull the data", work_hours: 0.5 }, { name: "Write the commentary", work_hours: 0.5 }, { name: "Send the report", work_hours: 0.1667, to_client_manager: true }],
  },
  {
    key: "vetting", name: "Link vetting pair", process: "org-links", from: "Domain vetting",
    description: "A quick pre-screen of a link domain, then a final look before it goes live. Taken from Domain vetting.",
    parts: [{ name: "Pre-screen the domain", work_hours: 0.0333 }, { name: "Final look", work_hours: 0.0333 }],
  },
];

/** The solution that uses "Client approval loop", and the issue it solves. */
const SOLUTION = { name: "One approval loop for monthly plans", issue: "Monthly plans wait on client approval", block: "approval", process: "org-monthly", step: "Project plan & approvals" };

/**
 * Adds the example blocks (and the one solution that uses a block) to a workspace the example loader filled. Run inside a transaction.
 * Does nothing, and says why, for a workspace that doesn't hold the example or whose library already has all four blocks.
 */
export async function addExampleBlocks(db: Queryable, workspaceId: string): Promise<ExampleBlocksResult> {
  const rows = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows as Row[];
  const one = async (sql: string, params: unknown[]) => (await rows(sql, params))[0]!;

  if ((await rows("select 1 from public.workspaces where id = $1 for update", [workspaceId])).length === 0) return { applied: false, reason: "No such workspace." };
  if ((await rows("select 1 from public.processes where workspace_id = $1 and name = $2 and is_company is not true", [workspaceId, EXAMPLE_MARKER_PROCESS])).length === 0) {
    return { applied: false, reason: `The workspace doesn't hold the example (no process called "${EXAMPLE_MARKER_PROCESS}"): this is only for one the example loader filled.` };
  }
  const have = new Set((await rows("select name from public.blocks where workspace_id = $1", [workspaceId])).map((r) => String(r.name)));
  const missing = BLOCKS.filter((b) => !have.has(b.name));
  if (missing.length === 0) return { applied: false, reason: "The block library already has the example blocks: nothing was added." };

  const model = capacityModel();
  const processNames = new Map(Object.entries(model.servicingProcesses!).map(([key, p]) => [key, p.name]));

  const previous = String((await one("select coalesce(current_setting('request.jwt.claims', true), '') as v", [])).v);
  await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role: "authenticated", app_metadata: { agency_admin: true } })]);
  try {
    const live = async (process: string) => {
      const p = await one("select id, live_revision_id from public.processes where workspace_id = $1 and name = $2 and is_company is not true", [workspaceId, processNames.get(process)]);
      return { id: String(p.id), revision: String(p.live_revision_id) };
    };
    const stepRow = async (process: string, step: string) => {
      const found = await rows("select to_jsonb(s) as r from public.steps s where s.revision_id = $1 and s.name = $2 and s.kind = 'task'", [(await live(process)).revision, step]);
      if (found.length !== 1) throw new Error(`The example has no single step "${step}" in "${processNames.get(process)}".`);
      return found[0]!.r as Record<string, unknown>;
    };

    // ---- the blocks: the real step's values on each part, chained in order ----------------------------------------------------------
    const bundles = new Map<string, { steps: Record<string, unknown>[]; edges: Record<string, unknown>[]; entry_step_id: string | null }>();
    const blockIds = new Map<string, string>();
    for (const spec of missing) {
      const base = await stepRow(spec.process, spec.from);
      const steps = spec.parts.map((part, i) => {
        const row: Record<string, unknown> = {};
        for (const k of STEP_KEYS) if (k in base) row[k] = base[k];
        return {
          ...row,
          id: randomUUID(),
          name: part.name,
          kind: "task",
          work_hours: part.work_hours,
          wait_hours: part.wait_hours ?? 0,
          to_client_manager: part.to_client_manager ?? base.to_client_manager === true,
          parent_step_id: null,
          entry_step_id: null,
          rework_to_step_id: null,
          child_process_id: null,
          current_wip: null,
          x: 40 + i * 240,
          y: 60,
        } as Record<string, unknown>;
      });
      const edges = steps.slice(1).map((s, i) => ({ id: randomUUID(), from_step_id: steps[i]!.id, to_step_id: s.id, probability: 1, condition_tag: null, label: null }));
      const bundle = { steps, edges, entry_step_id: steps[0]!.id as string };
      bundles.set(spec.key, bundle);
      // The insert "Save to library" makes (apps/web/src/app/w/[slug]/block-actions.ts).
      const saved = await one("insert into public.blocks (workspace_id, name, description, type, steps) values ($1, $2, $3, 'manual', $4::jsonb) returning id", [
        workspaceId,
        spec.name,
        spec.description,
        JSON.stringify(bundle),
      ]);
      blockIds.set(spec.key, String(saved.id));
    }

    // ---- one solution that uses a block ------------------------------------------------------------------------------------------------
    let solutions = 0;
    const blockId = blockIds.get(SOLUTION.block);
    const issue = blockId ? await rows("select id from public.issues where workspace_id = $1 and title = $2", [workspaceId, SOLUTION.issue]) : [];
    const exists = await rows("select 1 from public.solutions where workspace_id = $1 and name = $2", [workspaceId, SOLUTION.name]);
    if (blockId && issue.length === 1 && exists.length === 0) {
      const { id: processId, revision } = await live(SOLUTION.process);
      const steps = (await rows("select to_jsonb(s) - 'revision_id' - 'workspace_id' - 'process_id' as r from public.steps s where s.revision_id = $1 order by s.x, s.id", [revision])).map((r) => r.r as Record<string, unknown>);
      const edges = (await rows("select to_jsonb(e) - 'revision_id' - 'workspace_id' - 'process_id' as r from public.edges e where e.revision_id = $1 order by e.id", [revision])).map((r) => r.r as Record<string, unknown>);
      const target = steps.find((s) => s.name === SOLUTION.step)!;
      const bundle = bundles.get(SOLUTION.block)!;
      // The step becomes a group named after the block (as the Editor's insert makes one), marked with the block it came from, around fresh copies of the block's steps.
      const ids = new Map(bundle.steps.map((s) => [s.id as string, randomUUID()]));
      const group: Record<string, unknown> = {
        ...target,
        name: BLOCKS.find((b) => b.key === SOLUTION.block)!.name,
        kind: "group",
        role_id: null,
        person_id: null,
        work_hours: 0,
        wait_hours: 0,
        rework_rate: 0,
        split: null,
        split_notes: null,
        tier_multiplier: null,
        to_client_manager: false,
        entry_step_id: ids.get(bundle.entry_step_id!)!,
        provenance: { ...((target.provenance as Record<string, unknown> | null) ?? {}), block: blockId },
      };
      const children = bundle.steps.map((s) => {
        const copy: Record<string, unknown> = { ...target };
        // Keep the shared columns of a step row, then lay the block's step over them.
        for (const k of STEP_KEYS) if (k in s) copy[k] = s[k];
        return { ...copy, id: ids.get(s.id as string)!, parent_step_id: target.id, entry_step_id: null, x: Number(s.x), y: Number(s.y) };
      });
      const inner = bundle.edges.map((e) => ({ ...e, id: randomUUID(), from_step_id: ids.get(e.from_step_id as string)!, to_step_id: ids.get(e.to_step_id as string)! }));
      // The group is wider than the step it replaces: what sits to its right moves along, so the map doesn't draw one over the other.
      const rest = steps.filter((s) => s.id !== target.id).map((s) => (s.parent_step_id == null && Number(s.x) > Number(target.x) ? { ...s, x: Number(s.x) + 640 } : s));
      const copy = { steps: [...rest, group, ...children], edges: [...edges, ...inner], entry_step_id: null };
      const saved = await one("select public.save_solution(p_workspace => $1, p_process => $2, p_base_revision => $3, p_name => $4, p_steps => $5::jsonb, p_changed => $6::jsonb, p_links => $7::jsonb) as solution", [
        workspaceId,
        processId,
        revision,
        SOLUTION.name,
        JSON.stringify(copy),
        JSON.stringify([target.id, ...children.map((c) => c.id)]),
        JSON.stringify([{ issue_id: issue[0]!.id, auto_verdict: null, holds_pct: null, auto_note: "This issue has no goal to check against. Give your own verdict." }]),
      ]);
      void saved;
      solutions = 1;
    }
    return { applied: true, blocks: missing.length, solutions };
  } finally {
    await db.query("select set_config('request.jwt.claims', $1, true)", [previous]);
  }
}
