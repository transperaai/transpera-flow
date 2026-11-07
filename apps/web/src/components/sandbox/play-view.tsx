"use client";

// The free-play Sandbox (capacity build P7, docs/plans/capacity/p7-sandbox-brief.md; decisions D28 to D38; Q16): the company map on top (click a process to
// load another version of it), the levers on the left (automations among them), the results on the right. Nothing is saved: the levers are this component's state and reset
// when you leave the page. Every lever change re-runs in the worker (debounced), against today's path, and the verdict and four charts follow.

import { useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { defaultPlay, monthKey, monthShort, playIsDefault, type CapacityChangeInput, type CapacityChangeRow, type CapacitySetup, type PlayState } from "@transpera-flow/db";
import type { PreparedPlay } from "@transpera-flow/db/sandbox";
import { MetaLine, PageHeader } from "@/components/page-kit";
import { usePlayRuns, type PlayRuns } from "@/lib/sandbox/use-play-runs";
import type { DeleteChangeResult, SaveChangeResult } from "@/app/w/[slug]/capacity-change-actions";
import { PlayChangeDialog } from "./play-change-dialog";
import { PlayLevers } from "./play-levers";
import { PlayMapCard, type PlayMapApi } from "./play-map";
import { PlayResults } from "./play-results";
import type { PlayMonths, PlayProcess } from "./play-types";

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function playMonths(startDate: string, n = 12): PlayMonths {
  const long: string[] = [];
  const short: string[] = [];
  for (let i = 0; i < n; i++) {
    const key = monthKey(startDate, i);
    long.push(`${MONTH_NAMES[Number(key.slice(5, 7)) - 1]} ${key.slice(0, 4)}`);
    short.push(monthShort(startDate, i));
  }
  return { long, short };
}

export interface PlayViewProps {
  setup: CapacitySetup;
  /** The workspace's changes. */
  library: CapacityChangeRow[];
  processes: PlayProcess[];
  /** The ISO date the run starts on. */
  startDate: string;
  /** Today's path, ready to run, and the way to prepare a run for the levers as they stand. */
  today: PreparedPlay;
  prepare: (play: PlayState, library: readonly CapacityChangeRow[]) => PreparedPlay;
  /** The company map, drawn by the page: the run playing on it, the new-version badges and a click on a process (which opens its version popover). */
  map?: (runs: PlayRuns, api: PlayMapApi) => ReactNode;
  /** Agency admins and the Owner: add, edit and remove changes. */
  canEdit: boolean;
  saveChange?: (id: string | null, input: CapacityChangeInput) => Promise<SaveChangeResult>;
  removeChange?: (id: string) => Promise<DeleteChangeResult>;
  /** The Export menu for the run on screen. */
  exportSlot?: (state: { runs: PlayRuns; play: PlayState }) => ReactNode;
  /** `/w/<slug>`, for the link to Set up. */
  base?: string;
  /** An error that stops a run being built (the company can't be simulated yet), in plain words. */
  modelError?: string | null;
  /** A solution picked as its process's map version when the page opens (`?solution=<id>`, from "Try it in the Sandbox"), live from the first month. */
  initialSolution?: { id: string; processId: string } | null;
}

export function PlayView(props: PlayViewProps) {
  const { setup, processes, startDate, today, prepare, canEdit, modelError } = props;
  const [play, setPlay] = useState<PlayState>(() => {
    const start = defaultPlay();
    const pick = props.initialSolution;
    // Only a solution of a process this page lists can be picked (the select would have no option for it).
    return pick && processes.some((p) => p.id === pick.processId && p.solutions.some((s) => s.id === pick.id)) ? { ...start, versions: { [pick.processId]: { solution: pick.id, month: 0 } } } : start;
  });
  const [library, setLibrary] = useState(props.library);
  const [dialog, setDialog] = useState<{ existing: CapacityChangeRow | null } | null>(null);
  const months = useMemo(() => playMonths(startDate), [startDate]);
  const runs = usePlayRuns(setup, play, library, today, prepare);
  const moved = !playIsDefault(play);
  const expectedWins = runs.today ? runs.today.run.result.kpi.won.mean / 12 : null;
  const tiers = setup.tiers.map((t) => ({ key: t.key, name: t.name }));

  return (
    <div className="flex min-w-0 flex-col gap-6" data-sandbox-play data-moved={moved ? "true" : "false"} data-run-ms={runs.changed ? Math.round(runs.changed.ms) : undefined}>
      <PageHeader
        label="Sandbox"
        eyebrow={<span className="text-2xs font-semibold tracking-wider text-muted-foreground uppercase">Company</span>}
        title="Sandbox"
        meta={
          <MetaLine>
            <span data-play-note>Load another map for a process, switch automations on and pull the levers, then watch the next 12 months change. Nothing here is saved and nothing touches live data: the levers reset when you leave.</span>
          </MetaLine>
        }
        actionsLabel="Sandbox actions"
        actions={props.exportSlot?.({ runs, play })}
      />
      {modelError && (
        <div role="alert" data-model-error className="rounded-token border border-crit bg-crit-soft p-3 text-sm">
          The company can&apos;t be simulated yet: {modelError}
        </div>
      )}
      <PlayMapCard play={play} setPlay={setPlay} processes={processes} months={months} canvas={props.map ? (api) => props.map!(runs, api) : undefined} />

      <div className="grid min-w-0 items-start gap-4 lg:grid-cols-[22rem_minmax(0,1fr)]">
        <div className="min-w-0 lg:sticky lg:top-4 lg:max-h-[calc(100vh-2rem)] lg:overflow-y-auto" data-play-levers-column>
          <PlayLevers
            play={play}
            setPlay={setPlay}
            setup={setup}
            months={months}
            expectedWinsPerMonth={expectedWins}
            library={library}
            processes={processes}
            canEdit={canEdit}
            onAddChange={() => setDialog({ existing: null })}
            onEditChange={(c) => setDialog({ existing: c })}
          />
        </div>
        <PlayResults runs={runs} setup={setup} months={months} moved={moved} />
      </div>

      {props.base && (
        <p className="text-xs text-muted-foreground">
          Baselines, tiers, salaries and lines are set in{" "}
          <Link href={`${props.base}/setup/people`} className="font-medium text-accent hover:underline">
            Set up
          </Link>
          . Every baseline there is a lever here.
        </p>
      )}

      {dialog && canEdit && props.saveChange && (
        <PlayChangeDialog
          existing={dialog.existing}
          processes={processes}
          tiers={tiers}
          onClose={() => setDialog(null)}
          onSave={async (input) => {
            const r = await props.saveChange!(dialog.existing?.id ?? null, input);
            if (r.status === "error") return r.message;
            setLibrary((rows) => (dialog.existing ? rows.map((x) => (x.id === r.change.id ? r.change : x)) : [...rows, r.change]));
            setDialog(null);
            return null;
          }}
          onRemove={
            dialog.existing && props.removeChange
              ? async () => {
                  const id = dialog.existing!.id;
                  const r = await props.removeChange!(id);
                  if (r.status === "error") return r.message;
                  setLibrary((rows) => rows.filter((x) => x.id !== id));
                  // A block that was swapped in goes with the change.
                  setPlay((p) => {
                    if (p.blocks[id] === undefined) return p;
                    const blocks = { ...p.blocks };
                    delete blocks[id];
                    return { ...p, blocks };
                  });
                  setDialog(null);
                  return null;
                }
              : undefined
          }
        />
      )}
    </div>
  );
}
