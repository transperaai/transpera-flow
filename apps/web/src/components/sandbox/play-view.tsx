"use client";

// The free-play Sandbox (capacity build P7, docs/plans/capacity/p7-sandbox-brief.md; decisions D28 to D38; Q16), as one scrolling page: a toolbar
// (version, horizon, Reset, Export), then the company map full width (a click on a process loads another version of it), then the levers laid out
// horizontally in one band, then the results (the verdict and its figures, the charts, who's overloaded, where the time goes). Nothing is saved: the
// levers are this component's state and reset when you leave the page. Every lever change re-runs in the worker (debounced), against today's path, and the result charts follow.

import { useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { defaultPlay, monthKey, monthShort, playIsDefault, type CapacitySetup, type PlayState, type PurposeCategory } from "@transpera-flow/db";
import type { PreparedPlay } from "@transpera-flow/db/sandbox";
import { Help } from "@/components/help";
import { Button } from "@/components/ui/button";
import { PLAY_HELP } from "@/lib/sandbox/play-help";
import { usePlayRuns, type PlayRuns } from "@/lib/sandbox/use-play-runs";
import { PlayLevers } from "./play-levers";
import { PlayMapCard, type PlayMapApi } from "./play-map";
import { PlayResults } from "./play-results";
import { Segmented } from "./segmented";
import { PLAY_HORIZONS, type PlayHorizon, type PlayMonths, type PlayProcess } from "./play-types";
import { pageBodyClass } from "@/components/shell/page";

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
  processes: PlayProcess[];
  /** The workspace's purposes, for "Where the time goes" (the defaults when not given). */
  purposes?: readonly PurposeCategory[];
  /** The ISO date the run starts on. */
  startDate: string;
  /** How many months the run covers, and changing it (the filter above the charts). The page prepares every run for it. */
  horizon?: PlayHorizon;
  onHorizon?: (h: PlayHorizon) => void;
  /** Today's path, ready to run, and the way to prepare a run for the levers as they stand. */
  today: PreparedPlay;
  prepare: (play: PlayState) => PreparedPlay;
  /** The company map, drawn by the page: the run playing on it, the new-version badges and a click on a process (which opens its version popover). */
  map?: (runs: PlayRuns, api: PlayMapApi) => ReactNode;
  /** In the map section, above its summary line: what the company map version runs with (its notes). */
  mapHeader?: ReactNode;
  /** In the toolbar: the "Company map" version select. */
  versionSelect?: ReactNode;
  /** The Export menu for the run on screen. */
  exportSlot?: (state: { runs: PlayRuns; play: PlayState }) => ReactNode;
  /** `/w/<slug>`, for the link to Set up. */
  base?: string;
  /** An error that stops a run being built (the company can't be simulated yet), in plain words. */
  modelError?: string | null;
  /** The company map revision the changed path runs from when it isn't the live one (Q17); null for the live map. Another map moves the levers' path off today's. */
  mapKey?: string | null;
  /** A solution picked as its process's map version when the page opens (`?solution=<id>`, from "Try it in the Sandbox"), live from the first month. */
  initialSolution?: { id: string; processId: string } | null;
}

export function PlayView(props: PlayViewProps) {
  const { setup, processes, startDate, today, prepare, modelError, horizon = 12, onHorizon } = props;
  const [play, setPlay] = useState<PlayState>(() => {
    const start = defaultPlay();
    const pick = props.initialSolution;
    // Only a solution of a process this page lists can be picked (the select would have no option for it).
    return pick && processes.some((p) => p.id === pick.processId && p.solutions.some((s) => s.id === pick.id)) ? { ...start, versions: { [pick.processId]: { solution: pick.id, month: 0 } } } : start;
  });
  const months = useMemo(() => playMonths(startDate, horizon), [startDate, horizon]);
  const mapKey = props.mapKey ?? null;
  const runs = usePlayRuns(setup, play, today, prepare, mapKey);
  // The levers' month pickers stay on the first year; the charts follow the horizon.
  const leverMonths = useMemo(() => (horizon === 12 ? months : playMonths(startDate)), [horizon, months, startDate]);
  const moved = !playIsDefault(play) || mapKey !== null;
  const expectedWins = runs.today ? runs.today.run.result.kpi.won.mean / horizon : null;
  const busy = runs.status === "running";

  // One page that scrolls as a whole: a one-row toolbar, then the company map (the star, full width), the levers band and the results, top to bottom,
  // in the page's gutter. A phone gets the same order.
  return (
    <div
      className="flex min-w-0 flex-col"
      data-sandbox-play
      data-moved={moved ? "true" : "false"}
      data-run-ms={runs.changed ? Math.round(runs.changed.ms) : undefined}
    >
      <div role="toolbar" aria-label="Sandbox actions" className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-line bg-panel px-4 py-2 sm:px-6" data-play-toolbar>
        <h1 className="inline-flex items-center text-base font-semibold">
          Sandbox
          <Help label="Sandbox" description={NOTE} example="Load the automated version of Reporting from March, add two clients a month and see whether the team copes." />
        </h1>
        {props.versionSelect}
        <div className="flex items-center gap-2" data-play-horizon>
          <span className="text-xs text-muted-foreground" id="play-horizon-label">
            Months ahead
          </span>
          <Segmented
            aria-labelledby="play-horizon-label"
            value={horizon}
            disabled={!onHorizon || busy}
            onChange={(h) => onHorizon?.(h)}
            options={PLAY_HORIZONS.map((h) => ({ value: h, label: h, attrs: { "data-play-horizon-option": h } }))}
          />
          <Help {...PLAY_HELP.horizon} />
        </div>
        <span className="flex-1" />
        <Button type="button" variant="outline" size="sm" onClick={() => setPlay(defaultPlay())} data-play-reset>
          Reset levers
        </Button>
        {props.exportSlot?.({ runs, play })}
      </div>
      {modelError && (
        <div role="alert" data-model-error className="shrink-0 border-b border-crit bg-crit-soft px-4 py-2 text-sm sm:px-6">
          The company can&apos;t be simulated yet: {modelError}
        </div>
      )}

      <div className={pageBodyClass()}>
        <PlayMapCard play={play} setPlay={setPlay} processes={processes} months={leverMonths} header={props.mapHeader} canvas={props.map ? (api) => props.map!(runs, api) : undefined} />
        <div className="min-w-0" data-play-levers-column>
          <PlayLevers
            play={play}
            setPlay={setPlay}
            setup={setup}
            months={leverMonths}
            expectedWinsPerMonth={expectedWins}
            note={
              props.base && (
                <p className="text-xs text-muted-foreground">
                  Baselines, tiers, salaries and utilisation thresholds are set in{" "}
                  <Link href={`${props.base}/settings#people-roles`} className="font-medium text-accent hover:underline">
                    Settings
                  </Link>
                  . Every baseline there is a lever here.
                </p>
              )
            }
          />
        </div>
        <div className="mt-1 min-w-0">
          <PlayResults runs={runs} setup={setup} months={months} moved={moved} purposes={props.purposes} horizon={horizon} />
        </div>
      </div>
    </div>
  );
}

/** What the Sandbox is, behind the (i) in the toolbar. */
const NOTE =
  "Load another map for a process (an automation is part of a version of it) and pull the levers under the map, then watch the months ahead change below. Nothing here is saved and nothing touches live data: the levers reset when you leave.";
