"use client";

// "When" (docs/plans/sandbox-p5-brief.md §6.4): the month capacity runs out in the run on screen, and, for Agency admins and the Owner, the
// month each hire pays for itself. The capacity line is read from the run already made. A payback needs one more run per hire (the scenario
// without it, often the live run, which is free), so it is made on request. Means only: the line says "on average".

import { useMemo, useState } from "react";
import type { ProcessBundle, SandboxChange, SolutionRow } from "@transpera-flow/db";
import { monthBounds, monthIndexOfDate, fromDate, type EffectiveChange } from "@transpera-flow/db/sandbox";
import type { EngineModel, MonthlyResult } from "@transpera-flow/engine";
import { Help } from "@/components/help";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { SANDBOX_HELP } from "@/lib/forecast/help";
import type { TimelineMonth } from "@/lib/forecast/timeline";
import { horizonLabel } from "@/lib/horizon";
import { describeChange, whenOf, type DescribeContext } from "@/lib/sandbox/describe";
import { capacityLine, capacityRunsOut, paybackLine, paybackMonth } from "@/lib/sandbox/timing";
import { useScenarioRun } from "@/lib/sandbox/use-scenario-run";

const SECTION_TITLE = "font-heading text-lg leading-snug font-semibold tracking-tight";
/** Most hires worked out at once (the hook is called this many times; a slot with nothing to do stays idle). */
export const MAX_PAYBACKS = 4;

/** The changes a payback is worked out for: each hire (D1) and each headcount increase (D5 adding people). */
export function hireChanges(changes: readonly EffectiveChange[]): EffectiveChange[] {
  return changes.filter((e) => e.change.lever === "D1" || (e.change.lever === "D5" && e.change.op === "add" && e.change.value > 0)).slice(0, MAX_PAYBACKS);
}

export interface TimingProps {
  /** The run on screen. */
  monthly: MonthlyResult;
  months: TimelineMonth[];
  model: EngineModel;
  roleNames: Readonly<Record<string, string>>;
  cutoffs: readonly [number, number, number];
  horizonMonths: number;
  /** Offers the 24 month run when the horizon is shorter (the page's horizon picker). */
  onLonger?: (months: number) => void;
  /** The scenario's effective changes on screen ([] with none open), and what a payback needs to run the scenario without one. */
  changes: readonly EffectiveChange[];
  live: ProcessBundle;
  solutions: readonly SolutionRow[];
  startDate: string;
  ctx: Omit<DescribeContext, "changes">;
  currency: string;
  /** Agency admins and the Owner: a payback needs profit, which a Viewer's runs don't have. */
  canSeeMoney: boolean;
  /** A share link's visitor: only the capacity line (no payback, and no sentence about who sees one). */
  capacityOnly?: boolean;
}

