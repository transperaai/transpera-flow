"use client";

// "What matters most" (docs/plans/sandbox-p5-brief.md section 10): around the scenario on screen, each lever moved a little each way, ranked by
// how much it moves one measure. It runs only when asked (two runs per lever, 30 runs each, on the page's pool), shows bars as they arrive,
// and cancels like goal seek. Plain SVG bars from the scenario's value, the low side and the high side in two colours, sorted by the longer
// side, the top ten, with the same numbers as a table. Agency admins and the Owner get "Use this" on a bar (the change dialog, prefilled).

import { useEffect, useMemo, useRef, useState } from "react";
import type { PurposeCategory, SandboxChange } from "@transpera-flow/db";
import type { EffectiveChange } from "@transpera-flow/db/sandbox";
import type { EngineModel } from "@transpera-flow/engine";
import { Help } from "@/components/help";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { NativeSelect } from "@/components/ui/native-select";
import { formatCurrency, formatNumber } from "@/lib/format";
import { SANDBOX_HELP } from "@/lib/forecast/help";
import { sharedSimPool } from "@/lib/forecast/sim-pool";
import { Cancel, poolRunner, runTornado, type RunContext } from "@/lib/sandbox/analysis-run";
import { TORNADO_MEASURES, TORNADO_MEASURE_INFO, tornadoValue, type TornadoMeasureId } from "@/lib/sandbox/measures";
import { tornadoVariants, type TornadoBar, type TornadoVariant } from "@/lib/sandbox/tornado";
import { SERIES_STYLES } from "./compare-chart";

const SECTION_TITLE = "font-heading text-lg leading-snug font-semibold tracking-tight";

export interface TornadoProps {
  /** The bundle, solutions, horizon and start of the scenario on screen. */
  run: RunContext;
  /** Its effective changes ([] for No changes). The bars start from this scenario's own value. */
  base: readonly EffectiveChange[];
  /** The model the levers are picked from (the live forecast's). */
  model: EngineModel | null;
  hiddenLevers: readonly string[];
  cutoffs: readonly [number, number, number];
  categories: readonly PurposeCategory[];
  currency: string;
  /** Profit needs costs (Agency admins and the Owner); the money levers C1 and C2 go with it. */
  canSeeMoney: boolean;
  canAdd: boolean;
  /** Prefilled "Add change" (lever, target, how, value). */
  onUse: (preset: { lever: string; target: string; op: SandboxChange["op"]; value: number }) => void;
}

type Phase = "idle" | "running" | "done" | "cancelled" | "error";

