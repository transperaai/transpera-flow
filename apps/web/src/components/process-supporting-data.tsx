"use client";

// The process page's Supporting data (issue #174; capacity-shaped in Q3), each panel reading the latest run: the headline (what this
// process takes, in hours a month), the hours by role and by person, the heaviest steps, the time split per step, and key-person
// risk. No (i)s: the headings and a line under each say what it is.

import { useState, type CSSProperties, type ReactNode } from "react";
import type { Viewer } from "@transpera-flow/db";
import type { SimulationResult } from "@transpera-flow/engine";
import { Skeleton } from "@/components/ui/skeleton";
import { SplitBar, SplitLegend } from "@/components/split-bar";
import { formatHours, formatPercent } from "@/lib/format";
import { headlineText, type ProcessHeadline, type ProcessHours } from "@/lib/process-page/hours";
import type { KeyPersonRow, TimeSplitRow } from "@/lib/process-page/supporting";
import { ownRowsOnly, viewerOf } from "@/lib/viewer";

const card = "flex h-full min-w-0 flex-col rounded-lg bg-muted/40 p-4";

/** A titled panel with a one-line description, the same on every part of the "What the run shows" card (Q8). */
export function Panel({ id, title, note, children }: { id: string; title: string; note: string; children: ReactNode }) {
  return (
    <section aria-labelledby={`${id}-heading`} className={card} data-panel={id}>
      <h3 id={`${id}-heading`} className="text-sm font-bold">
        {title}
      </h3>
      <p className="mb-3 text-xs text-fg-3">{note}</p>
      {children}
    </section>
  );
}

const Waiting = ({ result }: { result: SimulationResult | null }) => (
  <div className="flex flex-col gap-2">
    {!result && (
      <div aria-hidden className="flex flex-col gap-2">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-4 w-full" />
        ))}
      </div>
    )}
    <p className="text-sm text-fg-2">{result ? "Nothing to show for this run." : "Simulating…"}</p>
  </div>
);

/** Whole hours a month, with one decimal under 10. */
const hoursMonth = (h: number) => `${h < 10 ? h.toLocaleString("en-GB", { maximumFractionDigits: 1 }) : Math.round(h).toLocaleString("en-GB")} h`;

/** The answer first: what this process takes, how much of its department's time that is, and how much of it could be automated. */
export function SupportingHeadline({ headline, result }: { headline: ProcessHeadline | null; result: SimulationResult | null }) {
  return (
    <p className="font-display text-xl leading-snug font-semibold text-balance sm:text-2xl" data-supporting-headline>
      {headline ? headlineText(headline) : <span className="text-sm font-normal text-fg-2">{result ? "No work reached a step in this run." : "Simulating…"}</span>}
    </p>
  );
}

/** Hours a month by role, each opening to the people who carry them. */
export function HoursByRole({ hours, result, viewer }: { hours: ProcessHours | null; result: SimulationResult | null; viewer?: Viewer }) {
  const seen = viewerOf({ viewer });
  const max = Math.max(1e-9, ...(hours?.roles.map((r) => r.hours) ?? []));
  return (
    <Panel id="hours-by-role" title="Hours a month, by role and person" note="Who carries this process's hands-on work. Open a role to see its people.">
      {!hours || hours.roles.length === 0 ? (
        <Waiting result={result} />
      ) : (
        <>
          <p className="mb-2 text-sm font-semibold tabular-nums" data-hours-total>
            {hoursMonth(hours.total)} a month
          </p>
          <ul className="flex flex-col gap-1.5">
            {hours.roles.map((r) => (
              <li key={r.id ?? "none"} data-role-hours={r.id ?? "none"}>
                <details className="group">
                  <summary
                    className="grid cursor-pointer list-none grid-cols-[7rem_1fr_4rem] items-center gap-2 sm:grid-cols-[9.5rem_1fr_4rem] [&::-webkit-details-marker]:hidden"
                    aria-label={`${r.label}: ${hoursMonth(r.hours)} a month, ${r.people.length} ${r.people.length === 1 ? "person" : "people"}`}
                  >
                    <span className="truncate">{r.label}</span>
                    <span aria-hidden className="h-3 overflow-hidden rounded-sm bg-panel-2">
                      <span className="block h-full bg-accent" style={{ width: `${Math.max(1, (r.hours / max) * 100)}%` }} />
                    </span>
                    <span className="text-right text-xs tabular-nums">{hoursMonth(r.hours)}</span>
                  </summary>
                  <ul className="mt-1 mb-1.5 flex flex-col gap-1 pl-3">
                    {ownRowsOnly(seen, r.people, (p) => p.id).map((p) => (
                      <li key={p.id} className="grid grid-cols-[6rem_1fr_4rem] items-center gap-2 text-xs sm:grid-cols-[8.5rem_1fr_4rem]">
                        <span className="truncate">{p.name}</span>
                        <span aria-hidden className="h-2 overflow-hidden rounded-sm bg-panel-2">
                          <span className="block h-full bg-fg-3/70" style={{ width: `${Math.max(1, (p.hours / r.hours) * 100)}%` }} />
                        </span>
                        <span className="text-right tabular-nums">{hoursMonth(p.hours)}</span>
                      </li>
                    ))}
                  </ul>
                </details>
              </li>
            ))}
          </ul>
        </>
      )}
    </Panel>
  );
}

