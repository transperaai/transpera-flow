"use client";

// Baseline vs scenario (docs/PRD.md §4.1 compare view): the templated
// headline with ranges, a KPI delta table, and utilisation per role and per
// person side by side. Every sentence comes from compareHeadline's templates.

import { useState, type ReactNode } from "react";
import { compareTable, type Comparison, type CompareRow, type EnginePerson, type Headline, type Stat } from "@transpera-flow/engine";
import type { Viewer } from "@transpera-flow/db";
import { formatNumber, formatPercent } from "@/lib/format";
import { ownRowsOnly, viewerOf } from "@/lib/viewer";

const THRESHOLD = 0.85;
const MINUS = "−";

const signed = (v: number, format: (x: number) => string) => {
  const s = format(Math.abs(v));
  if (s === format(0)) return format(0);
  return v > 0 ? `+${s}` : `${MINUS}${s}`;
};

/** Rows from the engine's compareTable, which MCP `compare_scenarios` returns too, so both read the same. */
function KpiDeltaTable({ rows }: { rows: CompareRow[] }) {
  return (
    <table className="w-full text-sm">
      <caption className="sr-only">Key results, baseline and scenario, with 10th–90th percentile ranges</caption>
      <thead>
        <tr className="border-b border-line text-left text-xs text-fg-3">
          <th scope="col" className="py-1 pr-2 font-medium">
            Metric
          </th>
          <th scope="col" className="py-1 pr-2 text-right font-medium">
            Baseline
          </th>
          <th scope="col" className="py-1 pr-2 text-right font-medium">
            Scenario
          </th>
          <th scope="col" className="py-1 text-right font-medium">
            Change
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => {
          const tone = r.tone === "good" ? "text-good" : r.tone === "bad" ? "text-crit" : "";
          return (
            <tr key={r.label} className="border-b border-line/60 align-top">
              <th scope="row" className="py-1.5 pr-2 text-left font-normal">
                {r.label}
              </th>
              <td className="py-1.5 pr-2 text-right tabular-nums">
                {r.text.baseline}
                <span className="block text-xs text-fg-3">{r.text.baselineRange}</span>
              </td>
              <td className="py-1.5 pr-2 text-right tabular-nums">
                {r.text.scenario}
                <span className="block text-xs text-fg-3">{r.text.scenarioRange}</span>
              </td>
              <td className={`py-1.5 text-right font-semibold tabular-nums ${tone}`}>
                {r.text.change}
                <span className="block text-xs font-normal text-fg-3">{r.text.changeRange}</span>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function UtilCell({ stat }: { stat: Stat | undefined }) {
  if (!stat) return <span className="text-xs text-fg-3">not in this side</span>;
  const hot = stat.mean > THRESHOLD;
  return (
    <span className="flex items-center gap-2">
      <span className="relative h-2.5 flex-1 overflow-hidden rounded-sm bg-panel-2" aria-hidden>
        <span className={`absolute inset-y-0 left-0 ${hot ? "bg-crit" : "bg-accent"}`} style={{ width: `${Math.min(100, stat.mean * 100)}%` }} />
        <span className="absolute inset-y-0 w-px bg-fg" style={{ left: `${THRESHOLD * 100}%` }} />
      </span>
      <span className={`w-10 text-right tabular-nums ${hot ? "font-semibold text-crit" : ""}`}>{formatPercent(stat.mean)}</span>
    </span>
  );
}

function UtilisationCompare({
  comparison,
  roleNames,
  people,
  viewer,
}: {
  comparison: Comparison;
  roleNames: Record<string, string>;
  people: Record<string, EnginePerson>;
  viewer?: Viewer;
}) {
  const [view, setView] = useState<"roles" | "people">("roles");
  const rows =
    view === "roles"
      ? Object.entries(comparison.roles).map(([id, v]) => ({ id, label: roleNames[id] ?? id, ...v }))
      : ownRowsOnly(viewerOf({ viewer }), Object.entries(comparison.people), ([id]) => id)
          .map(([id, v]) => ({ id, label: people[id]?.name ?? id, ...v }))
          .sort((a, b) => (roleNames[people[a.id]?.roles[0] ?? ""] ?? "").localeCompare(roleNames[people[b.id]?.roles[0] ?? ""] ?? "") || a.label.localeCompare(b.label));
  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="text-sm font-bold">Utilisation, side by side</h3>
        <div role="group" aria-label="Compare utilisation by" className="flex rounded-token border border-line-2 p-0.5 text-xs">
          {(["roles", "people"] as const).map((v) => (
            <button
              key={v}
              type="button"
              aria-pressed={view === v}
              onClick={() => setView(v)}
              className={`rounded px-2 py-0.5 capitalize ${view === v ? "bg-accent text-accent-fg" : "text-fg-2 hover:bg-panel-2"}`}
            >
              {v}
            </button>
          ))}
        </div>
      </div>
      <table className="w-full text-sm">
        <caption className="sr-only">Utilisation by {view === "roles" ? "role" : "person"}, baseline and scenario</caption>
        <thead>
          <tr className="border-b border-line text-left text-xs text-fg-3">
            <th scope="col" className="py-1 pr-2 font-medium">
              {view === "roles" ? "Role" : "Person"}
            </th>
            <th scope="col" className="w-[32%] py-1 pr-2 font-medium">
              Baseline
            </th>
            <th scope="col" className="w-[32%] py-1 pr-2 font-medium">
              Scenario
            </th>
            <th scope="col" className="py-1 text-right font-medium">
              Change
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="border-b border-line/60">
              <th scope="row" className="max-w-[10rem] truncate py-1 pr-2 text-left font-normal">
                {r.label}
              </th>
              <td className="py-1 pr-2">
                <UtilCell stat={r.baseline} />
              </td>
              <td className="py-1 pr-2">
                <UtilCell stat={r.scenario} />
              </td>
              <td className="py-1 text-right tabular-nums text-fg-2">
                {r.baseline && r.scenario ? `${signed(Math.round((r.scenario.mean - r.baseline.mean) * 100), (v) => formatNumber(v, 0))} pts` : "–"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-1 text-xs text-fg-3">Bars: average utilisation · tick: 85% ceiling · red: above it</p>
    </div>
  );
}

export function CompareView({
  comparison,
  headline,
  roleNames,
  people,
  viewer,
  currency,
  hoursPerWeek,
  horizonWeeks,
  running,
  notes,
  robustness,
}: {
  comparison: Comparison | null;
  headline: Headline | null;
  roleNames: Record<string, string>;
  /** People on either side, by id. */
  people: Record<string, EnginePerson>;
  /** Who is looking: a member or viewer sees their own person only in the people view (B1 2b). */
  viewer?: Viewer;
  currency: string;
  hoursPerWeek: number;
  horizonWeeks: number;
  running: boolean;
  /** Scenarios left out and values brought into range. */
  notes: string[];
  /** The robustness check, shown under a comparison (issue #20). */
  robustness?: ReactNode;
}) {
  const rows = comparison ? compareTable(comparison, { horizonWeeks, hoursPerWeek, currency }) : null;
  return (
    <section aria-labelledby="compare-heading" aria-busy={running} className="flex flex-col gap-3 rounded-token border border-line bg-panel p-3 shadow-token">
      <div className="flex items-baseline justify-between gap-2">
        <h2 id="compare-heading" className="text-sm font-bold">
          Compare: baseline vs scenario
        </h2>
        {running && <span className="text-xs text-fg-3">Simulating…</span>}
      </div>
      {!comparison || !headline || !rows ? (
        <p className="text-sm text-fg-2">Move a lever or apply a saved scenario to compare it with today.</p>
      ) : (
        <>
          <div data-testid="compare-headline" className="rounded-token border border-accent/40 bg-accent-soft px-3 py-2">
            <p className="font-display text-base font-bold">{headline.headline}</p>
            {headline.details.map((d) => (
              <p key={d} className="text-sm text-fg-2">
                {d}
              </p>
            ))}
          </div>
          {notes.map((n) => (
            <p key={n} role="note" className="rounded-token border border-warn bg-warn-soft px-2 py-1 text-xs">
              {n}
            </p>
          ))}
          <KpiDeltaTable rows={rows} />
          <p className="-mt-2 text-xs text-fg-3">
            Averages, with the 10th–90th percentile range underneath. Both sides use the same random draws, so the change&apos;s range is
            taken replication by replication.
          </p>
          <UtilisationCompare comparison={comparison} roleNames={roleNames} people={people} viewer={viewer} />
          {robustness}
        </>
      )}
    </section>
  );
}
