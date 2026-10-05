"use client";

// The Editor's left column (issue #104): the step palette (adds after the selected step, inside its group if it is in
// one), grouping, and the block library (issue #116): each saved block with its step count, to insert after the selection
// or to put in place of the selected step or group.

import { useState, type Dispatch, type SetStateAction } from "react";
import { isGroup, type ProcessBundle } from "@transpera-flow/db";
import { Help } from "@/components/help";
import { Button } from "@/components/ui/button";
import type { Selection } from "@/components/process-canvas";
import type { ProcessEditor } from "@/lib/editor/editor";
import { blockStepCount, readBlock } from "@/lib/blocks/blocks";
import { PLACED_REMOVE_NOTE } from "@/lib/editor/commands";
import { addAfter, groupProblem, groupSteps, ungroup, type PaletteKind, type ViewRef } from "@/lib/editor/groups";
import { Badge } from "@/components/ui/badge";
import type { BlockTools } from "./use-blocks";

const PALETTE: { kind: PaletteKind; label: string }[] = [
  { kind: "task", label: "+ Step" },
  { kind: "decision", label: "+ Decision" },
  { kind: "wait", label: "+ Wait" },
  { kind: "group", label: "+ Group" },
];

export function Palette({
  bundle,
  editor,
  selected,
  setSelection,
  blocks,
  company = false,
  viewRef,
}: {
  bundle: ProcessBundle;
  editor: ProcessEditor;
  selected: Selection;
  setSelection: Dispatch<SetStateAction<Selection>>;
  /** The block library as the Editor uses it. */
  blocks: BlockTools;
  /** The company map (B11): cards are processes placed by link, so there are no steps or blocks to add, and none to remove. */
  company?: boolean;
  /** Where the map is looking (see ProcessCanvas): new steps appear there, so they are not off screen. */
  viewRef?: ViewRef;
}) {
  const only = selected.steps.length === 1 ? bundle.steps.find((s) => s.id === selected.steps[0]) : undefined;
  // What the last add left for the person to do ("connect the new step yourself").
  const [note, setNote] = useState<string | null>(null);
  const add = (kind: PaletteKind) => {
    let id: string | null = null;
    let said: string | null = null;
    editor.run((b) => {
      const made = addAfter(b, only?.id ?? null, kind, viewRef?.current?.() ?? null);
      id = made.id;
      said = made.note ?? null;
      return made.edit;
    });
    setNote(said);
    if (id) setSelection({ steps: [id], edges: [] });
  };
  const groupWhy = groupProblem(bundle, selected.steps);
  const group = () => {
    let id: string | null = null;
    editor.run((b) => {
      const made = groupSteps(b, selected.steps);
      id = made?.id ?? null;
      return made?.edit ?? null;
    });
    if (id) setSelection({ steps: [id], edges: [] });
  };
  const ungroupWhy = only && isGroup(only) ? null : "Select a group to take its steps back out.";
  const dissolve = () => {
    if (!only) return;
    // Its steps stay where they are, so keep the first of them selected.
    const first = bundle.steps.find((s) => s.parent_step_id === only.id);
    if (editor.run((b) => ungroup(b, only.id))) setSelection({ steps: first ? [first.id] : [], edges: [] });
  };

  return (
    <>
      {company && (
        <section aria-label="The company map" className="flex flex-col gap-2">
          <h2 className="flex items-center text-[11px] font-semibold tracking-wider text-fg-2 uppercase">
            The company map
            <Help
              label="The company map"
              description="Each card is a process, placed here as a link: moving it or joining it to another changes only this map, never the process. Draw a line from one card's right edge to another's left edge to show a handoff, then click the line to give it a label."
              example="Draw a line from “Sales” to “Onboarding” and label it “Signed contract”."
            />
          </h2>
          <p className="text-xs text-muted-foreground">Drag cards to move them. Draw a handoff line from a card&apos;s right edge to another card, then click the line to label it.</p>
          <p role="note" data-placed-note className="rounded-token border border-line bg-panel-2 px-2 py-1.5 text-xs text-fg-2">
            {PLACED_REMOVE_NOTE}
          </p>
        </section>
      )}
      {!company && (
      <section aria-label="Add to the process" className="flex flex-col gap-2">
        <h2 className="flex items-center text-[11px] font-semibold tracking-wider text-fg-2 uppercase">
          Add
          <Help
            label="Add"
            description="Adds a new step, decision, wait or group in the middle of what you are looking at, joined in after the step you have selected. Nothing selected adds it unconnected."
            example="Select “Discovery call”, press + Wait, and a waiting step appears in view, joined in after it."
          />
        </h2>
        <div className="grid grid-cols-2 gap-1.5">
          {PALETTE.map(({ kind, label }) => (
            <Button key={kind} type="button" variant="outline" size="sm" onClick={() => add(kind)} className="border-dashed hover:border-edit">
              {label}
            </Button>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">
          {only
            ? `Adds after ${only.name}.`
            : selected.steps.length > 1
              ? "Select just one step to add after it. With several selected, the new one is unconnected."
              : "Select a step to add after it, or the new one is unconnected."}
        </p>
        {note && (
          <p role="status" className="rounded-token border border-warn bg-warn-soft px-2 py-1 text-xs">
            {note}
          </p>
        )}
      </section>
      )}

      <section aria-label="Groups" className="flex flex-col gap-2">
        <h2 className="flex items-center text-[11px] font-semibold tracking-wider text-fg-2 uppercase">
          Groups
          <Help
            label="Groups"
            description="A group is a box that holds several steps so a big process stays readable. The numbers are the same whether it is open or closed."
            example="Put “Qualify lead” and “Discovery call” in one group called “Sales conversation”."
          />
        </h2>
        <Button type="button" variant="outline" size="sm" disabled={!!groupWhy} title={groupWhy ?? undefined} onClick={group}>
          Group selected steps
        </Button>
        <Button type="button" variant="outline" size="sm" disabled={!!ungroupWhy} title={ungroupWhy ?? undefined} onClick={dissolve}>
          Ungroup
        </Button>
        <p className="text-xs text-muted-foreground">
          {groupWhy && selected.steps.length ? groupWhy : "Shift-click or drag a box on the map to select several steps."}
        </p>
      </section>

      {!company && (
      <section aria-label="Blocks" className="flex flex-col gap-2">
        <h2 className="flex items-center text-[11px] font-semibold tracking-wider text-fg-2 uppercase">
          Blocks
          <Help
            label="Blocks"
            description="A block is a saved group of steps you can drop into any process, such as a standard approval or an AI check."
            example="Save your “Client sign-off” group once, then insert it into every onboarding process."
          />
        </h2>
        <p className="text-xs text-muted-foreground">
          Each block has <strong className="font-semibold text-fg-2">Insert</strong>
          <Help
            label="Insert"
            description="Adds a copy of the block's steps right after the step you have selected, joined in, as a new group named after the block. The new steps show as added."
            example="Select “Discovery call”, press Insert on “Client sign-off”, and its three steps appear after it."
          />{" "}
          and <strong className="font-semibold text-fg-2">Replace selected</strong>
          <Help
            label="Replace selected"
            description="Swaps the step or group you have selected for a copy of the block. What led into the selection leads into the block, and what led out of it leads out of the block."
            example="Select a hand-written “Chase client” step and replace it with the “Client sign-off” block."
          />
          .
        </p>
        {blocks.library.length === 0 ? (
          <p className="text-xs text-muted-foreground">No blocks saved yet. Select a group and press “Save this group as a block” on the right.</p>
        ) : (
          <ul className="flex flex-col gap-2" aria-label="Saved blocks">
            {blocks.library.map((b) => {
              const steps = blockStepCount(readBlock(b.steps));
              return (
                <li key={b.id} data-block={b.id} className="flex flex-col gap-1.5 rounded-token border border-line bg-bg px-2.5 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <b className="min-w-0 truncate text-xs">{b.name}</b>
                    <Badge variant={b.type === "ai" ? "default" : "outline"}>{b.type === "ai" ? "AI" : "By hand"}</Badge>
                  </div>
                  <span className="text-xs text-muted-foreground">
                    {steps} {steps === 1 ? "step" : "steps"}
                  </span>
                  <div className="flex gap-1.5">
                    <Button type="button" variant="outline" size="xs" disabled={!!blocks.replaceWhy} title={blocks.replaceWhy ?? undefined} onClick={() => blocks.replace(b)}>
                      Replace selected
                    </Button>
                    <Button type="button" variant="outline" size="xs" onClick={() => blocks.insert(b)}>
                      Insert
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        {blocks.note?.kind === "place" && (
          <p role="status" className={`rounded-token border px-2 py-1 text-xs ${blocks.note.tone === "ok" ? "border-good bg-good-soft" : "border-warn bg-warn-soft"}`}>
            {blocks.note.text}
          </p>
        )}
      </section>
      )}
    </>
  );
}