/** How many steps the heaviest-steps panel shows before "Show all". */
export const HEAVIEST_SHOWN = 10;

/** Steps ranked by hours a month, each with its work split. */
export function HeaviestSteps({ hours, result, limit = HEAVIEST_SHOWN }: { hours: ProcessHours | null; result: SimulationResult | null; limit?: number }) {
  const [all, setAll] = useState(false);
  const rows = hours?.steps ?? [];
  const shown = all ? rows : rows.slice(0, limit);
  const max = Math.max(1e-9, ...rows.map((r) => r.hours));
  return (
    <Panel id="heaviest-steps" title="Heaviest steps" note="Steps ranked by hours a month, with how much of each could be automated, helped or stays manual.">
      {rows.length === 0 ? (
        <Waiting result={result} />
      ) : (
        <>
          <ul className="flex flex-col gap-2">
            {shown.map((r) => (
              <li key={r.id} data-heavy-step={r.id} className="grid grid-cols-[6.5rem_1fr_3.5rem] items-center gap-2">
                <span className="truncate" title={r.label}>
                  {r.label}
                </span>
                <span className="flex min-w-0 flex-col gap-1">
                  <span aria-hidden className="h-2 overflow-hidden rounded-sm bg-panel-2">
                    <span className="block h-full bg-accent" style={{ width: `${Math.max(1, (r.hours / max) * 100)}%` }} />
                  </span>
                  {r.split ? <SplitBar split={r.split} /> : <span className="text-xs text-fg-3">No work split yet</span>}
                </span>
                <span className="text-right text-xs tabular-nums">{hoursMonth(r.hours)}</span>
              </li>
            ))}
          </ul>
          <SplitLegend className="mt-2" />
          {rows.length > limit && (
            <button type="button" aria-expanded={all} onClick={() => setAll((v) => !v)} className="mt-1 text-xs font-medium text-accent hover:underline">
              {all ? "Show fewer" : `Show all ${rows.length}`}
            </button>
          )}
        </>
      )}
    </Panel>
  );
}

/** Hands-on time against waiting, per step: one bar a step, hands-on in the brand colour and the waits in greys. */
export function TimeSplit({ rows, result }: { rows: TimeSplitRow[]; result: SimulationResult | null }) {
  const max = Math.max(1e-9, ...rows.map((r) => r.total));
  return (
    <Panel id="time-split" title="Time split per step" note="Hands-on work against waiting (for a person, or on others), for one visit to the step.">
      {rows.length === 0 ? (
        <Waiting result={result} />
      ) : (
        <>
          <ul className="flex flex-col gap-2">
            {rows.map((r) => (
              <li
                key={r.id}
                className="grid grid-cols-[6.5rem_1fr_4rem] items-center gap-2"
                aria-label={`${r.label}: ${formatHours(r.handsOn)} hands-on, ${formatHours(r.waitingForPerson)} waiting for a person, ${formatHours(r.fixedWait)} waiting on others, ${formatPercent(r.handsOnShare)} hands-on`}
              >
                <span className="truncate">{r.label}</span>
                <span aria-hidden className="flex h-3 gap-0.5" style={{ width: `${Math.max(2, (r.total / max) * 100)}%` }}>
                  {(
                    [
                      [r.handsOn, "bg-accent", undefined],
                      [r.waitingForPerson, "bg-fg-3/70", undefined],
                      [r.fixedWait, "border border-fg-3", HATCH],
                    ] as const
                  ).map(([h, cls, style], i) =>
                    h > 0 ? <span key={i} className={`block h-full min-w-px rounded-sm ${cls}`} style={{ flexGrow: h, flexBasis: 0, ...style }} /> : null,
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
            <Key className="bg-fg-3/70" label="Waiting for a person" />
            <Key className="border border-fg-3" style={HATCH} label="Waiting on others (hatched)" />
          </p>
        </>
      )}
    </Panel>
  );
}

/** A diagonal hatch in the muted text colour, so a wait on others differs from a wait for a person by pattern as well as lightness, in both themes. */
const HATCH = { backgroundImage: "repeating-linear-gradient(135deg, var(--fg-3) 0 1.5px, transparent 1.5px 4px)" } as const;

const Key = ({ className, label, style }: { className: string; label: string; style?: CSSProperties }) => (
  <span className="inline-flex items-center gap-1">
    <i aria-hidden className={`size-2.5 rounded-sm ${className}`} style={style} />
    {label}
  </span>
);

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
              {r.person ? (
                <span className="font-medium">
                  {r.person}
                  {r.placeholder && <span className="font-normal text-fg-3"> (placeholder, no named person)</span>}
                </span>
              ) : (
                <span className="font-medium text-crit">Nobody can do it</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
