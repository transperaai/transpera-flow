"use client";

// The process page's Supporting data (issue #174; capacity-shaped in Q3), each panel reading the latest run: the headline (what this
// process takes, in hours a month), the hours by role (a donut) and by person, the heaviest steps (one strip of the hours by step), the
// time split (the totals, then where the waiting is) and key-person risk (grouped by the person each step hangs on), each a section card in
// the process page's main column. No (i)s: the headings and a line under each say what it is, with "How this works" folded under the picture.

import type { CSSProperties, ReactNode } from "react";
import type { Viewer } from "@transpera-flow/db";
import type { SimulationResult } from "@transpera-flow/engine";
import { SectionCard } from "@/components/page-kit";
import { Skeleton } from "@/components/ui/skeleton";
import { formatHours, formatPercent } from "@/lib/format";
import { headlineText, hoursStrip, pieSlices, stripHeadline, type PieSlice, type ProcessHeadline, type ProcessHours, type StripSegment } from "@/lib/process-page/hours";
import { OTHER_COLOUR, categoricalColour } from "@/lib/chart-colours";
import { keyPersonGroups, timeSplitSummary, type KeyPersonGroups, type KeyPersonRow, type TimeSplitRow } from "@/lib/process-page/supporting";
import { ownRowsOnly, viewerOf } from "@/lib/viewer";

/** A titled panel with a one-line description, the same on every part of the "What the process shows" content (Q8): a section card. */
export function Panel({ id, title, note, children }: { id: string; title: string; note: string; children: ReactNode }) {
  return (
    <SectionCard id={id} section={id} data-panel={id} title={title} description={note} className="@container min-w-0" contentClassName="block">
      {children}
    </SectionCard>
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
    <p className="font-display text-lg leading-snug font-semibold text-balance" data-supporting-headline>
      {headline ? headlineText(headline) : <span className="text-sm font-normal text-fg-2">{result ? "No work reached a step in this run." : "Simulating…"}</span>}
    </p>
  );
}

/** The colour of the n-th named slice (the app's categorical palette, the same tokens in both themes); "Others" is the neutral grey. */
const sliceColour = (s: PieSlice, i: number) => (s.role === null ? OTHERS_COLOUR : categoricalColour(i));
const OTHERS_COLOUR = OTHER_COLOUR;

/** What a slice says on hover and to a screen reader: "Executor: 300 h a month, 86%", with the folded roles for "Others". */
function sliceText(s: PieSlice): string {
  const base = `${s.label}: ${hoursMonth(s.hours)} a month, ${formatPercent(s.share)}`;
  return s.members.length ? `${base} (${s.members.map((m) => `${m.label} ${hoursMonth(m.hours)}`).join(", ")})` : base;
}

/** The pie's summary for a screen reader: the three largest slices, then how many more. */
function pieLabel(slices: readonly PieSlice[], total: number): string {
  const top = slices.slice(0, 3).map((s) => `${s.label} ${hoursMonth(s.hours)} (${formatPercent(s.share)})`);
  const more = slices.length - top.length;
  return `Hours a month by role, ${hoursMonth(total)} in all: ${top.join(", ")}${more > 0 ? `, and ${more} more` : ""}.`;
}

/** A donut of the slices, largest first clockwise from the top; each ring segment carries its numbers as a title for hover. */
function HoursDonut({ slices, total }: { slices: readonly PieSlice[]; total: number }) {
  const r = 15.9155; // a circumference of 100, so a segment's dash is its share in per cent
  // A 2-unit-wide gap of the panel's surface between segments, when there is more than one.
  const gap = slices.length > 1 ? 0.8 : 0;
  // Where each segment starts, in per cent of the ring: the shares of the slices before it.
  const starts = slices.map((_, i) => slices.slice(0, i).reduce((sum, x) => sum + x.share * 100, 0));
  return (
    <svg viewBox="0 0 42 42" role="img" aria-label={pieLabel(slices, total)} className="size-36 shrink-0 -rotate-90" data-hours-pie>
      <circle cx="21" cy="21" r={r} fill="none" stroke="var(--panel-2)" strokeWidth="7" />
      {slices.map((s, i) => {
        const len = Math.max(0, s.share * 100 - gap);
        return (
          <circle
            key={s.key}
            cx="21"
            cy="21"
            r={r}
            fill="none"
            stroke={sliceColour(s, i)}
            strokeWidth="7"
            strokeDasharray={`${len} ${100 - len}`}
            strokeDashoffset={-starts[i]!}
            className="transition-opacity hover:opacity-75"
            data-pie-slice={s.key}
          >
            <title>{sliceText(s)}</title>
          </circle>
        );
      })}
    </svg>
  );
}

