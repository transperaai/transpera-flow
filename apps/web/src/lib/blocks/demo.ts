// The demo's block library (issue #116): a few blocks built from Northbeam's own steps, and an in-memory store the
// library page and the Editor share for the length of the tab (like the rest of the demo, gone on reload).

import { useSyncExternalStore } from "react";
import { NORTHBEAM_WORKSPACE_ID, type BlockRow, type ProcessBundle, type StepRow } from "@transpera-flow/db";
import { northbeamStepIds as ids } from "@transpera-flow/db";
import { DEMO_GROUP_IDS, withDemoGroups } from "@/lib/demo/nested";
import { demoBundle } from "@/lib/sources/demo";
import { blockFromGroup, blockFromSteps } from "./blocks";
import type { BlockInput } from "./save";

const SEEDED = "2026-09-30T09:00:00.000Z";

/** A work step shaped like the demo's, for the blocks that have none to copy. */
function task(template: StepRow, id: string, name: string, x: number, hours: number, notes: string | null): StepRow {
  return { ...template, id, name, kind: "task", outcome: null, work_hours: hours, wait_hours: 0, notes, x, y: 56, parent_step_id: null, entry_step_id: null, rework_rate: 0, rework_to_step_id: null, current_wip: null, provenance: {} };
}

function seed(): BlockRow[] {
  const nested: ProcessBundle = withDemoGroups(demoBundle());
  const template = nested.steps.find((s) => s.id === ids.qualify)!;
  const row = (id: string, name: string, description: string, type: BlockRow["type"], steps: BlockRow["steps"]): BlockRow => ({
    id,
    workspace_id: NORTHBEAM_WORKSPACE_ID,
    name,
    description,
    type,
    steps,
    created_at: SEEDED,
    updated_at: SEEDED,
  });
  const a = "b1000000-0000-4000-8000-0000000000a1";
  const b = "b1000000-0000-4000-8000-0000000000a2";
  const c = "b1000000-0000-4000-8000-0000000000a3";
  const approval = blockFromSteps({
    steps: [task(template, a, "Send for sign-off", 24, 0.5, "Email the client the one-page summary."), task(template, b, "Chase if no reply", 214, 0.25, null), task(template, c, "Record the decision", 404, 0.25, null)],
    edges: [
      { id: "b2000000-0000-4000-8000-0000000000a1", revision_id: "", workspace_id: "", process_id: "", from_step_id: a, to_step_id: b, probability: 1, condition_tag: null, label: null },
      { id: "b2000000-0000-4000-8000-0000000000a2", revision_id: "", workspace_id: "", process_id: "", from_step_id: b, to_step_id: c, probability: 1, condition_tag: null, label: null },
    ],
  });
  const d = "b1000000-0000-4000-8000-0000000000b1";
  const e = "b1000000-0000-4000-8000-0000000000b2";
  const qualifier = blockFromSteps({
    steps: [task(template, d, "AI scores the lead", 24, 0.05, "Reads the enquiry and the website, then scores fit."), task(template, e, "Check the score", 214, 0.1, null)],
    edges: [{ id: "b2000000-0000-4000-8000-0000000000b1", revision_id: "", workspace_id: "", process_id: "", from_step_id: d, to_step_id: e, probability: 1, condition_tag: null, label: null }],
  });
  return [
    row("b0000000-0000-4000-8000-000000000001", "Sales conversation", "Check the lead is a fit, then hold the discovery call.", "manual", blockFromGroup(nested, DEMO_GROUP_IDS.conversation)!),
    row("b0000000-0000-4000-8000-000000000002", "Client sign-off", "Send the summary, chase once, and record the decision.", "manual", approval),
    row("b0000000-0000-4000-8000-000000000003", "AI lead qualifier", "An AI scores each new lead, and a person checks the score before booking a call.", "ai", qualifier),
    row("b0000000-0000-4000-8000-000000000004", "Campaign set-up", "Set up the SEO and ad campaigns, then go live.", "manual", blockFromGroup(nested, DEMO_GROUP_IDS.setup)!),
  ];
}

let blocks: BlockRow[] = seed();
const listeners = new Set<() => void>();

/** The demo's blocks, as the library lists them. */
export const demoBlocks = (): BlockRow[] => blocks;

/** Save a block into the demo's library (this tab only). */
export function addDemoBlock(input: BlockInput): BlockRow {
  const now = new Date().toISOString();
  const block: BlockRow = {
    id: crypto.randomUUID(),
    workspace_id: NORTHBEAM_WORKSPACE_ID,
    name: input.name,
    description: input.description,
    type: "manual",
    steps: structuredClone(input.bundle),
    created_at: now,
    updated_at: now,
  };
  blocks = [...blocks, block];
  for (const l of listeners) l();
  return block;
}

/** The demo's blocks, kept up to date as the Editor saves more. Server rendering and hydration see the starting set. */
export function useDemoBlocks(): BlockRow[] {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
    () => blocks,
    () => INITIAL,
  );
}

const INITIAL = blocks;

const notify = () => {
  for (const l of listeners) l();
};

/** Write an edited block back (this tab only). */
export function updateDemoBlock(id: string, input: BlockInput): BlockRow | null {
  const old = blocks.find((b) => b.id === id);
  if (!old) return null;
  const next: BlockRow = { ...old, name: input.name, description: input.description, steps: structuredClone(input.bundle), updated_at: new Date().toISOString() };
  blocks = blocks.map((b) => (b.id === id ? next : b));
  notify();
  return next;
}

/** Rename a block (this tab only). */
export function renameDemoBlock(id: string, name: string): BlockRow | null {
  const old = blocks.find((b) => b.id === id);
  if (!old) return null;
  const next: BlockRow = { ...old, name, updated_at: new Date().toISOString() };
  blocks = blocks.map((b) => (b.id === id ? next : b));
  notify();
  return next;
}

/** Copy a block as "<name> (copy)" (this tab only). */
export function duplicateDemoBlock(id: string): BlockRow | null {
  const old = blocks.find((b) => b.id === id);
  if (!old) return null;
  const now = new Date().toISOString();
  const copy: BlockRow = { ...old, id: crypto.randomUUID(), name: `${old.name} (copy)`.slice(0, 200), steps: structuredClone(old.steps), created_at: now, updated_at: now };
  blocks = [...blocks, copy];
  notify();
  return copy;
}

/** Remove a block from the demo's library (this tab only). */
export function removeDemoBlock(id: string): void {
  blocks = blocks.filter((b) => b.id !== id);
  notify();
}
