"use client";

// "Company map" in the free-play Sandbox (Q16): the company's map is the Sandbox's way to load a different version of a process. Click a process card and a
// popover lists "Today" and each map made for that process (a solution, with its status), and the month it starts. The choice is `play.versions` (P7's E6;
// `?solution=` fills it too). Above the map: which processes are on a new version, each a removable chip, and "Reset to today". The map is the first
// thing under the Sandbox's toolbar, full width and always shown (not foldable).

import { useEffect, useState, type ReactNode } from "react";
import type { PlayState } from "@transpera-flow/db";
import { EmptyState, StatusPill } from "@/components/page-kit";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { SOLUTION_STATUS_OPTIONS } from "@/lib/solutions/status";
import { cn } from "@/lib/utils";
import type { PlayMonths, PlayProcess } from "./play-types";

/** What the page's canvas is given to draw the Sandbox's map. */
export interface PlayMapApi {
  /** "New version: <name>" by process id, for the cards of processes on a new version. */
  badges: ReadonlyMap<string, string>;
  /** A card (or a step inside an open card) of this process was clicked; `cardId` is the id of the node, to put the popover beside it. */
  onProcess: (processId: string, cardId?: string) => void;
}

/** The processes on a new version, with the name of the map each runs. Pure. */
export function versionBadges(play: PlayState, processes: readonly PlayProcess[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const [processId, v] of Object.entries(play.versions)) {
    const name = processes.find((p) => p.id === processId)?.solutions.find((s) => s.id === v.solution)?.name;
    if (name) out.set(processId, `New version: ${name}`);
  }
  return out;
}

type Rect = { left: number; top: number; width: number; height: number };

/** Where a card of the map is on screen (the map itself when the card isn't drawn). */
function cardRect(cardId: string | null): Rect {
  const host = document.querySelector<HTMLElement>("[data-company-map]");
  const el = (cardId ? host?.querySelector<HTMLElement>(`[data-id="${CSS.escape(cardId)}"]`) : null) ?? host;
  const r = el?.getBoundingClientRect();
  return r ? { left: r.left, top: r.top, width: r.width, height: r.height } : { left: 0, top: 0, width: 0, height: 0 };
}