const Swatch = ({ colour }: { colour: string }) => <i aria-hidden className="size-2.5 shrink-0 rounded-sm" style={{ background: colour }} />;

/** Hours a month by role as a donut, with a legend of the roles (largest first), each opening to the people who carry them. */
export function HoursByRole({ hours, result, viewer }: { hours: ProcessHours | null; result: SimulationResult | null; viewer?: Viewer }) {
  const seen = viewerOf({ viewer });
  const slices = hours ? pieSlices(hours.roles) : [];
  const legendRow = "grid cursor-pointer list-none grid-cols-[auto_1fr_auto_2.75rem] items-center gap-2 [&::-webkit-details-marker]:hidden";
  return (
    <Panel id="hours-by-role" title="Hours a month, by role and person" note="Who carries this process's hands-on work, as a share of its hours. Open a role to see its people.">
      {!hours || slices.length === 0 ? (
        <Waiting result={result} />
      ) : (
        <>
          <p className="mb-2 text-sm font-semibold tabular-nums" data-hours-total>
            {hoursMonth(hours.total)} a month
          </p>
          <div className="flex flex-col items-center gap-4 @sm:flex-row @sm:items-start">
            <HoursDonut slices={slices} total={hours.total} />
            <ul className="flex w-full min-w-0 flex-col gap-1.5" aria-label="Hours a month by role">
              {slices.map((s, i) => (
                <li key={s.key} data-role-hours={s.key} title={sliceText(s)}>
                  <details className="group">
                    <summary
                      className={legendRow}
                      aria-label={
                        s.role
                          ? `${s.label}: ${hoursMonth(s.hours)} a month, ${formatPercent(s.share)}, ${s.role.people.length} ${s.role.people.length === 1 ? "person" : "people"}`
                          : `${sliceText(s)}`
                      }
                    >
                      <Swatch colour={sliceColour(s, i)} />
                      <span className="truncate">{s.label}</span>
                      <span className="text-right text-xs tabular-nums">{hoursMonth(s.hours)}</span>
                      <span className="text-right text-xs text-fg-3 tabular-nums">{formatPercent(s.share)}</span>
                    </summary>
                    <ul className="mt-1 mb-1.5 flex flex-col gap-1 pl-4.5">
                      {s.role
                        ? ownRowsOnly(seen, s.role.people, (p) => p.id).map((p) => (
                            <li key={p.id} className="grid grid-cols-[1fr_auto_2.75rem] items-center gap-2 text-xs">
                              <span className="truncate">{p.name}</span>
                              <span className="text-right tabular-nums">{hoursMonth(p.hours)}</span>
                              <span className="text-right text-fg-3 tabular-nums">{formatPercent(p.hours / hours.total)}</span>
                            </li>
                          ))
                        : s.members.map((m) => (
                            <li key={m.id ?? "none"} className="grid grid-cols-[1fr_auto_2.75rem] items-center gap-2 text-xs" data-others-member={m.id ?? "none"}>
                              <span className="truncate">{m.label}</span>
                              <span className="text-right tabular-nums">{hoursMonth(m.hours)}</span>
                              <span className="text-right text-fg-3 tabular-nums">{formatPercent(m.hours / hours.total)}</span>
                            </li>
                          ))}
                    </ul>
                  </details>
                </li>
              ))}
            </ul>
          </div>
        </>
      )}
    </Panel>
  );
}

