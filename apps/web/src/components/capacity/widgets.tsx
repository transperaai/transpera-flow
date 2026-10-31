// The Capacity page's small pictures (capacity build P5), after the prototype's CSS: the busy bar against a line, the room gauge with every
// limit marked, the person chips, the before/after dumbbell and the stack bar. Plain markup with the app's colour tokens (light and dark).

import type { ReactNode } from "react";
import { formatNumber, formatPercent } from "@/lib/format";
import { cn } from "@/lib/utils";

/** The bar runs to 130% so a line at 85% and a person at 110% both show. */
const SCALE = 1.3;
const at = (share: number) => `${Math.max(0, Math.min(100, (share * 100) / SCALE))}%`;

export type Tone = "ok" | "warn" | "bad";

/** Under the line is fine, within 10 points under is a warning, at or over is bad. */
export function toneOf(busy: number, line: number): Tone {
  return busy >= line ? "bad" : busy >= line - 0.1 ? "warn" : "ok";
}

export const TONE_BG: Record<Tone, string> = { ok: "bg-good", warn: "bg-warn", bad: "bg-crit" };
export const TONE_TEXT: Record<Tone, string> = { ok: "text-good", warn: "text-warn", bad: "text-crit" };

export function BusyBar({ busy, line, low, high, label }: { busy: number; line: number; low?: number; high?: number; label?: string }) {
  const tone = toneOf(busy, line);
  const range = low !== undefined && high !== undefined ? `, range ${formatPercent(low)} to ${formatPercent(high)}` : "";
  return (
    <div className="flex min-w-[9rem] items-center gap-2" data-busy={Math.round(busy * 100)} role="img" aria-label={`${label ? `${label}: ` : ""}${formatPercent(busy)} busy against a line of ${formatPercent(line)}${range}`}>
      <div className="relative h-2 flex-1 rounded-full bg-panel-2">
        <i className={cn("absolute inset-y-0 left-0 rounded-full", TONE_BG[tone])} style={{ width: at(busy) }} />
        {low !== undefined && high !== undefined && <i className="absolute top-0.5 bottom-0.5 rounded-full bg-fg/25" style={{ left: at(low), width: `calc(${at(high)} - ${at(low)})` }} />}
        <b className="absolute -top-0.5 -bottom-0.5 w-0.5 bg-fg/60" style={{ left: at(line) }} title={`Line ${formatPercent(line)}`} />
      </div>
      <span className="w-10 text-right text-xs tabular-nums">{formatPercent(busy)}</span>
    </div>
  );
}

export interface GaugeLimit {
  name: string;
  max: number;
}

/** Clients so far as a bar, with a mark at every limit; the lowest limit is the heavy one. */
export function RoomGauge({ clients, limits, room }: { clients: number; limits: GaugeLimit[]; room: number }) {
  const shown = limits.filter((l) => l.max < clients * 3);
  const top = Math.max(clients, ...shown.map((l) => l.max), 1) * 1.08;
  const x = (v: number) => `${Math.min(100, (v * 100) / top)}%`;
  const tone: Tone = room < 1 ? "bad" : room < 5 ? "warn" : "ok";
  return (
    <div data-gauge>
      <div className="relative h-3.5 rounded-full bg-panel-2" role="img" aria-label={`${formatNumber(clients, 0)} clients today. ${shown.map((l) => `${l.name} limit ${formatNumber(l.max, 0)}`).join(". ")}`}>
        <i className={cn("absolute inset-y-0 left-0 rounded-full", TONE_BG[tone])} style={{ width: x(clients) }} />
        {shown.map((l, i) => (
          <b key={l.name} className={cn("absolute -top-1 -bottom-1", i === 0 ? "w-[3px] bg-fg" : "w-0.5 bg-fg-3")} style={{ left: x(l.max) }} title={`${l.name}: ${formatNumber(l.max, 0)}`} />
        ))}
      </div>
      <div className="mt-2 flex flex-wrap gap-x-3.5 gap-y-1 text-xs text-muted-foreground">
        {shown.map((l, i) => (
          <span key={l.name} className={cn(i === 0 && "font-semibold text-fg")}>
            {i === 0 ? "▲ " : ""}
            {l.name} <b className="tabular-nums">{formatNumber(l.max, 0)}</b>
          </span>
        ))}
      </div>
    </div>
  );
}

export function Chip({ tone, children }: { tone: "ok" | "bad"; children: ReactNode }) {
  return <span className={cn("rounded-full border border-line px-2.5 py-0.5 text-xs", tone === "ok" ? "bg-good-soft [&_b]:text-good" : "bg-crit-soft [&_b]:text-crit")}>{children}</span>;
}

