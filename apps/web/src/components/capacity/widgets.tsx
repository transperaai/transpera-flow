// The Capacity page's small pictures (capacity build P5), after the prototype's CSS: the busy bar against a line, the room gauge with every
// limit marked, the person chips, the before/after dumbbell and the stack bar. Plain markup with the app's colour tokens (light and dark).

import type { ReactNode } from "react";
import { roomPulse } from "@transpera-flow/db";
import { formatNumber, formatPercent } from "@/lib/format";
import { SectionCard } from "@/components/page-kit";
import { cn } from "@/lib/utils";

/** The bar runs to 130% so a line at 85% and a person at 110% both show. */
const SCALE = 1.3;
const at = (share: number) => `${Math.max(0, Math.min(100, (share * 100) / SCALE))}%`;

export type Tone = "ok" | "warn" | "bad";

/** Under the line is fine, within 10 points under is a warning, at or over is bad. */
export function toneOf(busy: number, line: number): Tone {
  return busy >= line ? "bad" : busy >= line - 0.1 ? "warn" : "ok";
}

export const TONE_BG: Record<Tone, string> = {
  ok: "bg-good",
  warn: "bg-warn",
  bad: "bg-crit",
};
export const TONE_TEXT: Record<Tone, string> = {
  ok: "text-good",
  warn: "text-warn",
  bad: "text-crit",
};

export function BusyBar({ busy, line, low, high, label }: { busy: number; line: number; low?: number; high?: number; label?: string }) {
  const tone = toneOf(busy, line);
  const range = low !== undefined && high !== undefined ? `, range ${formatPercent(low)} to ${formatPercent(high)}` : "";
  return (
    <div
      className="flex min-w-[9rem] items-center gap-2"
      data-busy={Math.round(busy * 100)}
      role="img"
      aria-label={`${label ? `${label}: ` : ""}${formatPercent(busy)} busy against a utilisation threshold of ${formatPercent(line)}${range}`}
    >
      <div className="relative h-2 flex-1 rounded-full bg-panel-2">
        <i className={cn("absolute inset-y-0 left-0 rounded-full", TONE_BG[tone])} style={{ width: at(busy) }} />
        {low !== undefined && high !== undefined && <i className="absolute top-0.5 bottom-0.5 rounded-full bg-fg/25" style={{ left: at(low), width: `calc(${at(high)} - ${at(low)})` }} />}
        <b className="absolute -top-0.5 -bottom-0.5 w-0.5 bg-fg/60" style={{ left: at(line) }} title={`Utilisation threshold ${formatPercent(line)}`} />
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
  const tone: Tone = roomPulse(room, clients).tone;
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
      <div className="relative h-3.5 flex-1" role="img" aria-label={`${formatPercent(before)} before, ${formatPercent(after)} after, utilisation threshold ${formatPercent(line)}`}>
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

/** One bar split into parts with a legend; `unit` follows each figure. A part's `color` (a CSS colour) overrides the series colour by position. */
export function StackBar({ parts, unit = "h" }: { parts: { key: string; name: string; value: number; color?: string }[]; unit?: string }) {
  const total = parts.reduce((s, p) => s + p.value, 0) || 1;
  return (
    <div data-stack>
      <div className="flex h-3.5 overflow-hidden rounded bg-panel-2" role="img" aria-label={parts.map((p) => `${p.name} ${formatNumber(p.value)} ${unit}`).join(", ")}>
        {parts.map((p, i) => (
          <i
            key={p.key}
            className={cn("block h-full", !p.color && SERIES[i % SERIES.length], p.color && i > 0 && "border-l-2 border-panel")}
            style={{ width: `${(p.value * 100) / total}%`, background: p.color }}
            title={`${p.name} ${formatNumber(p.value)} ${unit}`}
            data-part={p.name}
          />
        ))}
      </div>
      <ul className="mt-1.5 flex flex-wrap gap-x-3.5 gap-y-1 text-xs text-muted-foreground">
        {parts.map((p, i) => (
          <li key={p.key} className="flex items-center gap-1.5">
            <i className={cn("size-2.5 shrink-0 rounded-sm", !p.color && SERIES[i % SERIES.length])} style={p.color ? { background: p.color } : undefined} />
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
    <details className="text-xs text-muted-foreground" data-how>
      <summary className="w-max cursor-pointer font-medium text-accent">How this works</summary>
      <p className="mt-1.5 max-w-prose">{works}</p>
      <p className="mt-1.5 max-w-prose">
        <b className="font-semibold text-fg">What it tells you:</b> {tells}
      </p>
    </details>
  );
}

/** The id a card is given from its title, for the heading's `aria-labelledby`. */
const slug = (title: string) =>
  `card-${title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")}`;

/**
 * A section of the Capacity page or the Overview: the page kit's `SectionCard` (title at the left, `aside` at the right, then the content),
 * with the test hooks (`data-…`) on a block around it. Each leads with its answer in a sentence, then the picture.
 */
export function Section({ title, aside, description, children, className, ...rest }: { title: string; aside?: ReactNode; description?: ReactNode } & Omit<React.HTMLAttributes<HTMLDivElement>, "title">) {
  return (
    <div className={cn("min-w-0", className)} {...rest}>
      <SectionCard id={slug(title)} title={title} action={aside} description={description} className="h-full" contentClassName="gap-3">
        {children}
      </SectionCard>
    </div>
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

/** How a headline figure stands against its goal: the bar colour along the top, and the words in the badge (the words carry it, not the colour). */
export type KpiStatus = { tone: "good" | "warn"; words: string };

const STATUS_BAR: Record<KpiStatus["tone"], string> = { good: "border-t-good", warn: "border-t-warn" };
const STATUS_BADGE: Record<KpiStatus["tone"], string> = { good: "bg-good-soft", warn: "bg-warn-soft" };
const STATUS_DOT: Record<KpiStatus["tone"], string> = { good: "bg-good", warn: "bg-warn" };

/** A page's headline figure, bigger than a `Kpi`: the label, the number large, an optional status against a goal, then the note. */
export function HeroKpi({ label, value, sub, status }: { label: string; value: ReactNode; sub?: ReactNode; status?: KpiStatus }) {
  return (
    <div
      className={cn("flex min-w-0 flex-col gap-1 rounded-token border border-line bg-panel px-4 pt-3.5 pb-3 shadow-[var(--shadow)]", status ? cn("border-t-4", STATUS_BAR[status.tone]) : "border-t-4 border-t-accent")}
      data-kpi
      data-kpi-status={status?.tone}
    >
      <div className="text-sm font-medium text-fg-2">{label}</div>
      <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
        <span className="font-mono text-4xl leading-none font-semibold tracking-tight text-fg tabular-nums">{value}</span>
        {status && (
          <span className={cn("inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium text-fg", STATUS_BADGE[status.tone])} data-kpi-badge>
            <i aria-hidden className={cn("size-2 rounded-full", STATUS_DOT[status.tone])} />
            {status.words}
          </span>
        )}
      </div>
      {sub && <div className="text-xs text-muted-foreground">{sub}</div>}
    </div>
  );
}
