// The process map on a bare page, for the browser tests in ../map-browser.test.ts. Bundled by esbuild and
// driven through `window.mountMap` and `window.mapApi`; nothing here ships.

import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type Dispatch, type SetStateAction } from "react";
import { createRoot } from "react-dom/client";
import { defaultCompanyPart, northbeamBundle, northbeamStepIds, partOf, type ProcessBundle, type ProcessPart } from "@transpera-flow/db";
import { NO_SELECTION, ProcessCanvas, type Selection } from "@/components/process-canvas";
import { Palette } from "@/components/editor/palette";
import { Inspector } from "@/components/editor/inspector";
import { useEditCommands } from "@/components/editor/use-edit-commands";
import type { BlockTools } from "@/components/editor/use-blocks";
import { DEMO_GROUP_IDS, withDemoGroups } from "@/lib/demo/nested";
import { addStep, deleteSelection } from "@/lib/editor/commands";
import type { ViewHint } from "@/lib/editor/groups";
import type { LibraryProcess, LibraryTemplate } from "@/lib/editor/library";
import type { LibraryCreate, LibraryCreateInput } from "@/lib/editor/library-create";
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
  /** An ordinary process's editor with the process library (B12 part 2): Northbeam's other processes, one on the company map, templates, and a stand-in "New process". */
  library?: boolean;
  /** The first run is still computing (issue #44): the map carries the "Running the first simulation" chip. */
  computing?: boolean;
  /** A process with nothing between start and end (issue #44): a read-only map says so, an editable one stays empty. */
  empty?: boolean;
}