/** "How this works", folded under a panel's picture. */
function HowItWorks({ children }: { children: ReactNode }) {
  return (
    <details className="mt-3 text-xs text-fg-2" data-how-it-works>
      <summary className="w-max cursor-pointer font-medium text-accent hover:underline">How this works</summary>
      <div className="mt-1.5 flex flex-col gap-1.5">{children}</div>
    </details>
  );
}

/** The answer of a panel, in one large sentence above its picture. */
const Lead = ({ children, ...rest }: { children: ReactNode; "data-lead"?: string }) => (
  <p className="mb-3 font-display text-lg leading-snug font-semibold text-balance" {...rest}>
    {children}
  </p>
);

// ---------------------------------------------------------------------------
// Heaviest steps (H3): one strip of the process's monthly hours, split by step
// ---------------------------------------------------------------------------

/** The named steps take the first colours of the categorical palette; "N other steps" is the neutral grey. */
const stripColour = (s: StripSegment, i: number) => (s.members.length ? OTHERS_COLOUR : categoricalColour(i));

/** What a segment says on hover: "Review: 38 h a month, 24% of the process", with the grouped steps for "N other steps". */
function segmentText(s: StripSegment): string {
  const base = `${s.label}: ${hoursMonth(s.hours)} a month, ${formatPercent(s.share)} of the process`;
  return s.members.length ? `${base} (${s.members.map((m) => `${m.label} ${hoursMonth(m.hours)}`).join(", ")})` : base;
}

/** A segment wide enough for its name and numbers written on it. */
const LABELLED_SHARE = 0.09;

