"use client";

// "Wait before each step" on the process page's Supporting data (issue #103): how long work sits in the queue before a
// step starts, from the latest run, longest first. The numbers are the run's own: `StepResult.avgWait`, in hours.

import type { EngineModel, SimulationResult } from "@transpera-flow/engine";
import { formatHours } from "@/lib/format";

const SHOWN = 7;

export function WaitByStep({ model, result, stepIds }: { model: EngineModel; result: SimulationResult | null; /** The steps of this process (and those inside it): the model may hold more, such as a pipeline run beside a servicing process. */ stepIds: ReadonlySet<string> }) {
  const rows = result
    ? model.steps
        .flatMap((s) => {
          const r = result.steps[s.id];
          return r && r.arrivals > 0 && stepIds.has(s.id) ? [{ id: s.id, label: s.name, hours: r.avgWait }] : [];
        })
        .sort((a, b) => b.hours - a.hours)
        .slice(0, SHOWN)
    : [];
  const max = Math.max(1, ...rows.map((r) => r.hours));
  return (
    <section aria-labelledby="wait-heading" className="rounded-token border border-line bg-panel p-3 shadow-token">
      <h3 id="wait-heading" className="mb-2 flex items-center text-sm font-bold">
        Wait before each step
      </h3>
      {!result ? (
        <p className="text-sm text-fg-2">Simulating…</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-fg-2">No work reached a step in this run.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {rows.map((r) => (
            <li key={r.id} className="grid grid-cols-[9.5rem_1fr_3.5rem] items-center gap-2" aria-label={`${r.label}: ${formatHours(r.hours)} wait`}>
              <span className="truncate">{r.label}</span>
              <span aria-hidden className="h-3 overflow-hidden rounded-sm bg-panel-2">
                <span className="block h-full bg-accent" style={{ width: `${Math.max(1, (r.hours / max) * 100)}%` }} />
              </span>
              <span className="text-right tabular-nums">{formatHours(r.hours)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
