import { describe, expect, it } from "vitest";
import { defaultCompanyPart, northbeamBundle, partOf, type ProcessBundle, type ProcessPart } from "@transpera-flow/db";
import { deleteSteps } from "@/lib/editor/commands";
import { filterLibrary, libraryEntries, placeProcesses, type LibraryProcess } from "@/lib/editor/library";
import { applyEdit, invertEdit } from "@/lib/editor/ops";
import { CARD_SIZE } from "@/lib/map/groups";

// The process library on the company map (issue #164, B12): what it lists, search, and placing several processes at once as
// linked cards that land in view without covering each other. Placing is a link: only holder steps are inserted.

function companyBundle(): ProcessBundle {
  const base = northbeamBundle();
  const parts: ProcessPart[] = [partOf(base), ...(base.otherProcesses ?? [])];
  const company = defaultCompanyPart(base.workspace.id, parts);
  return { ...base, process: company.process, revision: company.revision, steps: company.steps, edges: company.edges, retired: [], otherProcesses: parts };
}

/** The map with the named cards taken off (as the library's "Remove from the map" does), so they can be added again. */
function without(bundle: ProcessBundle, ...processIds: string[]): ProcessBundle {
  const ids = bundle.steps.filter((s) => s.child_process_id && processIds.includes(s.child_process_id)).map((s) => s.id);
  return applyEdit(bundle, deleteSteps(bundle, ids)!);
}

const overlap = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  a.x < b.x + CARD_SIZE.width && b.x < a.x + CARD_SIZE.width && a.y < b.y + CARD_SIZE.height && b.y < a.y + CARD_SIZE.height;

describe("what the library lists", () => {
  it("lists every process of the workspace, never the company map, with the ones already on the map marked", () => {
    const b = companyBundle();
    const entries = libraryEntries(b);
    expect(entries.map((e) => e.id).sort()).toEqual((b.otherProcesses ?? []).map((p) => p.process.id).sort());
    expect(entries.some((e) => e.id === b.process.id)).toBe(false);
    // The default map holds every top-level process.
    expect(entries.every((e) => e.state === "placed")).toBe(true);
  });

  it("puts what is not on the map first, then what is, each by name; a process inside another is not addable", () => {
    const b = companyBundle();
    const parts = b.otherProcesses!;
    const [a, c, d] = [parts[0]!.process.id, parts[1]!.process.id, parts[2]!.process.id];
    const nested = {
      ...b,
      otherProcesses: parts.map((p) => (p.process.id === d ? { ...p, process: { ...p.process, parent_process_id: a } } : p)),
    };
    const off = without(nested, a, c, d);
    const entries = libraryEntries(off);
    const rank = { free: 0, placed: 1, inside: 2, holds: 3 } as const;
    expect(entries.map((e) => e.state)).toEqual(entries.map((e) => e.state).sort((x, y) => rank[x] - rank[y]));
    expect(entries.filter((e) => e.state === "free").map((e) => e.id).sort()).toEqual([a, c].sort());
    const inside = entries.find((e) => e.id === d)!;
    expect(inside).toMatchObject({ state: "inside", insideName: parts[0]!.process.name });
    const free = entries.filter((e) => e.state === "free").map((e) => e.name);
    expect(free).toEqual([...free].sort((x, y) => x.localeCompare(y)));
  });

  it("searches by name, ignoring case and spacing", () => {
    const entries = libraryEntries(companyBundle());
    const first = entries[0]!;
    expect(filterLibrary(entries, "")).toHaveLength(entries.length);
    expect(filterLibrary(entries, `  ${first.name.toUpperCase()} `).map((e) => e.id)).toContain(first.id);
    expect(filterLibrary(entries, "zzzz no such process")).toEqual([]);
  });
});