/** How the process's monthly hours divide between its steps: one strip, the heaviest four named on it, the rest grouped. */
export function HeaviestSteps({ hours, result }: { hours: ProcessHours | null; result: SimulationResult | null }) {
  const strip = hoursStrip(hours);
  return (
    <Panel id="heaviest-steps" title="Heaviest steps" note="How the process's hours a month divide between its steps, heaviest first.">
      {!strip ? (
        <Waiting result={result} />
      ) : (
        <>
          <Lead data-lead="">{stripHeadline(strip)}</Lead>
          <div
            role="img"
            aria-label={`The process's ${hoursMonth(strip.total)} a month by step: ${strip.segments.map(segmentText).join("; ")}.`}
            className="flex h-16 w-full gap-0.5 overflow-hidden rounded-md"
            data-hours-strip
          >
            {strip.segments.map((s, i) => {
              const colour = stripColour(s, i);
              return (
                <div
                  key={s.key}
                  title={segmentText(s)}
                  data-strip-segment={s.key}
                  className="relative min-w-1 overflow-hidden transition-opacity hover:opacity-80"
                  style={{ flexGrow: s.hours, flexBasis: 0, background: `color-mix(in oklab, ${colour} 22%, var(--panel))`, borderTop: `6px solid ${colour}` }}
                >
                  {/* Placed over the segment, so a long name truncates to the segment's width instead of widening the strip. */}
                  {s.share >= LABELLED_SHARE && (
                    <span className="absolute inset-x-2 top-1/2 flex -translate-y-1/2 flex-col">
                      <span className="truncate text-xs font-semibold text-fg">{s.label}</span>
                      <span className="truncate text-xs text-fg-2 tabular-nums">
                        {hoursMonth(s.hours)} · {formatPercent(s.share)}
                      </span>
                    </span>
                  )}
                </div>
              );
            })}
          </div>
          <ul className="mt-3 grid gap-x-6 gap-y-1.5 @md:grid-cols-2" aria-label="Hours a month by step">
            {strip.segments.map((s, i) => {
              const row = (
                <>
                  <Swatch colour={stripColour(s, i)} />
                  <span className="truncate">{s.label}</span>
                  <span className="text-right text-xs tabular-nums">{hoursMonth(s.hours)}</span>
                  <span className="text-right text-xs text-fg-3 tabular-nums">{formatPercent(s.share)}</span>
                </>
              );
              const grid = "grid grid-cols-[auto_1fr_auto_2.75rem] items-center gap-2 text-sm";
              return (
                <li key={s.key} data-heavy-step={s.key} title={segmentText(s)}>
                  {s.members.length ? (
                    <details>
                      <summary className={`${grid} cursor-pointer list-none [&::-webkit-details-marker]:hidden`}>{row}</summary>
                      <ul className="mt-1 mb-1.5 flex flex-col gap-1 pl-4.5">
                        {s.members.map((m) => (
                          <li key={m.id} className="grid grid-cols-[1fr_auto_2.75rem] items-center gap-2 text-xs" data-other-step={m.id}>
                            <span className="truncate">{m.label}</span>
                            <span className="text-right tabular-nums">{hoursMonth(m.hours)}</span>
                            <span className="text-right text-fg-3 tabular-nums">{formatPercent(m.hours / strip.total)}</span>
                          </li>
                        ))}
                      </ul>
                    </details>
                  ) : (
                    <div className={grid}>{row}</div>
                  )}
                </li>
              );
            })}
          </ul>
          <HowItWorks>
            <p>Each step&apos;s hands-on hours a month in the latest run, as a share of this process&apos;s total. The strip&apos;s width is the whole process.</p>
            <p>The four heaviest steps are named; the rest are grouped as &ldquo;other steps&rdquo; (open that row to see them). Hover a segment for its exact hours.</p>
            <p>How much of a step could be automated is on the step itself: select it on the map.</p>
          </HowItWorks>
        </>
      )}
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// Time split per step (T3): the totals, then the steps that wait longest
// ---------------------------------------------------------------------------

/** A diagonal hatch in the muted text colour, so a wait on others differs from a wait for a person by pattern as well as lightness, in both themes. */
const HATCH = { backgroundImage: "repeating-linear-gradient(135deg, var(--fg-3) 0 1.5px, transparent 1.5px 4px)" } as const;
const PERSON_WAIT = "bg-fg-3/70";

const Key = ({ className, label, style }: { className: string; label: string; style?: CSSProperties }) => (
  <span className="inline-flex items-center gap-1">
    <i aria-hidden className={`size-2.5 rounded-sm ${className}`} style={style} />
    {label}
  </span>
);

const waitingOf = (r: TimeSplitRow) => r.waitingForPerson + r.fixedWait;

/** A row's numbers in words, for hover and a screen reader. */
const splitText = (r: TimeSplitRow) =>
  `${r.label}: ${formatHours(waitingOf(r))} waiting a visit (${formatHours(r.waitingForPerson)} for a person, ${formatHours(r.fixedWait)} on others), ${formatHours(r.handsOn)} hands-on${r.redonePer100 ? `, redone ${r.redonePer100} in 100 visits` : ""}`;

/** Hands-on against waiting for the whole process (one visit to each step, added up), then the four steps that wait longest. */
export function TimeSplit({ rows, result }: { rows: TimeSplitRow[]; result: SimulationResult | null }) {
  const sum = timeSplitSummary(rows);
  const waitMax = Math.max(1e-9, ...(sum?.longestWaits ?? []).map(waitingOf));
  const totals = sum
    ? ([
        ["hands-on", sum.handsOn, "text-accent", <Key key="k" className="bg-accent" label="Hands-on" />],
        ["waiting-person", sum.waitingForPerson, "text-fg", <Key key="k" className={PERSON_WAIT} label="Waiting for a person" />],
        ["waiting-others", sum.fixedWait, "text-fg", <Key key="k" className="border border-fg-3" style={HATCH} label="Waiting on others" />],
      ] as const)
    : [];
  return (
    <Panel id="time-split" title="Time split per step" note="Hours of hands-on work against hours of waiting, for one visit to each step, added up.">
      {!sum ? (
        <Waiting result={result} />
      ) : (
        <>
          <dl className="grid grid-cols-3 gap-2" data-time-totals aria-label={`One visit to each of the ${sum.steps} steps, added up: ${formatHours(sum.handsOn)} hands-on, ${formatHours(sum.waitingForPerson)} waiting for a person, ${formatHours(sum.fixedWait)} waiting on others.`}>
            {totals.map(([key, h, cls, label]) => (
              <div key={key} className="flex min-w-0 flex-col gap-1 rounded-md bg-card p-2.5" data-time-total={key} title={`${formatHours(h)} a visit, ${formatPercent(h / (sum.total || 1))} of the time`}>
                <dd className={`font-display text-2xl leading-none font-bold tabular-nums ${cls}`}>{formatHours(h)}</dd>
                <dt className="text-xs text-fg-2">{label}</dt>
              </div>
            ))}
          </dl>
          <p className="mt-1.5 text-xs text-fg-3">Hours per visit, summed over the process&apos;s {sum.steps} {sum.steps === 1 ? "step" : "steps"}.</p>
          {sum.longestWaits.length > 0 ? (
            <>
              <h4 className="mt-4 mb-2 text-sm font-semibold">Most waiting</h4>
              <ul className="flex flex-col gap-2.5" aria-label="Steps that wait longest per visit">
                {sum.longestWaits.map((r) => (
                  <li key={r.id} className="flex flex-col gap-1" data-wait-step={r.id} title={splitText(r)} aria-label={splitText(r)}>
                    <span className="flex items-baseline justify-between gap-3 text-sm">
                      <span className="min-w-0 truncate">
                        <span className="font-medium">{r.label}</span>
                        {r.redonePer100 ? (
                          <span className="ml-1.5 rounded bg-warn-soft px-1.5 py-px text-xs text-fg" title={`${r.redonePer100} in every 100 visits are a repeat pass`} data-redone>
                            redone {r.redonePer100} in 100
                          </span>
                        ) : null}
                      </span>
                      <span className="shrink-0 text-xs text-fg-2 tabular-nums">{formatHours(waitingOf(r))} waiting</span>
                    </span>
                    <span aria-hidden className="flex h-3 gap-0.5" style={{ width: `${Math.max(3, (waitingOf(r) / waitMax) * 100)}%` }}>
                      {(
                        [
                          [r.waitingForPerson, PERSON_WAIT, undefined],
                          [r.fixedWait, "border border-fg-3", HATCH],
                        ] as const
                      ).map(([h, cls, style], i) => (h > 0 ? <span key={i} className={`block h-full min-w-px rounded-sm ${cls}`} style={{ flexGrow: h, flexBasis: 0, ...style }} /> : null))}
                    </span>
                    <span className="text-xs text-fg-3">{r.fixedWait > r.waitingForPerson ? "Mostly waiting on others" : "Mostly waiting for a person"}</span>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p className="mt-4 text-sm text-fg-2">No step waits in this run.</p>
          )}
          <HowItWorks>
            <p>
              For one visit to each step the run measures the hands-on time, the time waiting for a person (in a queue, or for someone&apos;s part-time hours) and the time waiting on
              others outside the team (a client, a supplier). The three totals add those up over every step, as if one piece of work went through each step once.
            </p>
            <p>&ldquo;Most waiting&rdquo; lists the four steps with the longest wait a visit. &ldquo;Redone 12 in 100&rdquo; means 12 in every 100 visits to that step were a repeat pass.</p>
          </HowItWorks>
        </>
      )}
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// Key-person risk per step (K3): grouped by the person it hangs on
// ---------------------------------------------------------------------------

const stepsWord = (n: number) => `${n} ${n === 1 ? "step" : "steps"}`;

/** The worst case first: "If Nadiya is away, 62 h a month of this process stops." */
function keyPersonLead({ people, nobody }: KeyPersonGroups): ReactNode {
  const worst = people[0];
  if (worst) {
    const who = (
      <>
        <b>{worst.person}</b>
        {worst.placeholder && <span className="font-normal text-fg-3"> (a placeholder)</span>}
      </>
    );
    return worst.hours > 0 ? (
      <>
        If {who} is away, <span className="whitespace-nowrap text-crit">{hoursMonth(worst.hours)} a month</span> of this process stops.
      </>
    ) : (
      <>
        If {who} is away, <span className="text-crit">{stepsWord(worst.steps.length)}</span> of this process {worst.steps.length === 1 ? "stops" : "stop"}.
      </>
    );
  }
  return (
    <>
      Nobody can do <span className="text-crit">{stepsWord(nobody.length)}</span> of this process.
    </>
  );
}

/** Steps only one person can do, grouped by that person with the hours at stake, and the steps nobody can do. */
export function KeyPersonPanel({ rows, hours, result }: { rows: KeyPersonRow[]; hours?: Pick<ProcessHours, "steps"> | null; result: SimulationResult | null }) {
  const groups = keyPersonGroups(rows, hours ?? null);
  const chip = "rounded-full border border-line bg-card px-2 py-0.5 text-xs tabular-nums";
  return (
    <Panel id="key-person" title="Key-person risk per step" note="Steps only one person can do, grouped by that person. If they are away, the work stops.">
      {!result ? (
        <Waiting result={result} />
      ) : rows.length === 0 ? (
        <p className="text-sm text-fg-2">No step depends on one person.</p>
      ) : (
        <>
          <Lead data-lead="">{keyPersonLead(groups)}</Lead>
          <ul className="flex flex-col gap-2" aria-label="Who the steps hang on">
            {groups.people.map((g, i) => (
              <li
                key={g.key}
                data-key-person={g.key}
                className={`flex flex-col gap-2 rounded-lg border p-3 ${i === 0 ? "border-crit bg-crit-soft" : "border-warn bg-warn-soft"}`}
                aria-label={`${g.person}${g.placeholder ? " (placeholder, no named person)" : ""}: ${stepsWord(g.steps.length)}, ${hoursMonth(g.hours)} a month: ${g.steps.map((s) => `${s.step} ${hoursMonth(s.hours)}`).join(", ")}`}
              >
                <span className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                  <span className="min-w-0">
                    <span className="font-semibold">{g.person}</span>{" "}
                    {g.placeholder ? <span className="text-xs text-fg-2">placeholder, no named person</span> : g.role && <span className="text-xs text-fg-2">{g.role}</span>}
                  </span>
                  <span className="text-sm font-semibold tabular-nums">
                    {stepsWord(g.steps.length)} · {hoursMonth(g.hours)}
                  </span>
                </span>
                <span className="flex flex-wrap gap-1.5">
                  {g.steps.map((s) => (
                    <span key={s.id} className={chip} title={`${s.step}: ${hoursMonth(s.hours)} a month`} data-key-step={s.id}>
                      {s.step} · {hoursMonth(s.hours)}
                    </span>
                  ))}
                </span>
              </li>
            ))}
            {groups.nobody.length > 0 && (
              <li data-key-person="nobody" className="flex flex-col gap-2 rounded-lg bg-crit p-3 text-crit-fg" aria-label={`Nobody can do it: ${groups.nobody.map((s) => s.step).join(", ")}`}>
                <span className="flex flex-wrap items-baseline justify-between gap-x-3">
                  <span className="font-semibold">Nobody can do it</span>
                  <span className="text-sm font-semibold">{stepsWord(groups.nobody.length)}</span>
                </span>
                <span className="flex flex-wrap gap-1.5">
                  {groups.nobody.map((s) => (
                    <span key={s.id} className={`${chip} text-fg`} data-key-step={s.id}>
                      {s.step}
                    </span>
                  ))}
                </span>
                <span className="text-xs">No one with time can work {groups.nobody.length === 1 ? "this step" : "these steps"}. Work waits here until someone is added.</span>
              </li>
            )}
          </ul>
          <HowItWorks>
            <p>
              A step hangs on one person when exactly one person with time can do it: its role has one person, or it is pinned to someone with no one else to cover. Steps two or more
              people can do aren&apos;t listed.
            </p>
            <p>The hours are each step&apos;s hands-on hours a month in the same run: the work that stops while that person is away. A placeholder is a role with no named people yet.</p>
          </HowItWorks>
        </>
      )}
    </Panel>
  );
}
