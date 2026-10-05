"use client";

// The panels the process page's Supporting data adds (issue #174), beside "Wait before each step" and "How busy each role
// is": the time split per step, the cycle time spread, key-person risk and the rework loops. Each reads the latest run. No
// (i)s: the headings and a line under each say what it is.

import Link from "next/link";
import type { ReactNode } from "react";
import type { SimulationResult } from "@transpera-flow/engine";
import { formatDays, formatHours, formatNumber, formatPercent } from "@/lib/format";
import { issueHref } from "@/lib/issues/pages";
import type { CycleSpread, KeyPersonRow, LoopRow, TimeSplitRow } from "@/lib/process-page/supporting";
import { solutionHref } from "@/lib/solutions/cards";

const card = "min-w-0 rounded-token border border-line bg-panel p-3 shadow-token";

function Panel({ id, title, note, children }: { id: string; title: string; note: string; children: ReactNode }) {
  return (
    <section aria-labelledby={`${id}-heading`} className={card} data-panel={id}>
      <h3 id={`${id}-heading`} className="text-sm font-bold">
        {title}
      </h3>
      <p className="mb-2 text-xs text-fg-3">{note}</p>
      {children}
    </section>
  );
}

const Waiting = ({ result }: { result: SimulationResult | null }) => <p className="text-sm text-fg-2">{result ? "Nothing to show for this run." : "Simulating…"}</p>;

