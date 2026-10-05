// The process library, in every editor (issue #164, B12). Pure, like ./commands.ts: what the library lists for the process (or
// company map) being edited, and the edit that places several processes in it at once.
//
// Placing is a LINK. The edit inserts one `subprocess` holder step per process into the draft being edited and writes nothing
// else: not the process's row, versions, steps or edges (the process page is where a process is edited). Taking it out again is
// deleting the holder (./commands.ts `deleteSteps`); the process is untouched and goes back to "Not on any map".
//
// Where a process sits comes from the LIVE versions (ADR 0014, B12): the process whose live version holds it. A process sits in
// one place only, so one that sits elsewhere is listed greyed with where; the database refuses a second place on publish too.

import type { ProcessBundle, ProcessRow, StepRow } from "@transpera-flow/db";
import { CARD_SIZE } from "@/lib/map/groups";
import { newStepRow } from "./commands";
import { nearestFreeSpot, type ViewHint } from "./groups";
import type { Edit } from "./ops";

/** A process of the workspace as the library knows it: where it sits now (its live holder), if anywhere. */
export interface LibraryProcess {
  id: string;
  name: string;
  kind: ProcessRow["kind"];
  /** Published at least once (a card for one that is not has nothing to show yet). */
  live: boolean;
  /** The process whose live version holds it, or null when none does. */
  holder: { id: string; name: string; company: boolean } | null;
}

/** A template the library can make a new process from (create_from_template's list). */
export interface LibraryTemplate {
  id: string;
  name: string;
  kind: ProcessRow["kind"];
  description: string;
}

export interface LibraryEntry {
  id: string;
  name: string;
  kind: ProcessRow["kind"];
  live: boolean;
  /**
   * `free`: not on any map, can be added. `placed`: already linked in the draft being edited (a process sits in one place).
   * `inside`: another process (or the company map) holds it, so it can't be added here too. `holds`: it holds the process being
   * edited, at some depth, so placing it here would put a process inside itself.
   */
  state: "free" | "placed" | "inside" | "holds";
  /** For `inside`: where it sits ("the company map", or the process's name). */
  insideName: string | null;
}

/**
 * The library's view of the workspace's processes when the editor was not handed one: the processes the bundle carries, each
 * held by its (derived) parent, if any. The Editor passes the real list (`LibraryProcess[]`, from the live links).
 */
export function processesOfBundle(bundle: ProcessBundle): LibraryProcess[] {
  const parts = bundle.otherProcesses ?? [];
  const names = new Map(parts.map((p) => [p.process.id, p.process.name]));
  return parts
    .filter((p) => p.process.is_company !== true)
    .map((p) => ({
      id: p.process.id,
      name: p.process.name,
      kind: p.process.kind,
      live: true,
      holder: p.process.parent_process_id ? { id: p.process.parent_process_id, name: names.get(p.process.parent_process_id) ?? "another process", company: false } : null,
    }));
}

/**
 * What the library lists for the draft being edited: those not on any map first, then the ones already here, then those that
 * sit somewhere else, then those that hold this process; each by name. The process being edited and the company map are never
 * listed.
 */
export function libraryEntries(bundle: ProcessBundle, processes: readonly LibraryProcess[] = processesOfBundle(bundle)): LibraryEntry[] {
  const self = bundle.process.id;
  const here = new Set(bundle.steps.map((s) => s.child_process_id).filter((id): id is string => !!id));
  // The processes that hold this one, at any depth (through live versions): placing one of them here would be a loop.
  const byId = new Map(processes.map((p) => [p.id, p]));
  const above = new Set<string>();
  for (let at = byId.get(self)?.holder; at && !at.company && !above.has(at.id) && at.id !== self; at = byId.get(at.id)?.holder) above.add(at.id);
  const entries = processes
    .filter((p) => p.id !== self)
    .map<LibraryEntry>((p) => {
      // Held by this process's live version: if the draft still has it, it is here; if the draft took it out, it is free again.
      const elsewhere = p.holder && p.holder.id !== self ? p.holder : null;
      const state = here.has(p.id) ? "placed" : elsewhere ? "inside" : above.has(p.id) ? "holds" : "free";
      return {
        id: p.id,
        name: p.name,
        kind: p.kind,
        live: p.live,
        state,
        insideName: state === "inside" && elsewhere ? (elsewhere.company ? "the company map" : elsewhere.name) : null,
      };
    });
  const rank = { free: 0, placed: 1, inside: 2, holds: 3 } as const;
  return entries.sort((a, b) => rank[a.state] - rank[b.state] || (a.insideName ?? "").localeCompare(b.insideName ?? "") || a.name.localeCompare(b.name));
}

/** The entries whose name contains what was typed (ignoring case and extra spaces); everything for an empty search. */
export function filterLibrary<T extends { name: string }>(entries: readonly T[], query: string): T[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [...entries];
  return entries.filter((e) => words.every((w) => e.name.toLowerCase().includes(w)));
}

/**
 * Place the picked processes in the draft as linked holders. Each lands at the centre of what the person is looking at, or the
 * nearest free place to it (the QA wave 1 rule for new steps), and the next one takes the next free place, so none covers
 * another. Processes that can't be placed (not in the library, already here, sitting elsewhere, or holding this process) are left
 * out. Returns null when there is nothing to place.
 */
export function placeProcesses(
  bundle: ProcessBundle,
  ids: readonly string[],
  view?: ViewHint | null,
  processes: readonly LibraryProcess[] = processesOfBundle(bundle),
): { edit: Edit; ids: string[] } | null {
  const free = new Map(libraryEntries(bundle, processes).filter((e) => e.state === "free").map((e) => [e.id, e]));
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