export function TierChips({ byTier }: { byTier: Record<string, number> }) {
  return (
    <span className="inline-flex flex-wrap gap-1 align-middle">
      {Object.entries(byTier)
        .filter(([, n]) => n > 0.05)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([tier, n]) => (
          <span key={tier} className="rounded-full bg-panel-2 px-1.5 py-px text-2xs text-muted-foreground">
            {tier} {formatNumber(n, 0)}
          </span>
        ))}
    </span>
  );
}

/** Before (hollow dot) and after (solid dot) on the same 0-130% scale, with the line as a grey bar. */
export function Dumbbell({ before, after, line }: { before: number; after: number; line: number }) {
  const tone = toneOf(after, line);
  const lo = Math.min(before, after);
  const hi = Math.max(before, after);
  return (
    <div className="flex items-center gap-2.5" data-dumbbell>
      <div className="relative h-3.5 flex-1" role="img" aria-label={`${formatPercent(before)} before, ${formatPercent(after)} after, line ${formatPercent(line)}`}>
        <span className="absolute inset-x-0 top-[6px] h-0.5 bg-panel-2" />
        <b className="absolute top-0 bottom-0 w-0.5 bg-fg/50" style={{ left: at(line) }} />
        <i className={cn("absolute top-[6px] h-0.5 opacity-60", TONE_BG[tone])} style={{ left: at(lo), width: `calc(${at(hi)} - ${at(lo)})` }} />
        <i className="absolute top-0.5 -ml-[5px] size-2.5 rounded-full border-2 border-fg-3 bg-panel" style={{ left: at(before) }} />
        <i className={cn("absolute top-0.5 -ml-[5px] size-2.5 rounded-full", TONE_BG[tone])} style={{ left: at(after) }} />
      </div>
      <span className="w-24 text-right text-xs tabular-nums">
        {formatPercent(before)} → <b className={tone === "bad" ? "text-crit" : undefined}>{formatPercent(after)}</b>
      </span>
    </div>
  );
}

const SERIES = ["bg-chart-1", "bg-chart-2", "bg-chart-3", "bg-chart-4", "bg-chart-5", "bg-chart-1/60", "bg-chart-2/60", "bg-chart-3/60"];

/** One bar split into parts with a legend; `unit` follows each figure. */
export function StackBar({ parts, unit = "h" }: { parts: { key: string; name: string; value: number }[]; unit?: string }) {
  const total = parts.reduce((s, p) => s + p.value, 0) || 1;
  return (
    <div data-stack>
      <div className="flex h-3.5 overflow-hidden rounded bg-panel-2" role="img" aria-label={parts.map((p) => `${p.name} ${formatNumber(p.value)} ${unit}`).join(", ")}>
        {parts.map((p, i) => (
          <i key={p.key} className={cn("block h-full", SERIES[i % SERIES.length])} style={{ width: `${(p.value * 100) / total}%` }} title={`${p.name} ${formatNumber(p.value)} ${unit}`} />
        ))}
      </div>
      <ul className="mt-1.5 flex flex-wrap gap-x-3.5 gap-y-1 text-xs text-muted-foreground">
        {parts.map((p, i) => (
          <li key={p.key} className="flex items-center gap-1.5">
            <i className={cn("size-2 rounded-sm", SERIES[i % SERIES.length])} />
            {p.name} <b className="tabular-nums text-fg">{formatNumber(p.value)}</b>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** "How this works", folded. */
export function How({ works, tells }: { works: ReactNode; tells: ReactNode }) {
  return (
    <details className="mt-3 text-xs text-muted-foreground" data-how>
      <summary className="w-max cursor-pointer font-medium text-accent">How this works</summary>
      <p className="mt-1.5 max-w-prose">{works}</p>
      <p className="mt-1.5 max-w-prose">
        <b className="font-semibold text-fg">What it tells you:</b> {tells}
      </p>
    </details>
  );
}

/** A card with a heading, as the prototype's `.card.sec`. */
export function Section({ title, aside, children, ...rest }: { title: string; aside?: ReactNode; children: ReactNode } & Omit<React.ComponentProps<"section">, "title">) {
  return (
    <section className="flex min-w-0 flex-col gap-3 rounded-token border border-line bg-panel p-4" {...rest}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-heading text-base font-semibold tracking-tight">{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

export function Kpi({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="min-w-0 rounded-token border border-line bg-panel px-3.5 py-3" data-kpi>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-0.5 font-mono text-[22px] font-medium tabular-nums">{value}</div>
      {sub && <div className="mt-0.5 text-xs text-muted-foreground">{sub}</div>}
    </div>
  );
}