export function PlayMapCard({
  play,
  setPlay,
  processes,
  months,
  canvas,
  header,
}: {
  play: PlayState;
  setPlay: (next: PlayState) => void;
  processes: PlayProcess[];
  months: PlayMonths;
  /** The company map, drawn by the page (the harness of the browser test draws a stand-in). */
  canvas?: (api: PlayMapApi) => ReactNode;
  /** Above the summary line (the company map version select). */
  header?: ReactNode;
}) {
  const badges = versionBadges(play, processes);
  const [open, setOpen] = useState<{ processId: string; rect: Rect } | null>(null);

  // Where the last press on the map was: the popover opens at that point (the card may be partly out of the map's frame). From the keyboard there is
  // no press, so it opens beside the card.
  const [pressed] = useState<{ at: { x: number; y: number } | null }>(() => ({ at: null }));
  useEffect(() => {
    let forget: ReturnType<typeof setTimeout> | undefined;
    const note = (e: PointerEvent) => {
      pressed.at = { x: e.clientX, y: e.clientY };
      clearTimeout(forget);
      forget = setTimeout(() => (pressed.at = null), 1500);
    };
    window.addEventListener("pointerdown", note, true);
    return () => {
      clearTimeout(forget);
      window.removeEventListener("pointerdown", note, true);
    };
  }, [pressed]);

  // The popover is placed in the window, so it goes when the window is resized.
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(null);
    window.addEventListener("resize", close);
    return () => window.removeEventListener("resize", close);
  }, [open]);

  const onProcess = (processId: string, cardId?: string) => {
    if (!processes.some((p) => p.id === processId)) return;
    const p = pressed.at;
    const rect = p ? { left: p.x, top: p.y, width: 1, height: 1 } : cardRect(cardId ?? null);
    setOpen({ processId, rect });
  };

  const choose = (processId: string, solution: string | null) => {
    const versions = { ...play.versions };
    if (solution) versions[processId] = { solution, month: versions[processId]?.month ?? 0 };
    else delete versions[processId];
    setPlay({ ...play, versions });
  };

  const pick = open ? processes.find((p) => p.id === open.processId) : undefined;
  const picked = pick ? play.versions[pick.id] : undefined;
  const on = Object.entries(play.versions).flatMap(([id, v]) => {
    const p = processes.find((x) => x.id === id);
    const s = p?.solutions.find((x) => x.id === v.solution);
    return p && s ? [{ process: p, solution: s }] : [];
  });

  return (
    <div data-play-map>
      <section aria-label="Company map" className="flex min-w-0 flex-col gap-3" data-play-map-section>
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
          <h2 className="text-base font-semibold">Company map</h2>
          <span className="text-xs text-muted-foreground">Click a process to try another version.</span>
        </div>
        <div className="flex min-w-0 flex-col gap-3">
          {header}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm" data-version-summary data-versions={on.length}>
            {on.length ? (
              <>
                <span className="font-medium">
                  {on.length} process{on.length === 1 ? "" : "es"} on new versions
                </span>
                <ul className="flex flex-wrap gap-1.5">
                  {on.map(({ process, solution }) => (
                    <li key={process.id} data-version-chip={process.id} className="inline-flex items-center gap-1 rounded-full border border-accent bg-accent/5 py-0.5 pr-1 pl-2.5 text-xs">
                      <span>
                        {process.name}: <b className="font-semibold">{solution.name}</b>
                        {(play.versions[process.id]?.month ?? 0) > 0 ? ` from ${months.short[play.versions[process.id]!.month]}` : ""}
                      </span>
                      <button type="button" aria-label={`Back to today's map for ${process.name}`} data-version-remove={process.id} onClick={() => choose(process.id, null)} className="rounded-full px-1.5 text-muted-foreground hover:bg-muted hover:text-foreground">
                        ✕
                      </button>
                    </li>
                  ))}
                </ul>
                <Button type="button" variant="outline" size="sm" data-versions-reset onClick={() => setPlay({ ...play, versions: {} })}>
                  Reset to today
                </Button>
              </>
            ) : (
              <span className="text-xs text-muted-foreground">Every process on today&apos;s version.</span>
            )}
          </div>

          {canvas ? canvas({ badges, onProcess }) : <EmptyState>No process has been published yet.</EmptyState>}
        </div>
      </section>

      {open && pick && (
        <Popover open onOpenChange={(o) => !o && setOpen(null)}>
          <PopoverAnchor asChild>
            <span aria-hidden className="pointer-events-none fixed" style={{ left: open.rect.left, top: open.rect.top, width: open.rect.width, height: open.rect.height }} />
          </PopoverAnchor>
          <PopoverContent side="bottom" align="start" collisionPadding={12} className="w-[min(20rem,calc(100vw-1.5rem))] gap-3 p-3" data-version-popover={pick.id} aria-label={`Version of ${pick.name}`}>
            <div className="font-heading text-sm font-semibold">{pick.name}</div>
            <div role="radiogroup" aria-label="Version" className="flex flex-col gap-1">
              {[{ id: null as string | null, name: "Today", status: null as (typeof pick.solutions)[number]["status"] | null }, ...pick.solutions.map((s) => ({ id: s.id as string | null, name: s.name, status: s.status }))].map((o) => {
                const checked = (picked?.solution ?? null) === o.id;
                const status = o.status ? SOLUTION_STATUS_OPTIONS.find((x) => x.value === o.status) : undefined;
                return (
                  <button
                    key={o.id ?? "today"}
                    type="button"
                    role="radio"
                    aria-checked={checked}
                    data-version-option={o.id ?? "today"}
                    onClick={() => choose(pick.id, o.id)}
                    className={cn("flex items-center justify-between gap-2 rounded-md border px-2.5 py-1.5 text-left text-sm hover:bg-muted", checked ? "border-accent bg-accent/5" : "border-line")}
                  >
                    <span className="min-w-0 truncate">{o.name}</span>
                    {status && <StatusPill label={status.label} tone={status.tone} value={status.value} />}
                  </button>
                );
              })}
            </div>
            {!pick.solutions.length && <p className="text-xs text-muted-foreground">No other map has been made for this process.</p>}
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              From
              <NativeSelect
                value={picked?.month ?? 0}
                disabled={!picked}
                data-version-month={pick.id}
                onChange={(e) => picked && setPlay({ ...play, versions: { ...play.versions, [pick.id]: { ...picked, month: Number(e.target.value) } } })}
              >
                {months.long.map((m, i) => (
                  <option key={i} value={i}>
                    {m}
                  </option>
                ))}
              </NativeSelect>
            </label>
          </PopoverContent>
        </Popover>
      )}
    </div>
  );
}