describe("placing processes", () => {
  it("adds several at once as linked cards in view, none covering another or an existing card", () => {
    const b = companyBundle();
    const ids = b.otherProcesses!.map((p) => p.process.id);
    const off = without(b, ...ids);
    // Leave one card on the map, in the middle of the view, so the new ones have to go round it.
    const keep = without(b, ...ids.slice(1));
    const centre = { x: 600, y: 400 };
    const keepCard = { ...keep.steps[0]!, x: centre.x - CARD_SIZE.width / 2, y: centre.y - CARD_SIZE.height / 2 };
    const start = { ...off, steps: [keepCard], edges: [] };
    const placed = placeProcesses(start, ids.slice(1), { x: centre.x, y: centre.y, visible: { left: 0, top: 0, right: 1400, bottom: 800 } })!;
    expect(placed.ids).toHaveLength(ids.length - 1);
    const after = applyEdit(start, placed.edit);
    const cards = after.steps;
    for (let i = 0; i < cards.length; i++) {
      for (let j = i + 1; j < cards.length; j++) expect(overlap({ x: Number(cards[i]!.x), y: Number(cards[i]!.y) }, { x: Number(cards[j]!.x), y: Number(cards[j]!.y) })).toBe(false);
    }
    // In view, and each a link to its process.
    for (const s of cards.filter((c) => placed.ids.includes(c.id))) {
      expect(Number(s.x)).toBeGreaterThanOrEqual(0);
      expect(Number(s.x) + CARD_SIZE.width).toBeLessThanOrEqual(1400);
      expect(Number(s.y) + CARD_SIZE.height).toBeLessThanOrEqual(800);
      expect(s.kind).toBe("subprocess");
      expect(ids).toContain(s.child_process_id);
    }
    expect(placed.edit.label).toBe(`Added ${ids.length - 1} processes to the map`);
  });

  it("keeps clear of the ghost of a card the draft removed, which is still drawn where it is live", () => {
    const b = companyBundle();
    const target = b.otherProcesses![0]!.process;
    const removed = b.steps.find((s) => s.child_process_id === target.id)!;
    const off = without(b, target.id);
    const ghost = { x: Number(removed.x), y: Number(removed.y), width: CARD_SIZE.width, height: CARD_SIZE.height };
    // The view's centre is on the ghost's own place: the new card is put beside it, not on it.
    const centre = { x: ghost.x + ghost.width / 2, y: ghost.y + ghost.height / 2 };
    const placed = placeProcesses(off, [target.id], { x: centre.x, y: centre.y, occupied: [ghost] })!;
    const card = applyEdit(off, placed.edit).steps.find((s) => placed.ids.includes(s.id))!;
    expect(overlap({ x: Number(card.x), y: Number(card.y) }, ghost)).toBe(false);
    // Without the ghost known, it would have gone right on it.
    const naive = placeProcesses(off, [target.id], { x: centre.x, y: centre.y })!;
    const onTop = applyEdit(off, naive.edit).steps.find((s) => naive.ids.includes(s.id))!;
    expect(overlap({ x: Number(onTop.x), y: Number(onTop.y) }, ghost)).toBe(true);
  });

  it("writes only holder steps: no edge, no update, and nothing about the processes themselves", () => {
    const b = companyBundle();
    const target = b.otherProcesses![0]!.process;
    const off = without(b, target.id);
    const placed = placeProcesses(off, [target.id], { x: 300, y: 300 })!;
    expect(placed.edit.ops).toHaveLength(1);
    const op = placed.edit.ops[0]!;
    expect(op.kind).toBe("insert");
    if (op.kind !== "insert") return;
    expect(op.edges).toEqual([]);
    expect(op.steps).toHaveLength(1);
    expect(op.steps[0]).toMatchObject({ kind: "subprocess", child_process_id: target.id, name: target.name, work_hours: 0, wait_hours: 0, role_id: null, person_id: null });
    const after = applyEdit(off, placed.edit);
    expect(after.otherProcesses).toEqual(off.otherProcesses);
  });

  it("refuses a process that is already on the map, the company map itself, and ones that are not in the library", () => {
    const b = companyBundle();
    const [first, second] = b.otherProcesses!.map((p) => p.process.id);
    // Already placed: nothing to do, so the map can't hold it twice.
    expect(placeProcesses(b, [first!], { x: 0, y: 0 })).toBeNull();
    expect(placeProcesses(b, [b.process.id], { x: 0, y: 0 })).toBeNull();
    expect(placeProcesses(b, ["00000000-0000-4000-8000-00000000dead"], { x: 0, y: 0 })).toBeNull();
    // Picked twice, or with one already placed: each free process once.
    const off = without(b, second!);
    const placed = placeProcesses(off, [first!, second!, second!], { x: 0, y: 0 })!;
    expect(placed.ids).toHaveLength(1);
    expect(applyEdit(off, placed.edit).steps.filter((s) => s.child_process_id === second)).toHaveLength(1);
  });

  it("works with no view to go by (below what is there)", () => {
    const b = companyBundle();
    const ids = b.otherProcesses!.slice(0, 2).map((p) => p.process.id);
    const off = without(b, ...ids);
    const placed = placeProcesses(off, ids)!;
    const after = applyEdit(off, placed.edit);
    const added = after.steps.filter((s) => placed.ids.includes(s.id));
    expect(added).toHaveLength(2);
    expect(overlap({ x: Number(added[0]!.x), y: Number(added[0]!.y) }, { x: Number(added[1]!.x), y: Number(added[1]!.y) })).toBe(false);
  });
});