declare global {
  interface Window {
    mountMap: (options: HarnessOptions) => void;
    mapApi: {
      setHighlight: (ids: string[] | null) => void;
      setOpen: (ids: string[]) => void;
      getOpen: () => string[];
      addStep: () => void;
      /** Delete cards by name (all of them with no names), as the Editor's Delete key does. */
      removeCards: (names?: string[]) => void;
      /** The editor's connections, by the names of the cards they join, with their labels and shares. */
      getEdges: () => { from: string; to: string; label: string | null; probability: number }[];
      getSteps: () => string[];
      /** What the stand-in "New process" was asked to make. */
      created: () => unknown[];
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

/** What the stand-in "New process" was asked to make. */
const created: unknown[] = [];

/** The library an ordinary editor is handed (B12 part 2): the other processes sit nowhere, one more sits on the company map. */
function libraryOf(bundle: ProcessBundle): { processes: LibraryProcess[]; templates: LibraryTemplate[]; onCreate: LibraryCreate } {
  const others = (bundle.otherProcesses ?? []).map<LibraryProcess>((p) => ({ id: p.process.id, name: p.process.name, kind: p.process.kind, live: true, holder: null }));
  return {
    processes: [
      { id: bundle.process.id, name: bundle.process.name, kind: bundle.process.kind, live: true, holder: { id: "cccc0000-0000-4000-8000-00000000c0c0", name: "Company map", company: true } },
      ...others,
      { id: "f0000000-0000-4000-8000-000000000001", name: "Renewals", kind: "servicing", live: true, holder: null },
      { id: "f0000000-0000-4000-8000-000000000002", name: "Referrals", kind: "pipeline", live: true, holder: { id: "cccc0000-0000-4000-8000-00000000c0c0", name: "Company map", company: true } },
    ],
    templates: [{ id: "agency-delivery", name: "Agency delivery", kind: "servicing", description: "A template." }],
    onCreate: async (input: LibraryCreateInput) => {
      created.push(input);
      const name = input.kind === "new" ? input.name : "Agency delivery";
      return { process: { id: `e0000000-0000-4000-8000-00000000000${created.length}`, name, kind: input.kind === "new" ? input.processKind : "servicing", live: false } };
    },
  };
}
/** The Editor's keyboard shortcuts (Delete, undo, ...), as the Editor mounts them, so the real removal path is the one under test. */
function EditorKeys({ editor, bundle, selection, setSelection }: { editor: ProcessEditor; bundle: ProcessBundle; selection: Selection; setSelection: Dispatch<SetStateAction<Selection>> }) {
  useEditCommands({ editor, bundle, selected: selection, setSelection });
  return null;
}

function Harness({ options }: { options: HarnessOptions }) {
  const base = useMemo(() => {
    const bundle = options.company ? companyBundle() : options.nested ? withDemoGroups(demoBundle()) : demoBundle();
    if (!options.empty) return bundle;
    const ends = bundle.steps.filter((s) => s.kind === "start" || s.kind === "end");
    const kept = new Set(ends.map((s) => s.id));
    return { ...bundle, steps: ends, edges: bundle.edges.filter((e) => kept.has(e.from_step_id) && kept.has(e.to_step_id)) };
  }, [options.nested, options.company, options.empty]);
  const editor = useMemo(() => (options.editable ? new ProcessEditor(base, new MemoryStore(base)) : null), [base, options.editable]);
  const state = useSyncExternalStore(editor ? editor.subscribe : never, editor ? editor.getState : () => null, () => null);
  const [selection, setSelection] = useState<Selection>(NO_SELECTION);
  const viewRef = useRef<(() => ViewHint | null) | null>(null);
  const library = useMemo(() => (options.library ? libraryOf(base) : undefined), [base, options.library]);
  const [highlight, setHighlight] = useState(options.highlight);
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    window.mapApi = {
      setHighlight,
      setOpen: (ids) => setOpen(new Set(ids)),
      getOpen: () => [...open],
      addStep: () => editor?.run((b) => addStep(b, { kind: "task", x: 3200, y: 900 }).edit),
      removeCards: (names) => editor?.run((b) => deleteSelection(b, b.steps.filter((s) => !names || names.includes(s.name)).map((s) => s.id), [])),
      getEdges: () => {
        const b = editor?.getState().bundle ?? base;
        const name = (id: string) => b.steps.find((s) => s.id === id)?.name ?? id;
        return b.edges.map((e) => ({ from: name(e.from_step_id), to: name(e.to_step_id), label: e.label, probability: Number(e.probability) }));
      },
      getSteps: () => (editor?.getState().bundle ?? base).steps.map((s) => s.name),
      created: () => [...created],
    };
  }, [open, editor, base]);
  return (
    // Where the app puts the map: an editor's map fills a flex panel; a read-only one sits in a block, as wide as the page.
    // (In a bare flex row a read-only map shrinks to its toolbar, and the "drag the map" hint it adds after framing widens
    // that toolbar, so the panel resizes and the map refits at a time that depends on load: the flake in #99's test.)
    <div style={options.editable || options.palette ? { width: 1300, height: 560, display: "flex" } : options.card ? { width: "100%", display: "flex", flexDirection: "column" } : { width: 1300 }}>
      {options.palette && editor && (
        <aside style={{ width: 220, padding: 8 }}>
          <Palette bundle={state?.bundle ?? base} editor={editor} selected={selection} setSelection={setSelection} blocks={NO_BLOCKS} company={options.company} viewRef={viewRef} library={library} />
        </aside>
      )}
      {options.palette && editor && <EditorKeys editor={editor} bundle={state?.bundle ?? base} selection={selection} setSelection={setSelection} />}
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
        computing={options.computing}
      />
      {options.palette && editor && options.company && (
        <aside aria-label="Inspector" style={{ width: 260, padding: 8 }}>
          <Inspector
            bundle={state?.bundle ?? base}
            editor={editor}
            selected={selection}
            setSelection={setSelection}
            inspectFocus={null}
            onFocused={() => undefined}
            sources={[]}
            stamp={() => ({ at: "2026-10-05T00:00:00Z", by: null }) as never}
            mode="draft"
            draft={null}
            blocks={NO_BLOCKS}
            company
          />
        </aside>
      )}
    </div>
  );
}

window.mapIds = northbeamStepIds;
window.groupIds = DEMO_GROUP_IDS;
window.mountMap = (options) => {
  const el = document.getElementById("root")!;
  createRoot(el).render(<Harness options={options} />);
};
