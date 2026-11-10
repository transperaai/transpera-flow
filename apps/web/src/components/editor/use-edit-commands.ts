"use client";

// The Editor's commands on the selection (duplicate, copy, paste, delete, split) and the keyboard shortcuts that
// run them (undo, redo, delete, copy, paste, duplicate, select all, Escape). The map used to carry these when it was
// editable in place (issue #9); editing now lives on the Editor screen (issue #104).

import { useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { ProcessBundle } from "@transpera-flow/db";
import { NO_SELECTION, type Selection } from "@/components/process-canvas";
import type { CanvasCommands } from "@/components/node-menu";
import { PASTE_OFFSET, copySteps, deleteSelection, duplicateSteps, pasteSteps, type StepClipboard } from "@/lib/editor/commands";
import type { ProcessEditor } from "@/lib/editor/editor";
import { splitStep } from "@/lib/editor/split";

// Radix takes a closed dialog out of the page and the tour card is only there while it runs, so any match is an open one.
const DIALOG = "[role=dialog], [role=alertdialog]";

export function useEditCommands({
  editor,
  bundle,
  selected,
  setSelection,
  openProcess,
}: {
  /** Open a linked process's page, for "Open process page" on a node that links to one. */
  openProcess?: (processId: string) => void;
  editor: ProcessEditor;
  bundle: ProcessBundle;
  selected: Selection;
  setSelection: Dispatch<SetStateAction<Selection>>;
}): { commands: CanvasCommands; inspectFocus: string | null; clearInspectFocus: () => void } {
  // Copied steps, and how many times they've been pasted (each paste lands further along).
  const clipboard = useRef<{ clip: StepClipboard; pastes: number } | null>(null);
  // A step whose inspector should take focus once it shows ("Edit in the inspector").
  const [inspectFocus, setInspectFocus] = useState<string | null>(null);

  const commands = useMemo<CanvasCommands>(
    () => ({
      duplicate: (ids) => {
        let made: string[] = [];
        editor.run((b) => {
          const r = duplicateSteps(b, ids);
          made = r?.ids ?? [];
          return r?.edit ?? null;
        });
        if (made.length) setSelection({ steps: made, edges: [] });
      },
      copy: (ids) => {
        const clip = copySteps(editor.getState().bundle, ids);
        if (clip) clipboard.current = { clip, pastes: 0 };
      },
      remove: (ids) => {
        if (editor.run((b) => deleteSelection(b, ids, []))) setSelection(NO_SELECTION);
      },
      inspect: (id) => {
        setSelection({ steps: [id], edges: [] });
        setInspectFocus(id);
      },
      split: (id) => {
        let made: string[] = [];
        editor.run((b) => {
          const r = splitStep(b, id);
          made = r?.ids ?? [];
          return r?.edit ?? null;
        });
        if (made.length) setSelection({ steps: made, edges: [] });
      },
      ...(openProcess ? { openProcess } : {}),
    }),
    [editor, setSelection, openProcess],
  );

  useEffect(() => {
    const paste = () => {
      const held = clipboard.current;
      if (!held) return;
      const n = held.pastes + 1;
      let made: string[] = [];
      editor.run((b) => {
        const r = pasteSteps(b, held.clip, { x: PASTE_OFFSET * n, y: PASTE_OFFSET * n });
        made = r?.ids ?? [];
        return r?.edit ?? null;
      });
      if (!made.length) return;
      held.pastes = n;
      setSelection({ steps: made, edges: [] });
    };
    const onKey = (e: KeyboardEvent) => {
      // Someone else (a dialog, the tour, a field) already handled the key.
      if (e.defaultPrevented) return;
      const target = e.target instanceof Element ? e.target : null;
      // An open dialog (publish or discard confirm, the tour) owns the keyboard: undo must not change the map behind it.
      if (target?.closest(DIALOG) || document.querySelector(DIALOG)) return;
      // Text fields keep their own undo, copy and delete keys.
      if (target?.closest("input, textarea, select, [contenteditable='true']")) return;
      // Map keys work from the map (not its buttons or menu) or from nowhere in particular.
      const onMap = !target || target === document.body || (!!target.closest("[data-process-map]") && !target.closest("button, summary"));
      const mod = e.metaKey || e.ctrlKey;
      const key = e.key.toLowerCase();
      if (mod && key === "z") {
        e.preventDefault();
        if (e.shiftKey) editor.redo();
        else editor.undo();
      } else if (mod && key === "y") {
        e.preventDefault();
        editor.redo();
      } else if (!onMap) {
        return;
      } else if ((e.key === "Delete" || e.key === "Backspace") && !mod) {
        let { steps, edges } = selected;
        // Nothing selected: delete the step or connection that has focus.
        const focused = target?.closest(".react-flow__node, .react-flow__edge");
        const id = focused?.getAttribute("data-id");
        if (!steps.length && !edges.length && focused && id) {
          if (focused.classList.contains("react-flow__node")) steps = [id];
          else edges = [id];
        }
        if (editor.run((b) => deleteSelection(b, steps, edges))) {
          e.preventDefault();
          setSelection(NO_SELECTION);
          // What had focus is gone; keep it on the map.
          requestAnimationFrame(() => {
            if (document.activeElement === document.body) document.querySelector<HTMLElement>("[data-process-map]")?.focus();
          });
        }
      } else if (mod && key === "c" && selected.steps.length && !window.getSelection()?.toString()) {
        e.preventDefault();
        commands.copy(selected.steps);
      } else if (mod && key === "v" && clipboard.current) {
        e.preventDefault();
        paste();
      } else if (mod && key === "d" && selected.steps.length) {
        e.preventDefault();
        commands.duplicate(selected.steps);
      } else if (mod && key === "a" && target?.closest("[data-process-map]")) {
        e.preventDefault();
        setSelection({ steps: bundle.steps.map((s) => s.id), edges: [] });
      } else if (e.key === "Escape" && target?.closest("[data-process-map]")) {
        setSelection(NO_SELECTION);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editor, selected, commands, bundle.steps, setSelection]);

  return { commands, inspectFocus, clearInspectFocus: () => setInspectFocus(null) };
}
