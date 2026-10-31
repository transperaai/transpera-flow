"use client";

// The Editor's side of the block library (issue #116): the blocks to list, saving a group (or the whole map, in block mode)
// as a block, and putting a block into the map after the selection or in place of it.

import { useCallback, useState, type Dispatch, type SetStateAction } from "react";
import type { BlockRow, ProcessBundle } from "@transpera-flow/db";
import { createBlock } from "@/app/w/[slug]/block-actions";
import type { Selection } from "@/components/process-canvas";
import { blockFromGroup, insertBlock, readBlock, replaceProblem, replaceWithBlock } from "@/lib/blocks/blocks";
import { addDemoBlock, useDemoBlocks } from "@/lib/blocks/demo";
import type { BlockInput, SaveBlockResult } from "@/lib/blocks/save";
import type { ProcessEditor } from "@/lib/editor/editor";

export interface BlockTools {
  /** The library, as the Editor lists it. */
  library: BlockRow[];
  /** What the last action did or couldn't do, in plain English: saving shows beside the group, placing in the left column. */
  note: { kind: "save" | "place"; tone: "ok" | "problem"; text: string } | null;
  /** Save a block to the library. */
  save: (input: BlockInput) => Promise<SaveBlockResult>;
  /** Save a group of the map as a block, named after the group. */
  saveGroup: (groupId: string) => Promise<void>;
  /** Put a block in after the selection. */
  insert: (block: BlockRow) => void;
  /** Put a block in place of the selected step or group. */
  replace: (block: BlockRow) => void;
  /** Why Replace selected can't be used now, or null. */
  replaceWhy: string | null;
}

export function useBlockTools({
  mode,
  workspaceId,
  blocks,
  bundle,
  editor,
  selected,
  setSelection,
  processName,
}: {
  mode: "live" | "demo";
  workspaceId: string;
  /** The workspace's blocks as loaded with the page (the demo keeps its own). */
  blocks: BlockRow[];
  bundle: ProcessBundle;
  editor: ProcessEditor;
  selected: Selection;
  setSelection: Dispatch<SetStateAction<Selection>>;
  processName: string;
}): BlockTools {
  const demo = useDemoBlocks();
  const [added, setAdded] = useState<BlockRow[]>([]);
  const [note, setNote] = useState<BlockTools["note"]>(null);
  const library = mode === "demo" ? demo : [...blocks, ...added.filter((a) => !blocks.some((b) => b.id === a.id))];
  const only = selected.steps.length === 1 && !selected.edges.length ? selected.steps[0]! : null;

  const save = useCallback(
    async (input: BlockInput): Promise<SaveBlockResult> => {
      if (mode === "demo") return { status: "ok", block: addDemoBlock(input) };
      const result = await createBlock(workspaceId, input);
      if (result.status === "ok") setAdded((a) => [...a, result.block]);
      return result;
    },
    [mode, workspaceId],
  );

  const saveGroup = useCallback(
    async (groupId: string) => {
      const group = bundle.steps.find((s) => s.id === groupId);
      const bundleOf = blockFromGroup(bundle, groupId);
      if (!group || !bundleOf) return setNote({ kind: "save", tone: "problem", text: "Select a group to save it as a block." });
      if (!bundleOf.steps.length) return setNote({ kind: "save", tone: "problem", text: "Put at least one step in the group first." });
      const result = await save({ name: group.name, description: `Saved from ${processName}.`, bundle: bundleOf });
      setNote(result.status === "ok" ? { kind: "save", tone: "ok", text: `Saved “${group.name}” to the block library.` } : { kind: "save", tone: "problem", text: result.message });
    },
    [bundle, processName, save],
  );

  const insert = (block: BlockRow) => {
    let id: string | null = null;
    let said: string | undefined;
    const ran = editor.run((b) => {
      const made = insertBlock(b, only, readBlock(block.steps), block.name, block.id);
      id = made?.id ?? null;
      said = made?.note;
      return made?.edit ?? null;
    });
    if (!ran || !id) return setNote({ kind: "place", tone: "problem", text: `${block.name} has no steps to insert.` });
    setNote({ kind: "place", tone: said ? "problem" : "ok", text: said ?? `Inserted ${block.name}.` });
    setSelection({ steps: [id], edges: [] });
  };

  const replaceWhy = replaceProblem(bundle, only);
  const replace = (block: BlockRow) => {
    if (!only || replaceWhy) return setNote({ kind: "place", tone: "problem", text: replaceWhy ?? "Select the step or group the block should replace." });
    let id: string | null = null;
    let said: string | undefined;
    const ran = editor.run((b) => {
      const made = replaceWithBlock(b, only, readBlock(block.steps), block.name, block.id);
      id = made?.id ?? null;
      said = made?.note;
      return made?.edit ?? null;
    });
    if (!ran || !id) return setNote({ kind: "place", tone: "problem", text: `${block.name} has no steps to put in.` });
    setNote({ kind: "place", tone: said ? "problem" : "ok", text: said ?? `Replaced the selection with ${block.name}.` });
    setSelection({ steps: [id], edges: [] });
  };

  return { library, note, save, saveGroup, insert, replace, replaceWhy };
}
