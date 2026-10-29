"use client";

// Compare scenarios (docs/plans/sandbox-p1-brief.md §4): "No changes" and up to three saved scenarios as columns. Tiles for profit
// over the run (phase 2), last month's recurring revenue, clients at risk, months a role is too busy and late tasks; a chart per measure (recurring revenue, active
// clients per type, clients at risk per group, how busy each role is) with each column's band; every figure an average with its
// 10-90% range and its difference from "No changes". Every column runs with the same seed, so a difference comes from the changes,
// not from chance. A column that fails shows its error and the others still show.

import { useMemo } from "react";
import { workspacePurposes, type ProcessBundle, type SandboxScenarioRow, type SolutionRow } from "@transpera-flow/db";
import type { Stat } from "@transpera-flow/engine";
import { Help, type HelpProps } from "@/components/help";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { NativeSelect } from "@/components/ui/native-select";
import { Skeleton } from "@/components/ui/skeleton";
import { SANDBOX_HELP } from "@/lib/forecast/help";
import { formatCurrency, formatNumber, formatPercent } from "@/lib/format";
import { describeChange, whenOf } from "@/lib/sandbox/describe";
import { compareSandbox, type CompareRow, type CompareTile, type SandboxComparison } from "@/lib/sandbox/compare";
import { effectiveChanges, effectiveLimitProblem, type EffectiveChange } from "@transpera-flow/db/sandbox";
import { useScenarioRun } from "@/lib/sandbox/use-scenario-run";
import { COSTS_HIDDEN_NOTE } from "@/components/forecast/forecast-money";
import { partMonthNote, type TimelineMonth } from "@/lib/forecast/timeline";
import { CompareChart, SERIES_STYLES } from "./compare-chart";
import { TimeBar } from "./time-chart";

const SECTION_TITLE = "font-heading text-lg leading-snug font-semibold tracking-tight";
const NO_CHANGES: EffectiveChange[] = [];
/** Most saved scenarios beside "No changes". */
export const MAX_COMPARE = 3;

const signed = (v: number, text: (abs: number) => string) => (Math.abs(v) < 1e-9 ? text(0) : `${v > 0 ? "+" : "−"}${text(Math.abs(v))}`);

export interface SandboxCompareProps {
  live: ProcessBundle;
  startDate: string;
  months: number;
  scenarios: SandboxScenarioRow[];
  solutions: SolutionRow[];
  /** Saved scenario ids to compare (1 to 3); "No changes" is always the first column. */
  ids: string[];
  cutoffs: readonly [number, number, number];
  onChange: (ids: string[]) => void;
  onBack: () => void;
}

interface Resolved {
  id: string;
  scenario: SandboxScenarioRow | null;
  changes: EffectiveChange[] | null;
  error: string | null;
}

/** A column's changes by the saved scenarios they were worked out from (a module cache: the same scenarios give the same lists). */
const RESOLVED = new WeakMap<SandboxScenarioRow[], Map<string, Resolved>>();

