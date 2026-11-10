"use client";

// The process library (issue #164, B12), in the company map's editor only (a process's own editor makes no links, editor brainstorm item 3): this workspace's processes, to place in the draft being edited as
// links. Pick several and add them at once; they land where the person is looking. Adding never edits or copies a process, and
// a process sits in one place only, so one that sits elsewhere is greyed with where. "New process" makes a new
// process and place it the same way. The edit goes into the draft like any other change, so it is undone, saved and published
// with the rest.

import { useId, useMemo, useState, useTransition, type Dispatch, type SetStateAction } from "react";
import { PROCESS_CATEGORIES, PROCESS_CATEGORY_HELP, PROCESS_CATEGORY_LABELS, type ProcessBundle, type ProcessCategory } from "@transpera-flow/db";
import { PanelHeading } from "@/components/editor/panel-heading";
import { Help, HelpLabel } from "@/components/help";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import type { Selection } from "@/components/process-canvas";
import type { ProcessEditor } from "@/lib/editor/editor";
import { PLACED_REMOVE_NOTE } from "@/lib/editor/commands";
import type { ViewRef } from "@/lib/editor/groups";
import { filterLibrary, isAddable, libraryEntries, placeProcesses, processesOfBundle, type LibraryEntry, type LibraryProcess } from "@/lib/editor/library";
import type { LibraryCreate } from "@/lib/editor/library-create";