/** Hands-on time against waiting, per step: one bar a step, hands-on in the brand colour and the waits in greys. */
export function TimeSplit({ rows, result }: { rows: TimeSplitRow[]; result: SimulationResult | null }) {
  const max = Math.max(1e-9, ...rows.map((r) => r.total));
  return (
    <Panel id="time-split" title="Time split per step" note="Hands-on work against waiting, for one visit to the step.">
      {rows.length === 0 ? (
        <Waiting result={result} />
      ) : (
        <>
          <ul className="flex flex-col gap-2">
            {rows.map((r) => (
              <li
                key={r.id}
                className="grid grid-cols-[7rem_1fr_4.5rem] items-center gap-2 sm:grid-cols-[9.5rem_1fr_4.5rem]"
                aria-label={`${r.label}: ${formatHours(r.handsOn)} hands-on, ${formatHours(r.waitingForPerson)} waiting for a person, ${formatHours(r.fixedWait)} waiting on others, ${formatPercent(r.handsOnShare)} hands-on`}
              >
                <span className="truncate">{r.label}</span>
                <span aria-hidden className="flex h-3 gap-0.5" style={{ width: `${Math.max(2, (r.total / max) * 100)}%` }}>
                  {(
                    [
                      [r.handsOn, "bg-accent"],
                      [r.waitingForPerson, "bg-fg-3/60"],
                      [r.fixedWait, "bg-line-2"],
                    ] as const
                  ).map(([h, bg], i) =>
                    h > 0 ? <span key={i} className={`block h-full min-w-px rounded-sm ${bg}`} style={{ flexGrow: h, flexBasis: 0 }} /> : null,
                  )}
                </span>
                <span className="text-right text-xs tabular-nums">
                  {formatHours(r.total)}
                  <span className="block text-fg-3">{formatPercent(r.handsOnShare)} work</span>
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-fg-3">
            <Key className="bg-accent" label="Hands-on" />
            <Key className="bg-fg-3/60" label="Waiting for a person" />
            <Key className="bg-line-2" label="Waiting on others" />
          </p>
        </>
      )}
    </Panel>
  );
}

const Key = ({ className, label }: { className: string; label: string }) => (
  <span className="inline-flex items-center gap-1">
    <i aria-hidden className={`size-2 rounded-sm ${className}`} />
    {label}
  </span>
);

/** The typical (median) and slow (90th percentile) time from start to finish. */
export function CycleSpreadPanel({ spread, hoursPerWeek, result }: { spread: CycleSpread | null; hoursPerWeek: number; result: SimulationResult | null }) {
  return (
    <Panel id="cycle-spread" title="Cycle time spread" note="How long an item takes from start to finish.">
      {!spread ? (
        <Waiting result={result} />
      ) : (
        <>
          <ul className="flex flex-col gap-2">
            {(
              [
                ["Typical (median)", spread.p50, "bg-accent"],
                ["Slow (90th percentile)", spread.p90, "bg-fg-3/60"],
              ] as const
            ).map(([label, h, bg]) => (
              <li key={label} className="grid grid-cols-[10.5rem_1fr_3.5rem] items-center gap-2" aria-label={`${label}: ${formatDays(h, hoursPerWeek)}`}>
                <span className="truncate">{label}</span>
                <span aria-hidden className="h-3 overflow-hidden rounded-sm bg-panel-2">
                  <span className={`block h-full rounded-sm ${bg}`} style={{ width: `${Math.max(1, (h / spread.p90) * 100)}%` }} />
                </span>
                <span className="text-right tabular-nums">{formatDays(h, hoursPerWeek)}</span>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-fg-3">
            {spread.ratio >= 1.05 ? `A slow item takes ${formatNumber(spread.ratio, 1)} times as long as a typical one.` : "Slow items take about as long as typical ones."}
          </p>
        </>
      )}
    </Panel>
  );
}

/** Steps only one person can do. */
export function KeyPersonPanel({ rows, result }: { rows: KeyPersonRow[]; result: SimulationResult | null }) {
  return (
    <Panel id="key-person" title="Key-person risk per step" note="Steps only one person can do. If they are away, the work stops.">
      {!result ? (
        <Waiting result={result} />
      ) : rows.length === 0 ? (
        <p className="text-sm text-fg-2">No step depends on one person.</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {rows.map((r) => (
            <li key={r.id} className="flex flex-wrap items-baseline justify-between gap-x-3 text-sm" data-key-person={r.id}>
              <span className="min-w-0 truncate">{r.step}</span>
              {r.person ? <span className="font-medium">{r.person}</span> : <span className="font-medium text-crit">Nobody can do it</span>}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

/** One row per loop: where work goes round, how often, and what it costs. */
export function ReworkLoopsPanel({
  rows,
  result,
  hoursPerWeek,
  base,
}: {
  rows: LoopRow[];
  result: SimulationResult | null;
  hoursPerWeek: number;
  /** `/w/<slug>` or `/demo`, for the links to issues and solutions. */
  base: string;
}) {
  return (
    <Panel id="rework-loops" title="Rework loops" note="Places where work goes back to a step it has already been through, and what that costs.">
      {!result ? (
        <Waiting result={result} />
      ) : rows.length === 0 ? (
        <p className="text-sm text-fg-2">Nothing goes back to an earlier step.</p>
      ) : (
        <ul className="flex flex-col gap-2" data-testid="rework-loops">
          {rows.map((r) => (
            <li key={r.id} data-loop={r.id} className="rounded-lg border border-line p-2.5">
              <p className="text-sm font-semibold">{r.title}</p>
              {r.steps.length > 1 && <p className="text-xs text-fg-3">Steps in the loop: {r.steps.join(" › ")}</p>}
              <dl className="mt-1.5 grid grid-cols-2 gap-x-3 gap-y-1 text-sm sm:grid-cols-3">
                <Fact label="Goes round" value={r.share.mean > 0 ? formatPercent(r.share.mean) : "Rarely"} sub={r.meanRounds.mean > 0 ? `${formatNumber(r.meanRounds.mean, 1)} times each` : undefined} />
                <Fact label="Extra work" value={`${formatNumber(r.hoursPerMonth.mean, r.hoursPerMonth.mean < 10 ? 1 : 0)} h a month`} />
                <Fact label="Adds to cycle" value={formatDays(r.extraCycleHours.mean, hoursPerWeek)} sub="per item" />
              </dl>
              {(r.issues.length > 0 || r.solutions.length > 0) && (
                <p className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-xs text-fg-2">
                  {r.issues.map((i) => (
                    <Link key={i.id} href={issueHref(base, i)} className="hover:underline">
                      Issue: {i.label}
                    </Link>
                  ))}
                  {r.solutions.map((s) => (
                    <Link key={s.id} href={solutionHref(base, s.id)} className="hover:underline">
                      Solution: {s.name}
                    </Link>
                  ))}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

const Fact = ({ label, value, sub }: { label: string; value: string; sub?: string }) => (
  <div className="min-w-0">
    <dt className="text-xs text-fg-3">{label}</dt>
    <dd className="tabular-nums">
      {value}
      {sub && <span className="block text-xs text-fg-3">{sub}</span>}
    </dd>
  </div>
);
