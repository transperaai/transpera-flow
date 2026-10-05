// The process library on the company map (issue #164, B12). Pure, like ./commands.ts: what the library lists for the map being
// edited, and the edit that places several processes on it at once.
//
// Placing is a LINK. The edit inserts one `subprocess` holder step per process into the map's draft and writes nothing else:
// not the process's row, versions, steps or edges (the process page is where a process is edited). Taking a card off the map is
// deleting the card (./commands.ts `deleteSteps`); the process is untouched and goes back to "Not on the map".

import type { ProcessBundle, ProcessRow, StepRow } from "@transpera-flow/db";
import { CARD_SIZE } from "@/lib/map/groups";
import { newStepRow } from "./commands";
import { nearestFreeSpot, type ViewHint } from "./groups";
import type { Edit } from "./ops";

export interface LibraryEntry {
  id: string;
  name: string;
  kind: ProcessRow["kind"];
  /** `free`: not on the map, can be added. `placed`: already a card on this map (a process is on it once). `inside`: sits inside another process, which holds it, so it can't be on the map too. */
  state: "free" | "placed" | "inside";
  /** For `inside`: the process that holds it. */
  insideName: string | null;
}

/**
 * This workspace's processes as the library lists them for the company map being edited: those not on the map first, then those
 * already on it, each by name. The company map itself is never listed (it is not among a workspace's processes), and a process
 * with no live version has nothing to draw, so it is not listed either.
 */
export function libraryEntries(bundle: ProcessBundle): LibraryEntry[] {
  const parts = bundle.otherProcesses ?? [];
  const placed = new Set(bundle.steps.map((s) => s.child_process_id).filter((id): id is string => !!id));
  const names = new Map(parts.map((p) => [p.process.id, p.process.name]));
  const entries = parts
    .filter((p) => p.process.is_company !== true && p.process.id !== bundle.process.id)
    .map<LibraryEntry>((p) => ({
      id: p.process.id,
      name: p.process.name,
      kind: p.process.kind,
      state: placed.has(p.process.id) ? "placed" : p.process.parent_process_id ? "inside" : "free",
      insideName: p.process.parent_process_id ? (names.get(p.process.parent_process_id) ?? null) : null,
    }));
  const rank = { free: 0, placed: 1, inside: 2 } as const;
  return entries.sort((a, b) => rank[a.state] - rank[b.state] || a.name.localeCompare(b.name));
}

/** The entries whose name contains what was typed (ignoring case and extra spaces); everything for an empty search. */
export function filterLibrary(entries: readonly LibraryEntry[], query: string): LibraryEntry[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [...entries];
  return entries.filter((e) => words.every((w) => e.name.toLowerCase().includes(w)));
}

/**
 * Place the picked processes on the map as linked cards. Each card lands at the centre of what the person is looking at, or the
 * nearest free place to it (the QA wave 1 rule for new steps), and the next one takes the next free place, so no card covers
 * another. Processes that can't be placed (not in the library, already on the map, or inside another process) are left out.
 * Returns null when there is nothing to place.
 */
export function placeProcesses(bundle: ProcessBundle, ids: readonly string[], view?: ViewHint | null): { edit: Edit; ids: string[] } | null {
  const free = new Map(libraryEntries(bundle).filter((e) => e.state === "free").map((e) => [e.id, e]));
  const wanted = [...new Set(ids)].map((id) => free.get(id)).filter((e): e is LibraryEntry => !!e);
  if (!wanted.length) return null;
  const cards: StepRow[] = [];
  for (const entry of wanted) {
    // Each card is placed with the earlier ones in view, so they do not overlap.
    const here = { ...bundle, steps: [...bundle.steps, ...cards] };
    const { x, y } = view ? nearestFreeSpot(here, view, CARD_SIZE) : below(here);
    cards.push({
      ...newStepRow(bundle, "task", null, x, y),
      name: entry.name,
      kind: "subprocess",
      work_hours: 0,
      wait_hours: 0,
      child_process_id: entry.id,
    });
  }
  const label = cards.length === 1 ? `Added ${cards[0]!.name} to the map` : `Added ${cards.length} processes to the map`;
  return { edit: { label, ops: [{ kind: "insert", steps: cards, edges: [] }] }, ids: cards.map((c) => c.id) };
}

/** With no view to go by (no canvas yet): below everything at the top level. */
function below(bundle: ProcessBundle): { x: number; y: number } {
  const top = bundle.steps.filter((s) => (s.parent_step_id ?? null) === null);
  return { x: 0, y: top.length ? Math.max(...top.map((s) => Number(s.y))) + CARD_SIZE.height + 40 : 0 };
}