// B12 part 2: the same library in an ordinary process's editor. The Editor hands it the workspace's processes with where each
// sits now (the process whose LIVE version holds it, from `process_placements`).
describe("the library in an ordinary process's editor", () => {
  const ordinary = () => northbeamBundle();
  const lib = (b: ProcessBundle, holders: Record<string, LibraryProcess["holder"]> = {}): LibraryProcess[] => [
    { id: b.process.id, name: b.process.name, kind: b.process.kind, live: true, holder: holders[b.process.id] ?? null },
    ...(b.otherProcesses ?? []).map((p) => ({ id: p.process.id, name: p.process.name, kind: p.process.kind, live: true, holder: holders[p.process.id] ?? null })),
    { id: "00000000-0000-4000-8000-0000000000a1", name: "Onboarding", kind: "servicing" as const, live: true, holder: holders["00000000-0000-4000-8000-0000000000a1"] ?? null },
    { id: "00000000-0000-4000-8000-0000000000a2", name: "Offboarding", kind: "servicing" as const, live: false, holder: holders["00000000-0000-4000-8000-0000000000a2"] ?? null },
  ];
  const company = { id: "00000000-0000-4000-8000-00000000c0c0", name: "Company map", company: true };

  it("lists what sits nowhere first, then by where each sits, greyed with a plain reason; never the process itself", () => {
    const b = ordinary();
    const other = b.otherProcesses![0]!.process;
    const entries = libraryEntries(b, lib(b, { [other.id]: company, [b.process.id]: company }));
    expect(entries.some((e) => e.id === b.process.id)).toBe(false);
    const free = entries.filter((e) => e.state === "free").map((e) => e.name);
    expect(free).toEqual(expect.arrayContaining(["Offboarding", "Onboarding"]));
    expect(free).toEqual([...free].sort((x, y) => x.localeCompare(y)));
    expect(entries.find((e) => e.id === other.id)).toMatchObject({ state: "inside", insideName: "the company map" });
    expect(entries.findIndex((e) => e.state === "inside")).toBeGreaterThan(entries.findIndex((e) => e.state === "free"));
    // A process inside another ordinary process says which.
    const inOnboarding = libraryEntries(b, lib(b, { [other.id]: { id: "00000000-0000-4000-8000-0000000000a1", name: "Onboarding", company: false } }));
    expect(inOnboarding.find((e) => e.id === other.id)).toMatchObject({ state: "inside", insideName: "Onboarding" });
  });

  it("greys out a process that holds this one (at any depth), so nothing ends up inside itself", () => {
    const b = ordinary();
    const onboarding = { id: "00000000-0000-4000-8000-0000000000a1", name: "Onboarding", company: false };
    const offboarding = { id: "00000000-0000-4000-8000-0000000000a2", name: "Offboarding", company: false };
    // This process sits inside Onboarding, which sits inside Offboarding.
    const entries = libraryEntries(b, lib(b, { [b.process.id]: onboarding, [onboarding.id]: offboarding }));
    expect(entries.find((e) => e.id === offboarding.id)).toMatchObject({ state: "holds" });
    expect(entries.find((e) => e.id === onboarding.id)).toMatchObject({ state: "inside", insideName: "Offboarding" });
    expect(placeProcesses(b, [offboarding.id], { x: 0, y: 0 }, lib(b, { [b.process.id]: onboarding, [onboarding.id]: offboarding }))).toBeNull();
  });

  it("adds several processes in one go as links in view, and undo and redo take them out and put them back", () => {
    const b = ordinary();
    const list = lib(b);
    const ids = ["00000000-0000-4000-8000-0000000000a1", "00000000-0000-4000-8000-0000000000a2"];
    const placed = placeProcesses(b, ids, { x: 600, y: 400, visible: { left: 0, top: 0, right: 1400, bottom: 800 } }, list)!;
    expect(placed.ids).toHaveLength(2);
    const after = applyEdit(b, placed.edit);
    const added = after.steps.filter((s) => placed.ids.includes(s.id));
    expect(added.map((s) => [s.kind, s.child_process_id, s.name])).toEqual([["subprocess", ids[0], "Onboarding"], ["subprocess", ids[1], "Offboarding"]]);
    expect(overlap({ x: Number(added[0]!.x), y: Number(added[0]!.y) }, { x: Number(added[1]!.x), y: Number(added[1]!.y) })).toBe(false);
    // Only steps are inserted: the other processes and this one's existing steps and edges are untouched.
    expect(after.otherProcesses).toEqual(b.otherProcesses);
    expect(after.edges).toEqual(b.edges);
    expect(after.steps.filter((s) => !placed.ids.includes(s.id))).toEqual(b.steps);
    // Now they are here: listed as such, not addable again.
    expect(libraryEntries(after, list).filter((e) => ids.includes(e.id)).map((e) => e.state)).toEqual(["placed", "placed"]);
    expect(placeProcesses(after, ids, { x: 0, y: 0 }, list)).toBeNull();
    // Undo takes both out; redo puts them back.
    const undone = applyEdit(after, invertEdit(placed.edit));
    expect(undone.steps).toEqual(b.steps);
    expect(applyEdit(undone, placed.edit).steps).toEqual(after.steps);
  });

  it("removing a link deletes the holder step only, and the process is free again", () => {
    const b = ordinary();
    const list = lib(b);
    const id = "00000000-0000-4000-8000-0000000000a1";
    const after = applyEdit(b, placeProcesses(b, [id], { x: 0, y: 0 }, list)!.edit);
    const holder = after.steps.find((s) => s.child_process_id === id)!;
    const removal = deleteSteps(after, [holder.id])!;
    expect(removal.ops.map((op) => op.kind)).toEqual(["remove"]);
    const back = applyEdit(after, removal);
    expect(back.steps).toEqual(b.steps);
    expect(libraryEntries(back, list).find((e) => e.id === id)?.state).toBe("free");
    // A process held by this one's LIVE version, taken out in the draft, is free here again.
    const heldHere = libraryEntries(b, lib(b, { [id]: { id: b.process.id, name: b.process.name, company: false } }));
    expect(heldHere.find((e) => e.id === id)?.state).toBe("free");
  });
});
