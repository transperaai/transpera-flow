// The process map on a bare page, for the browser tests in ../map-browser.test.ts. Bundled by esbuild and
// driven through `window.mountMap` and `window.mapApi`; nothing here ships.

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { defaultCompanyPart, northbeamBundle, northbeamStepIds, partOf, type ProcessBundle, type ProcessPart } from "@transpera-flow/db";
import { NO_SELECTION, ProcessCanvas, type Selection } from "@/components/process-canvas";
import { Palette } from "@/components/editor/palette";
import type { BlockTools } from "@/components/editor/use-blocks";
import { DEMO_GROUP_IDS, withDemoGroups } from "@/lib/demo/nested";
import { addStep } from "@/lib/editor/commands";
import type { ViewHint } from "@/lib/editor/groups";
import { ProcessEditor } from "@/lib/editor/editor";
import { MemoryStore } from "@/lib/editor/store";
import { demoBundle } from "@/lib/sources/demo";

export interface HarnessOptions {
  editable: boolean;
  nested: boolean;
  /** The open groups live here and are handed to the map (`expanded`), as two maps sharing them would. */
  controlled: boolean;
  highlight: string[] | null;
  /** The company map (B11) of Northbeam, as the Editor draws it: process cards joined by handoff lines. */
  company?: boolean;
  /** The Editor's palette beside the map (as the Editor lays it out), whose buttons add steps where the map is looking. */
  palette?: boolean;
  /** A read-only map in a flex column as wide as the page, as the Overview's card holds it (the default is a plain 1300px block). */
  card?: boolean;
}

declare global {
  interface Window {
    mountMap: (options: HarnessOptions) => void;
    mapApi: {
      setHighlight: (ids: string[] | null) => void;
      setOpen: (ids: string[]) => void;
      getOpen: () => string[];
      addStep: () => void;
      /** The editor's connections, by the names of the cards they join, with their labels and shares. */
      getEdges: () => { from: string; to: string; label: string | null; probability: number }[];
      getSteps: () => string[];
    };
    mapIds: typeof northbeamStepIds;
    groupIds: typeof DEMO_GROUP_IDS;
  }
}

const never = () => () => undefined;

/** The block library is not under test: an empty one. */
const NO_BLOCKS: BlockTools = {
  library: [],
  note: null,
  save: async () => ({ ok: false, error: "not in this harness" }) as never,
  saveGroup: async () => undefined,
  insert: () => undefined,
  replace: () => undefined,
  replaceWhy: null,
};

/** Northbeam's company map as the Editor holds it: the stored map's cards and lines, with the processes they link to. */
function companyBundle(): ProcessBundle {
  const base = northbeamBundle();
  const parts: ProcessPart[] = [partOf(base), ...(base.otherProcesses ?? [])];
  const company = defaultCompanyPart(base.workspace.id, parts);
  return { ...base, process: company.process, revision: company.revision, steps: company.steps, edges: company.edges, retired: [], otherProcesses: parts };
}

function Harness({ options }: { options: HarnessOptions }) {
  const base = useMemo(() => (options.company ? companyBundle() : options.nested ? withDemoGroups(demoBundle()) : demoBundle()), [options.nested, options.company]);
  const editor = useMemo(() => (options.editable ? new ProcessEditor(base, new MemoryStore(base)) : null), [base, options.editable]);
  const state = useSyncExternalStore(editor ? editor.subscribe : never, editor ? editor.getState : () => null, () => null);
  const [selection, setSelection] = useState<Selection>(NO_SELECTION);
  const viewRef = useRef<(() => ViewHint | null) | null>(null);
  const [highlight, setHighlight] = useState(options.highlight);
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    window.mapApi = {
      setHighlight,
      setOpen: (ids) => setOpen(new Set(ids)),
      getOpen: () => [...open],
      addStep: () => editor?.run((b) => addStep(b, { kind: "task", x: 3200, y: 900 }).edit),
      getEdges: () => {
        const b = editor?.getState().bundle ?? base;
        const name = (id: string) => b.steps.find((s) => s.id === id)?.name ?? id;
        return b.edges.map((e) => ({ from: name(e.from_step_id), to: name(e.to_step_id), label: e.label, probability: Number(e.probability) }));
      },
      getSteps: () => (editor?.getState().bundle ?? base).steps.map((s) => s.name),
    };
  }, [open, editor, base]);
  return (
    // Where the app puts the map: an editor's map fills a flex panel; a read-only one sits in a block, as wide as the page.
    // (In a bare flex row a read-only map shrinks to its toolbar, and the "drag the map" hint it adds after framing widens
    // that toolbar, so the panel resizes and the map refits at a time that depends on load: the flake in #99's test.)
    <div style={options.editable || options.palette ? { width: 1300, height: 560, display: "flex" } : options.card ? { width: "100%", display: "flex", flexDirection: "column" } : { width: 1300 }}>
      {options.palette && editor && (
        <aside style={{ width: 220, padding: 8 }}>
          <Palette bundle={state?.bundle ?? base} editor={editor} selected={selection} setSelection={setSelection} blocks={NO_BLOCKS} viewRef={viewRef} />
        </aside>
      )}
      <ProcessCanvas
        bundle={state?.bundle ?? base}
        editor={editor}
        editorState={state}
        selection={selection}
        onSelectionChange={setSelection}
        highlight={highlight}
        expanded={options.controlled ? open : undefined}
        onExpandedChange={options.controlled ? setOpen : undefined}
        showPlayback={false}
        handoffs={options.company}
        hideAdd={options.palette}
        viewRef={viewRef}
        stepExtras={() => ({ insights: ["An insight"], issues: ["An issue"] })}
      />
    </div>
  );
}

window.mapIds = northbeamStepIds;
window.groupIds = DEMO_GROUP_IDS;
window.mountMap = (options) => {
  const el = document.getElementById("root")!;
  createRoot(el).render(<Harness options={options} />);
};