export function ProcessLibrary({
  bundle,
  editor,
  setSelection,
  viewRef,
  processes,
  onCreate,
}: {
  bundle: ProcessBundle;
  editor: ProcessEditor;
  setSelection: Dispatch<SetStateAction<Selection>>;
  viewRef?: ViewRef;
  /** The workspace's processes and where each sits (live links); without it, the processes the bundle carries. */
  processes?: readonly LibraryProcess[];
  /** Makes a new process ("New process"); without it, the library only places existing ones. No templates (QA round 2). */
  onCreate?: LibraryCreate;
}) {
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  // Processes made here since the Editor opened: in the library at once, placed where the person is looking.
  const [created, setCreated] = useState<LibraryProcess[]>([]);
  const [note, setNote] = useState<{ tone: "ok" | "warn"; text: string } | null>(null);
  const [newName, setNewName] = useState("");
  const [newCategory, setNewCategory] = useState<ProcessCategory>("sales");
  const [busy, startTransition] = useTransition();
  const searchId = useId();
  const nameId = useId();
  const known = useMemo(() => {
    const base = processes ?? processesOfBundle(bundle);
    const have = new Set(base.map((p) => p.id));
    return [...base, ...created.filter((p) => !have.has(p.id))];
  }, [processes, bundle, created]);
  const all = useMemo(() => libraryEntries(bundle, known), [bundle, known]);
  const shown = useMemo(() => filterLibrary(all, query), [all, query]);
  const free = shown.filter((e) => e.state === "free");
  const onMap = shown.filter((e) => e.state === "map");
  const here = shown.filter((e) => e.state === "placed");
  const holds = shown.filter((e) => e.state === "holds");
  // Those that sit somewhere else, one group per place.
  const elsewhere = new Map<string, LibraryEntry[]>();
  for (const e of shown) if (e.state === "inside") elsewhere.set(e.insideName ?? "another process", [...(elsewhere.get(e.insideName ?? "another process") ?? []), e]);
  // What was picked may since have been placed (or taken out again): only what can still be added counts.
  const addable = new Set(all.filter(isAddable).map((e) => e.id));
  const chosen = [...picked].filter((id) => addable.has(id));
  // Ticked processes that the search is hiding are still ticked, and still added: the button says so.
  const shownIds = new Set([...free, ...onMap].map((e) => e.id));
  const hidden = chosen.filter((id) => !shownIds.has(id)).length;

  const toggle = (id: string) =>
    setPicked((now) => {
      const next = new Set(now);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const place = (ids: readonly string[], list: readonly LibraryProcess[]) => {
    let made: string[] = [];
    editor.run((b) => {
      const placed = placeProcesses(b, ids, viewRef?.current?.() ?? null, list);
      made = placed?.ids ?? [];
      return placed?.edit ?? null;
    });
    if (made.length) setSelection({ steps: made, edges: [] });
    return made.length;
  };
  const add = () => {
    place(chosen, known);
    setPicked(new Set());
    setNote(null);
  };
  const pickAll = () => setPicked(new Set([...picked, ...free.map((e) => e.id), ...onMap.map((e) => e.id)]));
  const create = (input: Parameters<LibraryCreate>[0]) =>
    startTransition(async () => {
      if (!onCreate) return;
      setNote(null);
      const r = await onCreate(input);
      if (!r.process) {
        setNote({ tone: "warn", text: r.error });
        return;
      }
      const made: LibraryProcess = { id: r.process.id, name: r.process.name, kind: r.process.kind, category: r.process.category, live: r.process.live, holder: null };
      setCreated((now) => [...now, made]);
      place([made.id], [...known, made]);
      if (input.kind === "new") setNewName("");
      setNote({ tone: "ok", text: `Made ${made.name} and added it here. Build and publish it on its own page (Processes list) before you publish this one.` });
    });

  return (
    <section aria-label="Process library" data-process-library className="flex flex-col gap-2">
      <PanelHeading>
        Process library
        <Help
          label="Process library"
          description="Your workspace's processes. Tick the ones you want and add them: each appears here as a link to the process. The process itself is never changed or copied, and a process can sit in one place only."
          example="Tick “Sales” and “Onboarding”, press Add, and two linked processes appear in view."
        />
      </PanelHeading>
      <label htmlFor={searchId} className="sr-only">
        Search processes by name
      </label>
      <Input id={searchId} type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search by name" autoComplete="off" />
      {!all.length ? (
        <p className="text-xs text-muted-foreground">This workspace has no other processes yet.</p>
      ) : !shown.length ? (
        <p role="status" className="text-xs text-muted-foreground">
          No process matches “{query.trim()}”.
        </p>
      ) : (
        <div className="flex max-h-72 flex-col gap-2 overflow-y-auto pr-0.5" data-library-list>
          <LibraryGroup
            title="Not on any map"
            help={{ description: "Processes that sit nowhere yet. Tick the ones you want, then press Add.", example: "Tick Sales and Onboarding, press Add, and both appear here." }}
            empty={query.trim() || onMap.length ? null : "Every process already sits somewhere."}
            entries={free}
            picked={picked}
            onToggle={toggle}
          />
          {onMap.length > 0 && (
            <LibraryGroup
              title="On the company map"
              help={{
                description: "The company map is where a process sits until you put it somewhere else. Add one here and it moves here when you publish: its card comes off the company map.",
                example: "Tick Client check-in, add it, publish: it now sits in this process, not on the company map.",
              }}
              entries={onMap}
              picked={picked}
              onToggle={toggle}
            />
          )}
          {here.length > 0 && (
            <LibraryGroup
              title="On this map"
              help={{ description: "Already here, in the draft you are editing. A process sits in one place only, so it can't be added twice.", example: "Sales is already here, so it is greyed out." }}
              entries={here}
              picked={picked}
              onToggle={toggle}
            />
          )}
          {[...elsewhere.entries()].map(([where, entries]) => (
            <LibraryGroup
              key={where}
              title={`On ${where}`}
              entries={entries}
              picked={picked}
              onToggle={toggle}
            />
          ))}
          {holds.length > 0 && (
            <LibraryGroup
              title="Holds this process"
              entries={holds}
              picked={picked}
              onToggle={toggle}
            />
          )}
        </div>
      )}
      <div className="flex items-center gap-1.5">
        <Button type="button" size="sm" disabled={!chosen.length} onClick={add} data-library-add className="flex-1">
          {chosen.length ? `Add ${chosen.length} to the map${hidden ? ` (${hidden} hidden by search)` : ""}` : "Add to the map"}
        </Button>
        {free.length + onMap.length > 1 && (
          <Button type="button" variant="outline" size="sm" onClick={pickAll} disabled={[...free, ...onMap].every((e) => picked.has(e.id))}>
            Select all
          </Button>
        )}
      </div>
      <p className="text-xs text-muted-foreground">{PLACED_REMOVE_NOTE}</p>

      {onCreate && (
        <div className="flex flex-col gap-1.5 border-t border-line pt-2" data-library-new>
          <h3>
            <HelpLabel
              label="New process"
              description="Makes a new, empty process and adds it here as a link. Build it on its own page; it is published on its own."
              example="Type “Client offboarding”, press Make and add, and it appears here, ready to build."
            />
          </h3>
          <label htmlFor={nameId} className="sr-only">
            Name of the new process
          </label>
          <Input id={nameId} value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Name" autoComplete="off" maxLength={120} data-library-new-name />
          <span className="flex items-center">
            <label htmlFor={`${nameId}-category`} className="text-xs font-medium text-fg-2">
              What kind of process it is
            </label>
            <Help
              label="What kind of process it is"
              description="What the process is for, in the words the Processes page uses. It decides how the simulation treats it: Sales and Onboarding run for each new lead or client; the rest run as repeating work."
              example="A monthly report for existing clients is Routine client work."
            />
          </span>
          <NativeSelect id={`${nameId}-category`} value={newCategory} onChange={(e) => setNewCategory(e.target.value as ProcessCategory)} data-library-new-category>
            {PROCESS_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {PROCESS_CATEGORY_LABELS[c]}
              </option>
            ))}
          </NativeSelect>
          <p className="text-xs text-muted-foreground" data-library-category-help>
            {PROCESS_CATEGORY_HELP[newCategory]}
          </p>
          <Button type="button" size="sm" variant="outline" disabled={busy || !newName.trim()} onClick={() => create({ kind: "new", name: newName, category: newCategory })} data-library-new-make className="self-end">
            Make and add
          </Button>
        </div>
      )}
      {note && (
        <p role="status" data-library-note className={`rounded-token border px-2 py-1 text-xs ${note.tone === "ok" ? "border-good bg-good-soft" : "border-warn bg-warn-soft"}`}>
          {note.text}
        </p>
      )}
    </section>
  );
}

