// Dragging a line's middle (the Editor's grab handle): `bendEdge` is one edit with one undo, saved like any other field, and a
// moved line is layout in a draft's diff (listed and revertable, like a moved step, but not a changed value).
import { describe, expect, it } from "vitest";
import { northbeamBundle } from "@transpera-flow/db";
import { bendEdge, updateEdge } from "@/lib/editor/commands";
import { ProcessEditor } from "@/lib/editor/editor";
import { applyEdit } from "@/lib/editor/ops";
import { MemoryStore } from "@/lib/editor/store";
import { parseFieldUpdate, parseNewEdge } from "@/lib/editor/validate";
import { diffBundles } from "@/lib/drafts/diff";
import { discardChange } from "@/lib/drafts/discard";

const bend = (e: { center_dx?: number | null; center_dy?: number | null } | undefined) => ({ dx: e?.center_dx ?? null, dy: e?.center_dy ?? null });

describe("bendEdge", () => {
  it("moves a line's middle as one edit, rounded, and undo puts it back to automatic", async () => {
    const bundle = northbeamBundle();
    const memory = new MemoryStore(bundle);
    const editor = new ProcessEditor(bundle, memory);
    const edge = bundle.edges[0]!;
    expect(bend(edge)).toEqual({ dx: null, dy: null });

    const edit = bendEdge(bundle, edge.id, { x: 40.4, y: -19.6 })!;
    expect(edit.label).toMatch(/^Moved the line /);
    expect(edit.ops).toEqual([
      { kind: "update", changes: [{ table: "edges", id: edge.id, before: { center_dx: null, center_dy: null }, after: { center_dx: 40, center_dy: -20 } }] },
    ]);

    editor.run((b) => bendEdge(b, edge.id, { x: 40, y: -20 }));
    expect(editor.getState().undoLabel).toMatch(/^Moved the line /);
    await editor.settled();
    const now = () => editor.getState().bundle.edges.find((e) => e.id === edge.id);
    expect(bend(now())).toEqual({ dx: 40, dy: -20 });
    expect(bend(memory.snapshot().edges.find((e) => e.id === edge.id))).toEqual({ dx: 40, dy: -20 });

    expect(editor.undo()).toBe(true);
    expect(editor.undo()).toBe(false);
    await editor.settled();
    expect(bend(now())).toEqual({ dx: null, dy: null });
    expect(bend(memory.snapshot().edges.find((e) => e.id === edge.id))).toEqual({ dx: null, dy: null });
  });

  it("resets with null (or a move back to no offset), and changes nothing when nothing moves", () => {
    let b = northbeamBundle();
    const id = b.edges[0]!.id;
    expect(bendEdge(b, id, null)).toBeNull();
    expect(bendEdge(b, id, { x: 0.2, y: -0.3 })).toBeNull();
    b = applyEdit(b, bendEdge(b, id, { x: 30, y: 0 })!);
    expect(bendEdge(b, id, { x: 30, y: 0 })).toBeNull();
    const reset = bendEdge(b, id, null)!;
    expect(reset.label).toMatch(/^Reset the line /);
    b = applyEdit(b, reset);
    expect(bend(b.edges.find((e) => e.id === id))).toEqual({ dx: null, dy: null });
    expect(bendEdge(b, "not-an-edge", { x: 1, y: 1 })).toBeNull();
  });

  it("is accepted by the save checks: numbers or null, within the map's bounds", () => {
    expect(parseFieldUpdate("edges", { center_dx: null, center_dy: null }, { center_dx: 40, center_dy: -20 })).not.toBeNull();
    expect(parseFieldUpdate("edges", { center_dx: 40, center_dy: -20 }, { center_dx: null, center_dy: null })).not.toBeNull();
    expect(parseFieldUpdate("edges", { center_dx: null }, { center_dx: "40" })).toBeNull();
    expect(parseFieldUpdate("edges", { center_dx: null }, { center_dx: 2e6 })).toBeNull();
    const edge = northbeamBundle().edges[0]!;
    // An unbent line doesn't name the bend columns, so it saves on a database the bend migration hasn't reached yet.
    const plain = parseNewEdge(edge)!;
    expect(plain).not.toBeNull();
    expect("center_dx" in plain || "center_dy" in plain).toBe(false);
    expect(parseNewEdge({ ...edge, center_dx: 12, center_dy: 3 })).toMatchObject({ center_dx: 12, center_dy: 3 });
  });
});

describe("a moved line in a draft", () => {
  it("is listed as moved, not as a changed value, and Revert puts it back", () => {
    const live = northbeamBundle();
    const id = live.edges[0]!.id;
    const draft = applyEdit(live, bendEdge(live, id, { x: 50, y: 10 })!);
    const change = diffBundles(live, draft).edges.get(id)!;
    expect(change).toMatchObject({ kind: "changed", fields: [], moved: true });

    // With a value changed too, the value is the change and the move comes along.
    const both = applyEdit(draft, updateEdge(draft, id, { condition_tag: "vip" })!);
    expect(diffBundles(live, both).edges.get(id)).toMatchObject({ moved: true, fields: [{ field: "condition_tag" }] });

    const reverted = applyEdit(draft, discardChange(live, draft, "edges", id)!);
    expect(bend(reverted.edges.find((e) => e.id === id))).toEqual({ dx: null, dy: null });
    expect(diffBundles(live, reverted).edges.size).toBe(0);
  });
});
