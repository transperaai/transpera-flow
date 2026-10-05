"use client";

// The process library on the company map (issue #164, B12): this workspace's processes, to place on the map being edited as
// linked cards. Pick several and add them at once; they land where the person is looking. Adding never edits or copies a process.
// The edit goes into the map's draft like any other change, so it is undone, saved and published with the rest.

import { useId, useMemo, useState, type Dispatch, type SetStateAction } from "react";
import type { ProcessBundle } from "@transpera-flow/db";
import { Help } from "@/components/help";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { Selection } from "@/components/process-canvas";
import type { ProcessEditor } from "@/lib/editor/editor";
import { PLACED_REMOVE_NOTE } from "@/lib/editor/commands";
import type { ViewRef } from "@/lib/editor/groups";
import { filterLibrary, libraryEntries, placeProcesses, type LibraryEntry } from "@/lib/editor/library";

export function ProcessLibrary({
  bundle,
  editor,
  setSelection,
  viewRef,
}: {
  bundle: ProcessBundle;
  editor: ProcessEditor;
  setSelection: Dispatch<SetStateAction<Selection>>;
  viewRef?: ViewRef;
}) {
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const searchId = useId();
  const all = useMemo(() => libraryEntries(bundle), [bundle]);
  const shown = useMemo(() => filterLibrary(all, query), [all, query]);
  const free = shown.filter((e) => e.state === "free");
  const taken = shown.filter((e) => e.state !== "free");
  // What was picked may since have been placed (or its card removed again): only what can still be added counts.
  const addable = new Set(all.filter((e) => e.state === "free").map((e) => e.id));
  const chosen = [...picked].filter((id) => addable.has(id));

  const toggle = (id: string) =>
    setPicked((now) => {
      const next = new Set(now);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const add = () => {
    let made: string[] = [];
    editor.run((b) => {
      const placed = placeProcesses(b, chosen, viewRef?.current?.() ?? null);
      made = placed?.ids ?? [];
      return placed?.edit ?? null;
    });
    setPicked(new Set());
    if (made.length) setSelection({ steps: made, edges: [] });
  };
  const pickAll = () => setPicked(new Set([...picked, ...free.map((e) => e.id)]));

  return (
    <section aria-label="Process library" data-process-library className="flex flex-col gap-2">
      <h2 className="flex items-center text-[11px] font-semibold tracking-wider text-fg-2 uppercase">
        Process library
        <Help
          label="Process library"
          description="Your workspace's processes. Tick the ones you want and add them: each appears on the map as a card that links to the process. The process itself is never changed or copied, and a process can be on the map only once."
          example="Tick “Sales” and “Onboarding”, press Add, and two cards appear in view."
        />
      </h2>
      <label htmlFor={searchId} className="sr-only">
        Search processes by name
      </label>
      <Input id={searchId} type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search by name" autoComplete="off" />
      {!all.length ? (
        <p className="text-xs text-muted-foreground">This workspace has no processes yet.</p>
      ) : !shown.length ? (
        <p role="status" className="text-xs text-muted-foreground">
          No process matches “{query.trim()}”.
        </p>
      ) : (
        <div className="flex max-h-72 flex-col gap-2 overflow-y-auto pr-0.5" data-library-list>
          <LibraryGroup title="Not on the map" empty={query.trim() ? null : "Every process is already on the map."} entries={free} picked={picked} onToggle={toggle} />
          {taken.length > 0 && <LibraryGroup title="On the map" entries={taken} picked={picked} onToggle={toggle} />}
        </div>
      )}
      <div className="flex items-center gap-1.5">
        <Button type="button" size="sm" disabled={!chosen.length} onClick={add} data-library-add className="flex-1">
          {chosen.length ? `Add ${chosen.length} to the map` : "Add to the map"}
        </Button>
        {free.length > 1 && (
          <Button type="button" variant="outline" size="sm" onClick={pickAll} disabled={free.every((e) => picked.has(e.id))}>
            Select all
          </Button>
        )}
      </div>
      <p className="text-xs text-muted-foreground">{PLACED_REMOVE_NOTE}</p>
    </section>
  );
}

function LibraryGroup({
  title,
  entries,
  empty = null,
  picked,
  onToggle,
}: {
  title: string;
  entries: LibraryEntry[];
  empty?: string | null;
  picked: ReadonlySet<string>;
  onToggle: (id: string) => void;
}) {
  if (!entries.length && !empty) return null;
  return (
    <div className="flex flex-col gap-0.5" role="group" aria-label={title}>
      <h3 className="text-xs font-medium text-fg-2">{title}</h3>
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
              <span className="text-xs text-muted-foreground">{e.kind === "pipeline" ? "Pipeline" : "Servicing"}</span>
              {e.state === "placed" && (
                <span id={`${e.id}-why`} className="text-xs text-muted-foreground">
                  Already on this map. A process can be on it once.
                </span>
              )}
              {e.state === "inside" && (
                <span id={`${e.id}-why`} className="text-xs text-muted-foreground">
                  Sits inside {e.insideName ?? "another process"}, so it can&apos;t also be on the map.
                </span>
              )}
            </span>
          </label>
        );
      })}
    </div>
  );
}
