"use client";

// The Editor's footer (issue #104): after ▶ Simulate, "Compared with live": each headline measure as live → draft.

import type { EngineModel, SimulationResult } from "@transpera-flow/engine";
import { Help } from "@/components/help";
import { compareRuns } from "@/lib/drafts/compare";
import type { SolutionIssue } from "@/lib/solutions/area";
import type { TargetVerdict } from "@/lib/solutions/verdict";

export interface SimulatedPair {
  live: { model: EngineModel; result: SimulationResult | null } | null;
  draft: { model: EngineModel; result: SimulationResult | null };
}

export function SimulateFooter({
  asked,
  pair,
  failed,
  stale,
  currency,
  liveNumber,
  solution = false,
  verdict = null,
  incomplete = 0,
}: {
  /** Simulate has been pressed. */
  asked: boolean;
  pair: SimulatedPair | null;
  /** What went wrong, if a run failed. */
  failed: string | null;
  /** The draft has changed since the run, so the numbers describe an older version. */
  stale: boolean;
  currency: string;
  liveNumber: number;
  /** Solution mode (A49): the second number is the solution's, and the footer says how it did against the issue's target. */
  solution?: boolean;
  verdict?: { issue: SolutionIssue; result: TargetVerdict } | null;
  /** How many things are still missing for simulation (issue #167): the numbers above say so while any remain. */
  incomplete?: number;
}) {
  const what = solution ? "solution" : "draft";
  const rows = pair?.live?.result && pair.draft.result ? compareRuns({ model: pair.live.model, result: pair.live.result }, { model: pair.draft.model, result: pair.draft.result }, currency) : null;
  return (
    <footer aria-label="Compared with live" className="flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-line bg-panel px-4 py-2.5">
      {!asked ? (
        <span className="text-xs text-muted-foreground">Press Simulate to run this {solution ? "solution" : "version"} 30 times and compare it with live.</span>
      ) : failed ? (
        <span role="alert" className="text-xs text-crit">
          Couldn&apos;t simulate: {failed}
        </span>
      ) : pair && !pair.live ? (
        <span className="text-xs text-muted-foreground">Nothing is live yet, so there is nothing to compare with.</span>
      ) : !rows ? (
        <span role="status" className="text-xs text-muted-foreground">
          Simulating 30 times…
        </span>
      ) : (
        <>
          <span className="flex items-center text-[11px] font-semibold tracking-wider text-fg-2 uppercase">
            {solution ? `Live → solution (live is v${liveNumber})` : `Compared with live (v${liveNumber})`}
            <Help
              label="Compared with live"
              description="Each measure shows the live version's number, then this draft's or solution's. Green means better, red means worse. Both runs use the same random draws, so the change comes from your edits."
              example="Cycle time 9.6 d → 8.1 d means leads reach a decision about a day and a half sooner."
            />
          </span>
          <ul className="flex min-w-0 flex-1 gap-5 overflow-x-auto">
            {rows.map((r) => (
              <li key={r.label} className="flex shrink-0 flex-col gap-px border-r border-line pr-5 last:border-r-0">
                <span className="text-xs text-muted-foreground">{r.label}</span>
                <b className="font-mono text-sm font-medium tabular-nums">
                  {r.live} → <span className={r.better === true ? "text-good" : r.better === false ? "text-crit" : ""}>{r.draft}</span>
                  {r.better !== null && <span className="sr-only">{r.better ? " (better)" : " (worse)"}</span>}
                </b>
              </li>
            ))}
          </ul>
          {verdict && (
            <span className="flex basis-full flex-wrap items-center gap-x-2 text-xs" data-testid="auto-verdict">
              <span className="flex items-center font-semibold">
                Automatic verdict
                <Help
                  label="Automatic verdict"
                  description="Pass or fail against the issue's target, worked out from the simulation, with how many of the 30 runs meet the goal. It is a first opinion: you make the final call after saving."
                  example="Pass, holds in 97% means 29 of the 30 runs (97%) got first contact under the 4 hour goal."
                />
              </span>
              <b className={verdict.result.status === "pass" ? "text-good" : verdict.result.status === "fail" ? "text-crit" : "text-muted-foreground"}>
                {verdict.result.status === "pass" ? "Pass" : verdict.result.status === "fail" ? "Fail" : "Not checked"}
                {verdict.result.holdsPct !== null ? `, holds in ${verdict.result.holdsPct}%` : ""}
              </b>
              <span className="text-muted-foreground">{verdict.result.note}</span>
            </span>
          )}
          {incomplete > 0 && (
            <span role="note" data-incomplete-data className="basis-full text-xs text-fg-2">
              Based on incomplete data: {incomplete} {incomplete === 1 ? "thing is" : "things are"} still missing for simulation (see the warning above the map).
            </span>
          )}
          {stale && <span className="text-xs text-warn">You&apos;ve changed the {what} since. Simulate again.</span>}
        </>
      )}
    </footer>
  );
}