export function SandboxCompare({ live, startDate, months, scenarios, solutions, ids, cutoffs, onChange, onBack }: SandboxCompareProps) {
  // One column's changes are worked out once per scenario and kept while the saved scenarios are the same, so a render, or a change to
  // the other columns' ids, hands a running column the same changes (a new list would restart its run).
  const resolved = useMemo(
    () =>
      ids.slice(0, MAX_COMPARE).map((id): Resolved => {
        const hit = RESOLVED.get(scenarios)?.get(id);
        if (hit) return hit;
        const scenario = scenarios.find((s) => s.id === id) ?? null;
        let value: Resolved;
        if (!scenario) value = { id, scenario: null, changes: null, error: "That scenario isn't there any more." };
        else {
          const eff = effectiveChanges(scenario, scenarios);
          if (!eff.ok) value = { id, scenario, changes: null, error: eff.error };
          else {
            const limit = effectiveLimitProblem(eff.changes.map((c) => c.change));
            value = limit ? { id, scenario, changes: null, error: limit } : { id, scenario, changes: eff.changes, error: null };
          }
        }
        const byId = RESOLVED.get(scenarios) ?? new Map<string, Resolved>();
        byId.set(id, value);
        RESOLVED.set(scenarios, byId);
        return value;
      }),
    [ids, scenarios],
  );
  // The hooks are called a fixed number of times; a column that isn't there gets null and stays idle.
  const run0 = useScenarioRun({ bundle: live, changes: NO_CHANGES, solutions, months, startDate });
  const run1 = useScenarioRun({ bundle: live, changes: resolved[0]?.changes ?? null, solutions, months, startDate });
  const run2 = useScenarioRun({ bundle: live, changes: resolved[1]?.changes ?? null, solutions, months, startDate });
  const run3 = useScenarioRun({ bundle: live, changes: resolved[2]?.changes ?? null, solutions, months, startDate });
  const runs = [run0, run1, run2, run3];
  const columns = [{ name: "No changes", run: run0, error: run0.error }, ...resolved.map((r, i) => ({ name: r.scenario?.name ?? "A scenario", run: runs[i + 1]!, error: r.error ?? runs[i + 1]!.error }))].map((c) => ({ ...c, priceNet: c.run.priceRise?.total.net.mean ?? null }));

  const ready = columns.map((c) => (c.run.run && c.run.status === "done" && !c.error ? c.run.run : null));
  const currency = live.workspace.settings.currency;
  const money = (v: number) => formatCurrency(v, currency);
  // Failed columns are left out of the charts; the others still show.
  const shown = columns.map((c, i) => ({ ...c, index: i, run: ready[i] })).filter((c) => c.run !== null);
  const comparison = useMemo(
    () => (ready[0] ? compareSandbox(ready[0].model, shown.map((c) => c.run!.result.monthly!), live, startDate, cutoffs, shown.map((c) => c.priceNet), workspacePurposes(live.workspace.settings)) : null),
    // The columns are recomputed when a run (or its status or the ids and scenarios behind its error) changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [run0.run, run0.status, run1.run, run1.status, run2.run, run2.status, run3.run, run3.status, ids, scenarios, live, startDate, cutoffs],
  );
  const names = shown.map((c) => c.name);
  const running = columns.some((c) => c.run.status === "running" && !c.error);
  const last = comparison ? comparison.months[comparison.months.length - 1]!.long : "";
  const failed = columns.filter((c) => c.error);
  const unusable = failed.length === columns.length || columns[0]!.error !== null;

  const picker = (slot: number) => (
    <label key={slot} className="flex min-w-[12rem] flex-col gap-0.5">
      <span className="flex items-center text-xs font-medium text-fg-2">
        <i aria-hidden className={`mr-1.5 inline-block h-0.5 w-5 rounded ${SERIES_STYLES[slot + 1]!.swatch}`} />
        Scenario {slot + 1}
      </span>
      <NativeSelect
        aria-label={`Scenario ${slot + 1}`}
        value={ids[slot] ?? ""}
        onChange={(e) => {
          const next = [...ids];
          if (e.target.value) next[slot] = e.target.value;
          else next.splice(slot, 1);
          onChange(next.filter(Boolean));
        }}
        data-compare-pick={slot + 1}
      >
        {slot === 0 ? null : <option value="">None</option>}
        {scenarios.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </NativeSelect>
    </label>
  );

  return (
    <section className="flex min-w-0 flex-col gap-4" data-sandbox-compare data-compare-status={running ? "running" : unusable ? "error" : "done"}>
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h2 className={`${SECTION_TITLE} flex items-center`}>
            Compare scenarios
            <Help {...SANDBOX_HELP.compare} />
          </h2>
          <p className="text-sm text-muted-foreground">Profit, revenue, clients, clients at risk and how busy each role gets, with the 10–90% range from 30 runs. Differences are against “No changes”.</p>
          {comparison && partMonthNote(comparison.months) ? (
            <p className="text-sm text-muted-foreground" data-part-month-note>
              {partMonthNote(comparison.months)} Totals in a part month reflect the days it covers, so a dip or rise there is not a change.
            </p>
          ) : null}
        </div>
        <Button variant="outline" onClick={onBack}>
          Back to the scenario
        </Button>
      </div>

      <Card className="gap-3 px-4 py-3">
        <div className="flex flex-wrap items-end gap-x-4 gap-y-2">
          <div className="flex min-w-[8rem] flex-col gap-0.5">
            <span className="text-xs font-medium text-fg-2">
              <i aria-hidden className={`mr-1.5 inline-block h-0.5 w-5 rounded ${SERIES_STYLES[0].swatch}`} />
              Always
            </span>
            <span className="rounded-md border border-border bg-muted/40 px-2.5 py-1.5 text-sm">No changes</span>
          </div>
          {Array.from({ length: Math.min(MAX_COMPARE, Math.max(1, ids.length + 1)) }, (_, slot) => picker(slot))}
        </div>
        <ul className="flex flex-col gap-0.5 text-xs" aria-live="polite" data-compare-progress>
          {failed.map((c) => (
            <li key={c.name} className="text-destructive" role="alert" data-column-error>
              {c.name}: {c.error}
            </li>
          ))}
          {!failed.length ? (
            <li className="text-muted-foreground">{running ? `Running ${columns.filter((c) => c.run.status === "running").map((c) => c.name).join(", ")}…` : comparison ? "Every column runs with the same random runs, so a difference comes from the changes." : ""}</li>
          ) : null}
        </ul>
      </Card>

      {comparison && !unusable ? (
        <>
          <div className={comparison.totals.profit ? "grid gap-3 sm:grid-cols-2 lg:grid-cols-5" : "grid gap-3 sm:grid-cols-2 lg:grid-cols-4"} data-compare-tiles>
            {comparison.totals.profit ? <Tile title="Profit over the run" names={names} tile={comparison.totals.profit} format={money} diff={(v) => signed(v, money)} /> : null}
            <Tile title={`Recurring revenue in ${last}`} names={names} tile={comparison.totals.mrr} format={money} diff={(v) => signed(v, money)} />
            {comparison.totals.atRisk ? (
              <Tile title={`Clients at risk in ${last}`} names={names} tile={comparison.totals.atRisk} format={(v) => formatNumber(v, 1)} diff={(v) => signed(v, (x) => formatNumber(x, 1))} />
            ) : (
              <Card className="gap-1 px-4 py-3" data-compare-tile="at-risk-none">
                <h3 className="text-xs font-medium text-fg-2">Clients at risk in {last}</h3>
                <p className="text-xs text-muted-foreground">Needs clients counted per service</p>
              </Card>
            )}
            {comparison.totals.priceNet ? (
              <Card className="gap-1 px-4 py-3" data-compare-tile="Net from price rises">
                <h3 className="text-xs font-medium text-fg-2">Net from price rises</h3>
                <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-0.5 text-sm tabular-nums">
                  {names.map((name, c) => (
                    <div key={name + c} className="contents">
                      <dt className="truncate text-muted-foreground">{name}</dt>
                      <dd className="text-right font-semibold">{comparison.totals.priceNet![c] === null ? "—" : signed(comparison.totals.priceNet![c]!, money)}</dd>
                    </div>
                  ))}
                </dl>
              </Card>
            ) : null}
 <Tile title="Hours fixing over the run" names={names} tile={comparison.totals.fixingHours} format={hoursText} diff={(v) => signed(v, hoursText)} />
            <Tile title="Hours on steps that could be removed" names={names} tile={comparison.totals.removableHours} format={hoursText} diff={(v) => signed(v, hoursText)} />
            <Tile title="Months a role is too busy" names={names} tile={comparison.totals.tooBusyMonths} format={(v) => String(v)} diff={(v) => signed(v, (x) => String(x))} />
            <Tile title={`Late tasks in ${last}`} names={names} tile={comparison.totals.lateTasks} format={(v) => formatNumber(v, 1)} diff={(v) => signed(v, (x) => formatNumber(x, 1))} />
          </div>

          <Section title="Changes and notes">
            <CompareChanges live={live} solutions={solutions} columns={[{ name: "No changes", changes: [] }, ...resolved.map((r) => ({ name: r.scenario?.name ?? "A scenario", changes: r.changes ?? [] }))]} />
          </Section>

          {comparison.profit ? (
            <Section title="Profit" help={SANDBOX_HELP.profit}>
              <ChartAndNumbers row={comparison.profit} months={comparison.months} names={names} format={money} formatDiff={(v) => signed(v, money)} />
            </Section>
          ) : (
            <p className="text-sm text-muted-foreground" data-compare-costs-hidden>
              {COSTS_HIDDEN_NOTE}
            </p>
          )}

          <Section title="Billed revenue" help={SANDBOX_HELP.billed}>
            <ChartAndNumbers row={comparison.revenue} months={comparison.months} names={names} format={money} formatDiff={(v) => signed(v, money)} />
          </Section>

          <Section title={comparison.labour ? "Wins and costs" : "Wins"} help={SANDBOX_HELP.winsPerMonth}>
            <ChartAndNumbers row={comparison.won} months={comparison.months} names={names} format={(v) => formatNumber(v, 1)} formatDiff={(v) => signed(v, (x) => formatNumber(x, 1))} />
            <ChartAndNumbers row={comparison.conversion} months={comparison.months} names={names} format={formatPercent} formatDiff={(v) => signed(v, (x) => `${Math.round(x * 100)} points`)} />
            {comparison.labour ? <ChartAndNumbers row={comparison.labour} months={comparison.months} names={names} format={money} formatDiff={(v) => signed(v, money)} /> : null}
          </Section>

          <Section title="Monthly recurring revenue" help={SANDBOX_HELP.revenue}>
            <ChartAndNumbers row={comparison.mrr} months={comparison.months} names={names} format={money} formatDiff={(v) => signed(v, money)} />
          </Section>

          <Section title="Active clients, by type" help={SANDBOX_HELP.clients}>
            {comparison.clients.length ? (
              comparison.clients.map((row) => <ChartAndNumbers key={row.id} row={row} months={comparison.months} names={names} format={(v) => formatNumber(v, 1)} formatDiff={(v) => signed(v, (x) => formatNumber(x, 1))} />)
            ) : (
              <p className="text-sm text-muted-foreground">Needs clients counted per service (Settings, Clients).</p>
            )}
          </Section>

          <Section title="Clients at risk, by group" help={SANDBOX_HELP.atRisk}>
            {comparison.atRisk.length ? (
              comparison.atRisk.map((row) => <ChartAndNumbers key={row.id} row={row} months={comparison.months} names={names} format={(v) => formatNumber(v, 1)} formatDiff={(v) => signed(v, (x) => formatNumber(x, 1))} />)
            ) : (
              <p className="text-sm text-muted-foreground">Needs clients counted per service (Settings, Clients).</p>
            )}
          </Section>

          <Section title="Where the time goes" help={SANDBOX_HELP.time}>
            <TimeCompare comparison={comparison} names={names} />
          </Section>

          <Section title="How busy each role gets" help={SANDBOX_HELP.busy}>
            {comparison.roles.map((row) => (
              <ChartAndNumbers
                key={row.id}
                row={row}
                months={comparison.months}
                names={names}
                format={formatPercent}
                formatDiff={(v) => signed(v, (x) => `${Math.round(x * 100)} points`)}
                reference={{ value: cutoffs[1], label: `${formatPercent(cutoffs[1])} “Too busy” line` }}
                minTop={1}
              />
            ))}
          </Section>
        </>
      ) : unusable ? null : (
        <Skeleton className="h-[320px] w-full" aria-busy="true" />
      )}
    </section>
  );
}

/** Each column's effective changes in words with the note saying why; "No changes" is the live model as it is. */
function CompareChanges({ live, solutions, columns }: { live: ProcessBundle; solutions: SolutionRow[]; columns: { name: string; changes: readonly EffectiveChange[] }[] }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" data-compare-changes>
      {columns.map((col, c) => {
        const ctx = { bundle: live, solutions, changes: col.changes.map((e) => e.change) };
        return (
          <Card key={col.name + c} className="gap-1.5 px-4 py-3" data-compare-changes-column={col.name}>
            <h3 className="text-sm font-medium">{col.name}</h3>
            {col.changes.length === 0 ? (
              <p className="text-xs text-muted-foreground">{c === 0 ? "The live model as it is." : "No changes."}</p>
            ) : (
              <ul className="flex flex-col gap-1.5 text-xs">
                {col.changes.map((e) => (
                  <li key={e.change.id} data-compare-change={e.change.id}>
                    <span>{describeChange(e.change, ctx)}</span> <span className="text-muted-foreground">{whenOf(e.change) ?? "the whole run"}</span>
                    {e.inherited ? <span className="ml-1 text-muted-foreground">(from {e.scenarioName})</span> : null}
                    {e.change.note ? <span className="block text-muted-foreground">{e.change.note}</span> : null}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        );
      })}
    </div>
  );
}

const hoursText = (h: number) => `${formatNumber(h, Math.abs(h) < 10 ? 1 : 0)} h`;

/** Where the time goes, one whole-run 100% bar per column ("No changes" first), then each row's hours a month and its difference from "No changes". */
function TimeCompare({ comparison, names }: { comparison: SandboxComparison; names: string[] }) {
  const n = Math.max(1, comparison.months.length);
  const { rows, shares, runHours } = comparison.time;
  const meta = rows.map((r) => (r.id === "idle" ? "idle" : r.id === "uncovered" ? "uncovered" : "category") as "category" | "idle" | "uncovered");
  const points = (v: number) => signed(v, (x) => `${formatNumber(x * 100, 1)} pts`);
  return (
    <Card className="gap-3 px-4 py-4" data-compare-row="time">
      <ul className="flex flex-col gap-2" data-compare-time-bars>
        {names.map((name, c) => (
          <li key={name + c} className="grid grid-cols-[minmax(6rem,12rem)_minmax(0,1fr)] items-center gap-3 text-xs">
            <span className="truncate" title={name}>
              {name}
            </span>
            <TimeBar label={`${name}: ${rows.map((r, i) => `${r.name} ${formatPercent(shares[c]![i]!)}`).join(", ")}`} rows={rows.map((r, i) => ({ id: r.id, name: r.name, share: shares[c]![i]!, kind: meta[i]! }))} />
          </li>
        ))}
      </ul>
      <div className="overflow-x-auto">
        <table className="w-full min-w-max text-xs tabular-nums" data-compare-table="time">
          <thead>
            <tr className="text-left text-muted-foreground">
              <th scope="col" className="py-1 pr-3 font-medium">
                Hours a month
              </th>
              {names.map((name, c) => (
                <th key={name + c} scope="col" className="py-1 pr-3 font-medium">
                  {name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.id} className="border-t border-line" data-compare-time-row={r.id}>
                <th scope="row" className="py-1 pr-3 text-left font-normal">
                  {r.name}
                </th>
                {names.map((name, c) => {
                  const perMonth = runHours[c]![i]! / n;
                  const base = runHours[0]![i]! / n;
                  return (
                    <td key={name + c} className="py-1 pr-3">
                      {hoursText(perMonth)}
                      {meta[i] === "uncovered" ? null : <span className="ml-1 text-muted-foreground">{formatPercent(shares[c]![i]!)}</span>}
                      {c > 0 ? (
                        <span className="ml-1 text-muted-foreground">
                          {signed(perMonth - base, hoursText)} a month{meta[i] === "uncovered" ? "" : `, ${points(shares[c]![i]! - shares[0]![i]!)}`}
                        </span>
                      ) : null}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function Tile({ title, names: cols, tile, format, diff }: { title: string; names: string[]; tile: CompareTile; format: (v: number) => string; diff: (v: number) => string }) {
  return (
    <Card className="gap-1 px-4 py-3" data-compare-tile={title}>
      <h3 className="text-xs font-medium text-fg-2">{title}</h3>
      <dl className="grid grid-cols-[1fr_auto_auto] gap-x-3 gap-y-0.5 text-sm tabular-nums">
        {cols.map((name, c) => (
          <div key={name + c} className="contents">
            <dt className="truncate text-muted-foreground">{name}</dt>
            <dd className="text-right font-semibold">{format(tile.values[c]!)}</dd>
            <dd className="text-right text-muted-foreground">{tile.diff[c] === null ? "" : diff(tile.diff[c]!)}</dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}

function Section({ title, help, children }: { title: string; help?: HelpProps; children: React.ReactNode }) {
  return (
    <section className="flex min-w-0 flex-col gap-3" data-compare-section={title}>
      <h2 className={`${SECTION_TITLE} flex items-center`}>
        {title}
        {help ? <Help {...help} /> : null}
      </h2>
      <div className="flex flex-col gap-4">{children}</div>
    </section>
  );
}

function ChartAndNumbers({
  row,
  months,
  names,
  format,
  formatDiff,
  reference,
  minTop,
}: {
  row: CompareRow;
  months: TimelineMonth[];
  names: string[];
  format: (v: number) => string;
  formatDiff: (v: number) => string;
  reference?: { value: number; label: string };
  minTop?: number;
}) {
  const cell = (s: Stat | null) => (s ? `${format(s.mean)} (${format(s.p10)}–${format(s.p90)})` : "—");
  const series = names.map((name, c) => ({ name, values: row.values[c]! }));
  return (
    <Card className="gap-2 px-4 py-4" data-compare-row={row.id}>
      <h3 className="text-sm font-medium">{row.name}</h3>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground" data-compare-legend>
        {names.map((name, c) => (
          <span key={name + c} className="inline-flex items-center gap-1.5">
            <i aria-hidden className="h-0.5 w-5 rounded" style={{ background: SERIES_STYLES[c]!.color }} />
            {name}
          </span>
        ))}
      </div>
      <CompareChart title={row.name} months={months} series={series} format={format} formatDiff={formatDiff} reference={reference} minTop={minTop} />
      <details>
        <summary className="cursor-pointer text-xs text-muted-foreground">Show the numbers</summary>
        <div className="mt-2 overflow-x-auto">
          <table className="w-full text-xs tabular-nums" data-compare-table={row.id}>
            <thead>
              <tr className="text-left text-muted-foreground">
                <th scope="col" className="py-1 pr-3 font-medium">
                  Month
                </th>
                {names.map((name, c) => (
                  <th key={name + c} scope="col" className="py-1 pr-3 font-medium">
                    {name} (10–90%)
                    {c > 0 ? (
                      <span className="ml-1 inline-flex items-center font-normal">
                        difference
                        <Help {...SANDBOX_HELP.difference} />
                      </span>
                    ) : null}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {months.map((mo, i) => (
                <tr key={mo.index} className="border-t border-line">
                  <th scope="row" className="py-1 pr-3 text-left font-normal">
                    {mo.label}
                  </th>
                  {names.map((name, c) => (
                    <td key={name + c} className="py-1 pr-3">
                      {cell(row.values[c]![i] ?? null)}
                      {c > 0 && row.diff[c]![i] !== null && row.diff[c]![i] !== undefined ? <span className="ml-1 text-muted-foreground">{formatDiff(row.diff[c]![i]!)}</span> : null}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </Card>
  );
}
