"use client";

// The process library (issue #164, B12), in every editor: this workspace's processes, to place in the draft being edited as
// links. Pick several and add them at once; they land where the person is looking. Adding never edits or copies a process, and
// a process sits in one place only, so one that sits elsewhere is greyed with where. "New process" and the templates make a new
// process and place it the same way. The edit goes into the draft like any other change, so it is undone, saved and published
// with the rest.

import { useId, useMemo, useState, useTransition, type Dispatch, type SetStateAction } from "react";
import type { ProcessBundle, ProcessRow } from "@transpera-flow/db";
import { Help, HelpLabel } from "@/components/help";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { Selection } from "@/components/process-canvas";
import type { ProcessEditor } from "@/lib/editor/editor";
import { PLACED_REMOVE_NOTE } from "@/lib/editor/commands";
import type { ViewRef } from "@/lib/editor/groups";
import { filterLibrary, libraryEntries, placeProcesses, processesOfBundle, type LibraryEntry, type LibraryProcess, type LibraryTemplate } from "@/lib/editor/library";
import type { LibraryCreate } from "@/lib/editor/library-create";

export function ProcessLibrary({
  bundle,
  editor,
  setSelection,
  viewRef,
  processes,
  templates = [],
  onCreate,
}: {
  bundle: ProcessBundle;
  editor: ProcessEditor;
  setSelection: Dispatch<SetStateAction<Selection>>;
  viewRef?: ViewRef;
  /** The workspace's processes and where each sits (live links); without it, the processes the bundle carries. */
  processes?: readonly LibraryProcess[];
  /** Templates to make a new process from. */
  templates?: readonly LibraryTemplate[];
  /** Makes a new process ("New process", a template); without it, the library only places existing ones. */
  onCreate?: LibraryCreate;
}) {
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  // Processes made here since the Editor opened: in the library at once, placed where the person is looking.
  const [created, setCreated] = useState<LibraryProcess[]>([]);
  const [note, setNote] = useState<{ tone: "ok" | "warn"; text: string } | null>(null);
  const [newName, setNewName] = useState("");
  const [newKind, setNewKind] = useState<ProcessRow["kind"]>("pipeline");
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
  const here = shown.filter((e) => e.state === "placed");
  const holds = shown.filter((e) => e.state === "holds");
  // Those that sit somewhere else, one group per place.
  const elsewhere = new Map<string, LibraryEntry[]>();
  for (const e of shown) if (e.state === "inside") elsewhere.set(e.insideName ?? "another process", [...(elsewhere.get(e.insideName ?? "another process") ?? []), e]);
  // What was picked may since have been placed (or taken out again): only what can still be added counts.
  const addable = new Set(all.filter((e) => e.state === "free").map((e) => e.id));
  const chosen = [...picked].filter((id) => addable.has(id));
  // Ticked processes that the search is hiding are still ticked, and still added: the button says so.
  const shownIds = new Set(free.map((e) => e.id));
  const hidden = chosen.filter((id) => !shownIds.has(id)).length;
  const shownTemplates = filterLibrary(templates, query);

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
  const pickAll = () => setPicked(new Set([...picked, ...free.map((e) => e.id)]));
  const create = (input: Parameters<LibraryCreate>[0]) =>
    startTransition(async () => {
      if (!onCreate) return;
      setNote(null);
      const r = await onCreate(input);
      if (!r.process) {
        setNote({ tone: "warn", text: r.error });
        return;
      }
      const made: LibraryProcess = { id: r.process.id, name: r.process.name, kind: r.process.kind, live: r.process.live, holder: null };
      setCreated((now) => [...now, made]);
      place([made.id], [...known, made]);
      if (input.kind === "new") setNewName("");
      setNote({ tone: "ok", text: `Made ${made.name} and added it here. Build and publish it on its own page (Processes list) before you publish this one.` });
    });

  return (
    <section aria-label="Process library" data-process-library className="flex flex-col gap-2">
      <h2 className="flex items-center text-[11px] font-semibold tracking-wider text-fg-2 uppercase">
        Process library
        <Help
          label="Process library"
          description="Your workspace's processes. Tick the ones you want and add them: each appears here as a link to the process. The process itself is never changed or copied, and a process can sit in one place only."
          example="Tick “Sales” and “Onboarding”, press Add, and two linked processes appear in view."
        />
      </h2>
      <label htmlFor={searchId} className="sr-only">
        Search processes by name
      </label>
      <Input id={searchId} type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search by name" autoComplete="off" />
      {!all.length && !templates.length ? (
        <p className="text-xs text-muted-foreground">This workspace has no other processes yet.</p>
      ) : !shown.length && !shownTemplates.length ? (
        <p role="status" className="text-xs text-muted-foreground">
          No process matches “{query.trim()}”.
        </p>
      ) : (
        <div className="flex max-h-72 flex-col gap-2 overflow-y-auto pr-0.5" data-library-list>
          <LibraryGroup
            title="Not on any map"
            help={{ description: "Processes that sit nowhere yet. Tick the ones you want, then press Add.", example: "Tick Sales and Onboarding, press Add, and both appear here." }}
            empty={query.trim() ? null : "Every process already sits somewhere."}
            entries={free}
            picked={picked}
            onToggle={toggle}
          />
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
        {free.length > 1 && (
          <Button type="button" variant="outline" size="sm" onClick={pickAll} disabled={free.every((e) => picked.has(e.id))}>
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
          <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Kind of process">
            {(["pipeline", "servicing"] as const).map((k) => (
              <Button key={k} type="button" size="xs" variant={newKind === k ? "secondary" : "ghost"} aria-pressed={newKind === k} onClick={() => setNewKind(k)} data-library-new-kind={k}>
                {k === "pipeline" ? "Pipeline" : "Servicing"}
              </Button>
            ))}
            <Button type="button" size="sm" variant="outline" disabled={busy || !newName.trim()} onClick={() => create({ kind: "new", name: newName, processKind: newKind })} data-library-new-make className="ml-auto">
              Make and add
            </Button>
          </div>
          {shownTemplates.length > 0 && (
            <>
              <h3 className="text-xs font-medium text-fg-2">From a template (its numbers are rough estimates to check)</h3>
              <ul className="flex flex-col gap-1" aria-label="Templates">
                {shownTemplates.map((t) => (
                  <li key={t.id} data-library-template={t.id} className="flex items-center justify-between gap-2 rounded-token border border-line px-2 py-1.5 text-sm">
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate">{t.name}</span>
                      <span className="text-xs text-muted-foreground">{t.kind === "pipeline" ? "Pipeline" : "Servicing"}</span>
                    </span>
                    <Button type="button" size="xs" variant="outline" disabled={busy} onClick={() => create({ kind: "template", templateId: t.id })}>
                      Use
                    </Button>
                  </li>
                ))}
              </ul>
            </>
          )}
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
        const disabled = e.state !== "free";
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
                {e.kind === "pipeline" ? "Pipeline" : "Servicing"}
                {e.live ? "" : " · not published yet"}
              </span>
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