export function Tornado(p: TornadoProps) {
  const measures = TORNADO_MEASURES.filter((m) => p.canSeeMoney || !TORNADO_MEASURE_INFO[m].needsMoney);
  const [measure, setMeasure] = useState<TornadoMeasureId>(p.canSeeMoney ? "profit" : "peakBusy");
  const [purposeKey, setPurposeKey] = useState("fixing");
  const [phase, setPhase] = useState<Phase>("idle");
  const [bars, setBars] = useState<TornadoBar[]>([]);
  const [baseValue, setBaseValue] = useState<number | null>(null);
  const [progress, setProgress] = useState<[number, number]>([0, 0]);
  const [error, setError] = useState<string | null>(null);
  const variantsRef = useRef<TornadoVariant[]>([]);
  const shown = useRef<{ measure: TornadoMeasureId; purposeKey: string } | null>(null);
  const cancel = useRef<Cancel | null>(null);

  // The page keys this on the scenario and horizon, so another one starts clean (and the old runs are stopped here, on unmount).
  useEffect(() => () => cancel.current?.cancel(), []);

  const variants = useMemo(() => (p.model ? tornadoVariants(p.model, p.hiddenLevers, measure) : []), [p.model, p.hiddenLevers, measure]);
  const info = TORNADO_MEASURE_INFO[measure];
  const name = measure === "purpose" ? `Share of hours on ${p.categories.find((c) => c.key === purposeKey)?.name ?? "one purpose"}` : info.label;

  const start = async () => {
    if (!variants.length) return;
    const job = new Cancel();
    cancel.current?.cancel();
    cancel.current = job;
    variantsRef.current = variants;
    shown.current = { measure, purposeKey };
    setPhase("running");
    setBars([]);
    setBaseValue(null);
    setError(null);
    setProgress([0, variants.reduce((n, v) => n + (v.base ? 3 : 2), 1)]);
    const read = (r: { result: { monthly?: Parameters<typeof tornadoValue>[1] | null } }) => (r.result.monthly ? tornadoValue(measure, r.result.monthly, { cutoffs: p.cutoffs, categories: p.categories, purposeKey }) : null);
    try {
      const out = await runTornado(variants, poolRunner(sharedSimPool(), p.run), p.base, read, job, (b, base, done, total) => {
        if (job.cancelled) return;
        setBars(b);
        setBaseValue(base);
        setProgress([done, total]);
      });
      if (job.cancelled) return;
      setBars(out.bars);
      setBaseValue(out.base);
      setPhase(out.finished ? "done" : "cancelled");
    } catch (e) {
      if (!job.cancelled) {
        setError(e instanceof Error ? e.message : "The runs couldn't be made.");
        setPhase("error");
      }
    }
  };
  const stop = () => {
    cancel.current?.cancel();
    setPhase("cancelled");
  };

  const unit = info.unit;
  const fmt = (v: number) => (unit === "money" ? formatCurrency(Math.round(v), p.currency) : unit === "share" ? `${formatNumber(v * 100, 1)}%` : formatNumber(v, 1));
  const signed = (v: number | null) => (v === null ? "no number" : `${v < 0 ? "−" : "+"}${fmt(Math.abs(v))}`);
  const running = phase === "running";
  const best = (b: TornadoBar): "low" | "high" => {
    const lo = b.lowDelta ?? 0;
    const hi = b.highDelta ?? 0;
    return info.better === "higher" ? (hi >= lo ? "high" : "low") : hi <= lo ? "high" : "low";
  };
  const use = (b: TornadoBar) => {
    const v = variantsRef.current.find((x) => x.leverId === b.leverId);
    if (!v) return;
    const c = best(b) === "high" ? v.high : v.low;
    p.onUse({ lever: c.lever, target: c.target ?? "", op: c.op, value: c.value });
  };

  return (
    <section className="flex min-w-0 flex-col gap-3" data-tornado data-tornado-status={phase}>
      <div className="flex flex-col gap-0.5">
        <h2 className={`${SECTION_TITLE} flex items-center`}>
          What matters most
          <Help {...SANDBOX_HELP.tornado} />
        </h2>
        <p className="text-sm text-muted-foreground">Each lever moved a little each way, one at a time, on top of this scenario. The longest bars are where a change moves {name.toLowerCase()} most.</p>
      </div>
      <Card className="gap-3 px-4 py-3">
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex min-w-[14rem] flex-col gap-0.5 text-xs font-medium text-fg-2">
            Measure
            <NativeSelect value={measure} onChange={(e) => setMeasure(e.target.value as TornadoMeasureId)} disabled={running} data-tornado-measure>
              {measures.map((m) => (
                <option key={m} value={m}>
                  {TORNADO_MEASURE_INFO[m].label}
                </option>
              ))}
            </NativeSelect>
          </label>
          {measure === "purpose" ? (
            <label className="flex flex-col gap-0.5 text-xs font-medium text-fg-2">
              Purpose
              <NativeSelect value={purposeKey} onChange={(e) => setPurposeKey(e.target.value)} disabled={running} data-tornado-purpose>
                {p.categories.map((c) => (
                  <option key={c.key} value={c.key}>
                    {c.name}
                  </option>
                ))}
              </NativeSelect>
            </label>
          ) : null}
          {running ? (
            <Button variant="outline" onClick={stop} data-tornado-cancel>
              Cancel
            </Button>
          ) : (
            <Button variant="outline" onClick={start} disabled={!variants.length || !p.model} data-tornado-start>
              Work out what matters most
            </Button>
          )}
        </div>
        <p className="text-xs text-muted-foreground" aria-live="polite" data-tornado-line>
          {running
            ? `Run ${Math.min(progress[0] + 1, progress[1])} of ${progress[1]}…`
            : phase === "cancelled"
              ? "Cancelled."
              : phase === "error"
                ? `The runs couldn't be made: ${error}`
                : phase === "done"
                  ? `${progress[1]} runs of 30, the same random runs each, so a difference comes from the change.`
                  : `${variants.reduce((n, v) => n + (v.base ? 3 : 2), 1)} runs of 30 simulated runs each, on three workers; nothing runs until you ask.`}
        </p>

        {baseValue !== null && bars.length ? (
          <>
            <p className="text-sm" data-tornado-base>
              {name} in this scenario: <b className="font-semibold">{fmt(baseValue)}</b>
            </p>
            <TornadoBars bars={bars} fmtDelta={signed} measure={name} />
            <div className="overflow-x-auto">
              <table className="w-full text-xs tabular-nums" data-tornado-table>
                <thead>
                  <tr className="text-left text-muted-foreground">
                    <th scope="col" className="py-1 pr-3 font-medium">
                      Lever
                    </th>
                    <th scope="col" className="py-1 pr-3 font-medium">
                      Moved down
                    </th>
                    <th scope="col" className="py-1 pr-3 font-medium">
                      Moved up
                    </th>
                    <th scope="col" className="py-1 font-medium">
                      <span className="sr-only">Use</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {bars.map((b) => (
                    <tr key={b.leverId} className={`border-t border-line ${b.negligible ? "text-muted-foreground" : ""}`} data-tornado-row={b.leverId}>
                      <th scope="row" className="py-1 pr-3 text-left font-normal">
                        {b.label}
                        {b.negligible ? <span className="ml-1">(about no change)</span> : null}
                      </th>
                      <td className="py-1 pr-3">
                        {b.lowLabel}: {signed(b.lowDelta)}
                      </td>
                      <td className="py-1 pr-3">
                        {b.highLabel}: {signed(b.highDelta)}
                      </td>
                      <td className="py-1 text-right">
                        {p.canAdd && !b.negligible ? (
                          <button type="button" className="underline" onClick={() => use(b)} data-tornado-use={b.leverId}>
                            Use this
                          </button>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        ) : null}
      </Card>
    </section>
  );
}

/** Horizontal bars from the scenario's value: the low side and the high side, each from the middle line, sorted as given. */
export function TornadoBars({ bars, fmtDelta, measure }: { bars: TornadoBar[]; fmtDelta: (v: number | null) => string; measure: string }) {
  const max = Math.max(...bars.map((b) => b.size), 1e-9);
  const W = 640;
  const labelW = 190;
  const mid = labelW + (W - labelW) / 2;
  const half = (W - labelW) / 2 - 56;
  const ROW = 28;
  const H = bars.length * ROW + 24;
  const x = (d: number) => (d / max) * half;
  const low = SERIES_STYLES[0].color;
  const high = SERIES_STYLES[1].color;
  return (
    <figure className="m-0">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Bars: how far each lever moves ${measure}, moved down and up`} className="h-auto w-full" data-tornado-chart>
        <line x1={mid} x2={mid} y1={4} y2={H - 16} stroke="var(--border)" strokeWidth={1} />
        {bars.map((b, i) => {
          const y = 8 + i * ROW;
          const opacity = b.negligible ? 0.35 : 1;
          const side = (d: number | null, color: string, key: string) =>
            d === null ? null : (
              <g key={key}>
                <rect x={d >= 0 ? mid : mid + x(d)} y={y} width={Math.max(1, Math.abs(x(d)))} height={ROW - 10} rx={2} fill={color} opacity={opacity} data-bar={key} />
                <text x={d >= 0 ? mid + x(d) + 4 : mid + x(d) - 4} y={y + ROW - 14} fontSize={10} fill="currentColor" textAnchor={d >= 0 ? "start" : "end"} opacity={opacity}>
                  {fmtDelta(d)}
                </text>
              </g>
            );
          return (
            <g key={b.leverId}>
              <text x={labelW - 8} y={y + ROW - 14} fontSize={11} fill="currentColor" textAnchor="end" opacity={opacity}>
                {b.label.length > 30 ? `${b.label.slice(0, 29)}…` : b.label}
              </text>
              {side(b.lowDelta, low, `${b.leverId}-low`)}
              {side(b.highDelta, high, `${b.leverId}-high`)}
            </g>
          );
        })}
      </svg>
      <figcaption className="flex flex-wrap gap-x-4 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <i aria-hidden className="h-2 w-4 rounded" style={{ background: low }} />
          Moved down
        </span>
        <span className="inline-flex items-center gap-1.5">
          <i aria-hidden className="h-2 w-4 rounded" style={{ background: high }} />
          Moved up
        </span>
        <span>Bars under 1% of the scenario&apos;s value are greyed: about no change.</span>
      </figcaption>
    </figure>
  );
}