export function Timing(p: TimingProps) {
  const out = useMemo(() => capacityRunsOut(p.monthly, p.roleNames, p.cutoffs), [p.monthly, p.roleNames, p.cutoffs]);
  const label = horizonLabel(p.horizonMonths);
  const hires = useMemo(() => hireChanges(p.changes), [p.changes]);
  const [asked, setAsked] = useState(false);
  // The scenario without each hire, one list per slot; a fixed number of hook calls below, and a slot with no hire (or before the button
  // is pressed) stays idle. Only profit is read, so a price rise's paired run is skipped: one scenario run per hire. The lists are kept while the changes are the same, so a re-render doesn't start a run again.
  const lists = useMemo(
    () => Array.from({ length: MAX_PAYBACKS }, (_, i) => (asked && hires[i] ? p.changes.filter((e) => e.change.id !== hires[i]!.change.id) : null)),
    [asked, hires, p.changes],
  );
  const r0 = useScenarioRun({ bundle: p.live, changes: lists[0] ?? null, solutions: p.solutions, months: p.horizonMonths, startDate: p.startDate, pair: false });
  const r1 = useScenarioRun({ bundle: p.live, changes: lists[1] ?? null, solutions: p.solutions, months: p.horizonMonths, startDate: p.startDate, pair: false });
  const r2 = useScenarioRun({ bundle: p.live, changes: lists[2] ?? null, solutions: p.solutions, months: p.horizonMonths, startDate: p.startDate, pair: false });
  const r3 = useScenarioRun({ bundle: p.live, changes: lists[3] ?? null, solutions: p.solutions, months: p.horizonMonths, startDate: p.startDate, pair: false });
  const runs = [r0, r1, r2, r3];
  const profit = p.monthly.money?.profit ?? null;
  const bounds = useMemo(() => monthBounds(p.monthly.months.slice(1).map((m) => m.start), p.monthly.months[p.monthly.months.length - 1]!.end), [p.monthly]);
  const hpw = p.model.hoursPerWeek;
  const fromMonthOf = (c: SandboxChange): number => (c.from ? monthIndexOfDate(fromDate(c.from), p.startDate, bounds, hpw) : 0);
  const working = asked && runs.slice(0, hires.length).some((r) => r.status === "running" || r.status === "idle");

  return (
    <section className="flex min-w-0 flex-col gap-2" data-when-section>
      <h2 className={`${SECTION_TITLE} flex items-center`}>
        When
        <Help {...SANDBOX_HELP.whenSection} />
      </h2>
      <Card className="gap-1 px-4 py-3 text-sm" data-capacity-line={out ? "runs-out" : "holds"}>
        <p>{capacityLine(out, p.months, label)}</p>
        {!out && p.horizonMonths < 24 && p.onLonger ? (
          <p className="text-muted-foreground">
            <button type="button" className="underline" onClick={() => p.onLonger!(24)} data-when-longer>
              Look 24 months ahead
            </button>
          </p>
        ) : null}
        <p className="text-xs text-muted-foreground">On average, with the growth, seasons and market you have set; the alerts above also say when in a bad month.</p>
      </Card>
      {hires.length && !p.capacityOnly ? (
        p.canSeeMoney && profit ? (
          <Card className="gap-2 px-4 py-3 text-sm" data-payback>
            {!asked ? (
              <div className="flex flex-wrap items-center gap-3">
                <Button type="button" variant="outline" size="sm" onClick={() => setAsked(true)} data-payback-ask>
                  Work out when each hire pays for itself
                </Button>
                <span className="text-xs text-muted-foreground">Runs the scenario once without each hire, to see what it adds to profit.</span>
              </div>
            ) : (
              <ul className="flex flex-col gap-1" aria-live="polite" data-payback-list>
                {hires.map((e, i) => {
                  const r = runs[i]!;
                  const other = r.status === "done" ? r.run?.result.monthly?.money?.profit : null;
                  const name = `${describeChange(e.change, { ...p.ctx, changes: p.changes.map((x) => x.change) })} ${whenOf(e.change) ?? ""}`.trim();
                  return (
                    <li key={e.change.id} data-payback-change={e.change.id}>
                      {r.status === "error" ? (
                        <span>
                          {name}: couldn&apos;t be worked out ({r.error}).
                        </span>
                      ) : other ? (
                        <span>
                          {name}: {paybackLine(paybackMonth(profit, other, fromMonthOf(e.change)), p.months, p.currency, label)}.
                        </span>
                      ) : (
                        <span className="text-muted-foreground">{name}: working it out…</span>
                      )}
                    </li>
                  );
                })}
                {working ? null : <li className="text-xs text-muted-foreground">Means over 30 runs, with and without the hire; no range.</li>}
              </ul>
            )}
          </Card>
        ) : (
          <p className="text-sm text-muted-foreground" data-payback-viewer>
            When a hire pays for itself is shown to Agency admins and the Owner.
          </p>
        )
      ) : null}
    </section>
  );
}
