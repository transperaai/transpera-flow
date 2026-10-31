"use client";

// "Company processes" in the free-play Sandbox (capacity build P7, brief sections 1 and 2; decisions D31 and D38). On top, the company map with all its
// controls when the page has one. Under it, for each process, a map version (today's map, or one of its solutions from a chosen month, with the issue it is
// linked to) and, for each step a change acts on, a block: "As today", or a change from a chosen month. Then the list of changes (add, edit, remove).

import { useMemo } from "react";
import { changesActingOn, describeEffect, type CapacityChangeRow, type PlayState } from "@transpera-flow/db";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";
import { cn } from "@/lib/utils";
import type { PlayMonths, PlayProcess } from "./play-types";

export function PlayProcesses({
  play,
  setPlay,
  processes,
  library,
  months,
  map,
  canEdit,
  onAddChange,
  onEditChange,
}: {
  play: PlayState;
  setPlay: (next: PlayState) => void;
  processes: PlayProcess[];
  library: CapacityChangeRow[];
  months: PlayMonths;
  /** The company map with its controls, when the page has it. */
  map?: React.ReactNode;
  canEdit: boolean;
  onAddChange: () => void;
  onEditChange: (change: CapacityChangeRow) => void;
}) {
  const swapped = Object.keys(play.blocks).length;
  const versions = Object.keys(play.versions).length;
  const byId = useMemo(() => new Map(library.map((c) => [c.id, c])), [library]);
  const monthOptions = months.long.map((m, i) => (
    <option key={i} value={i}>
      {m}
    </option>
  ));

  const pickBlock = (stepId: string, changeId: string) => {
    const blocks = { ...play.blocks };
    // "As today" takes out whatever acts on this step; a block takes the place of the one before it.
    for (const c of changesActingOn(library, stepId)) delete blocks[c.id];
    if (changeId) blocks[changeId] = 0;
    setPlay({ ...play, blocks });
  };

  return (
    <section className="flex min-w-0 flex-col gap-4 rounded-token border border-line bg-panel p-4" data-play-processes aria-labelledby="play-processes-h">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="play-processes-h" className="font-heading text-lg font-semibold">
          Company processes
        </h2>
        <span className="text-sm text-muted-foreground" data-swapped-count>
          {swapped || versions ? [versions ? `${versions} map version${versions > 1 ? "s" : ""}` : "", swapped ? `${swapped} block${swapped > 1 ? "s" : ""} swapped` : ""].filter(Boolean).join(", ") : "As today"}
        </span>
      </div>
      {map}
      <p className="text-sm text-muted-foreground">
        Pick a map version for a process, and swap a block into a step. A block acts on the step&apos;s automatable and augmentable parts, so it follows the step&apos;s own numbers. Nothing here changes live data.
      </p>

      <div className="grid gap-4 lg:grid-cols-2">
        {processes.map((p) => {
          const v = play.versions[p.id];
          const withBlocks = p.steps.filter((s) => changesActingOn(library, s.id).length > 0);
          return (
            <div key={p.id} className="flex min-w-0 flex-col gap-2 rounded-token border border-line p-3" data-process={p.id}>
              <h3 className="text-sm font-semibold">{p.name}</h3>
              <div className="grid gap-2 sm:grid-cols-[1fr_9rem]" data-version-row>
                <label className="flex min-w-0 flex-col gap-1 text-xs text-muted-foreground">
                  Map version
                  <NativeSelect
                    value={v?.solution ?? ""}
                    disabled={!p.solutions.length}
                    data-version={p.id}
                    onChange={(e) => {
                      const versions = { ...play.versions };
                      if (e.target.value) versions[p.id] = { solution: e.target.value, month: v?.month ?? 0 };
                      else delete versions[p.id];
                      setPlay({ ...play, versions });
                    }}
                  >
                    <option value="">Today</option>
                    {p.solutions.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                        {s.issue ? ` (fixes: ${s.issue})` : ""}
                      </option>
                    ))}
                  </NativeSelect>
                </label>
                <label className="flex min-w-0 flex-col gap-1 text-xs text-muted-foreground">
                  From
                  <NativeSelect value={v?.month ?? 0} disabled={!v} data-version-month={p.id} onChange={(e) => setPlay({ ...play, versions: { ...play.versions, [p.id]: { ...v!, month: Number(e.target.value) } } })}>
                    {monthOptions}
                  </NativeSelect>
                </label>
              </div>
              {!p.solutions.length && <p className="text-xs text-muted-foreground">No solutions for this process yet.</p>}

              {withBlocks.length > 0 ? (
                <ul className="flex flex-col gap-2" data-steps>
                  {withBlocks.map((s) => {
                    const blocks = changesActingOn(library, s.id);
                    const cur = blocks.find((c) => play.blocks[c.id] !== undefined);
                    return (
                      <li key={s.id} className={cn("grid gap-2 rounded-token border border-line-2 p-2 sm:grid-cols-[1fr_1fr_8rem]", cur && "border-accent bg-accent/5")} data-step-row={s.id} data-swapped={cur ? "true" : undefined}>
                        <div className="min-w-0">
                          <div className="text-sm font-medium">{s.name}</div>
                          <div className="text-xs text-muted-foreground">{s.who}</div>
                        </div>
                        <label className="flex min-w-0 flex-col gap-1 text-xs text-muted-foreground">
                          Block
                          <NativeSelect value={cur?.id ?? ""} data-block={s.id} onChange={(e) => pickBlock(s.id, e.target.value)}>
                            <option value="">As today</option>
                            {blocks.map((c) => (
                              <option key={c.id} value={c.id}>
                                {c.name}
                              </option>
                            ))}
                          </NativeSelect>
                        </label>
                        <label className="flex min-w-0 flex-col gap-1 text-xs text-muted-foreground">
                          From
                          <NativeSelect
                            value={cur ? play.blocks[cur.id] : 0}
                            disabled={!cur}
                            data-block-month={s.id}
                            onChange={(e) => cur && setPlay({ ...play, blocks: { ...play.blocks, [cur.id]: Number(e.target.value) } })}
                          >
                            {monthOptions}
                          </NativeSelect>
                        </label>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="text-xs text-muted-foreground">No blocks yet for the steps of this process.</p>
              )}
            </div>
          );
        })}
      </div>

      <div className="flex flex-col gap-2" data-changes-list>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="text-sm font-semibold">Changes</h3>
          {canEdit && (
            <Button type="button" variant="outline" size="sm" onClick={onAddChange} data-change-add>
              + Add a change
            </Button>
          )}
        </div>
        {library.length ? (
          <ul className="grid gap-2 sm:grid-cols-2">
            {library.map((c) => (
              <li key={c.id} className="flex min-w-0 items-start justify-between gap-2 rounded-token border border-line-2 p-2 text-sm" data-change={c.id}>
                <div className="min-w-0">
                  <div className="font-medium">{c.name}</div>
                  <div className="text-xs text-muted-foreground">
                    {c.kind === "automation" ? "Automation" : "Augmentation"}, {Math.round(c.adoption * 100)}% adoption, {c.effects.length} effect{c.effects.length === 1 ? "" : "s"}
                    {c.tiers ? `, ${c.tiers.join(" ")} only` : ""}
                    {byId.get(c.id) && c.effects[0] ? `. ${describeEffect(c.effects[0])}` : ""}
                  </div>
                </div>
                {canEdit && (
                  <Button type="button" variant="ghost" size="sm" onClick={() => onEditChange(c)} aria-label={`Edit ${c.name}`}>
                    Edit
                  </Button>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground" data-changes-empty>
            No changes yet. {canEdit ? "Add one to swap it into a step." : "An Agency admin or the Owner can add some."}
          </p>
        )}
      </div>
    </section>
  );
}