function LibraryGroup({
  title,
  help,
  entries,
  empty = null,
  picked,
  onToggle,
}: {
  title: string;
  help?: { description: string; example: string };
  entries: LibraryEntry[];
  empty?: string | null;
  picked: ReadonlySet<string>;
  onToggle: (id: string) => void;
}) {
  if (!entries.length && !empty) return null;
  return (
    <div className="flex flex-col gap-0.5" role="group" aria-label={title}>
      <h3>{help ? <HelpLabel label={title} description={help.description} example={help.example} /> : <span className="text-xs font-medium text-fg-2">{title}</span>}</h3>
      {!entries.length && <p className="text-xs text-muted-foreground">{empty}</p>}
      {entries.map((e) => {
        const disabled = !isAddable(e);
        return (
          <label
            key={e.id}
            data-library-item={e.id}
            data-state={e.state}
            className={`flex items-start gap-2 rounded-token border border-line px-2 py-1.5 text-sm ${disabled ? "cursor-not-allowed bg-panel-2 text-fg-3" : "cursor-pointer hover:border-edit"}`}
          >
            <input
              type="checkbox"
              className="mt-1"
              disabled={disabled}
              checked={!disabled && picked.has(e.id)}
              onChange={() => onToggle(e.id)}
              aria-describedby={disabled ? `${e.id}-why` : undefined}
            />
            <span className="flex min-w-0 flex-col">
              <span className="truncate">{e.name}</span>
              <span className="text-xs text-muted-foreground">
                {PROCESS_CATEGORY_LABELS[e.category]}
                {e.live ? "" : " · not published yet"}
              </span>
              {e.state === "map" && (
                <span className="text-xs text-muted-foreground">On the company map — moves here when you publish.</span>
              )}
              {e.state === "placed" && (
                <span id={`${e.id}-why`} className="text-xs text-muted-foreground">
                  Already here. A process sits in one place only.
                </span>
              )}
              {e.state === "inside" && (
                <span id={`${e.id}-why`} className="text-xs text-muted-foreground">
                  {e.insideName === "the company map" ? "Already on the company map" : `Already inside ${e.insideName ?? "another process"}`}. A process sits in one place only: take it off there first.
                </span>
              )}
              {e.state === "holds" && (
                <span id={`${e.id}-why`} className="text-xs text-muted-foreground">
                  It holds this process, so it can&apos;t also sit inside it.
                </span>
              )}
            </span>
          </label>
        );
      })}
    </div>
  );
}
