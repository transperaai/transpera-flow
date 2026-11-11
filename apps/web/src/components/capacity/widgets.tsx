// The Capacity page's small pictures (capacity build P5), after the prototype's CSS: the busy bar against a utilisation threshold, the room
// bar (clients today against the most that fit), the before/after dumbbell and the stack bar. Plain markup with the app's colour tokens (light and dark).

import type { ReactNode } from "react";
import { riskOf } from "@transpera-flow/db";
import { formatNumber, formatPercent } from "@/lib/format";
import { SectionCard } from "@/components/page-kit";
import { categoricalColour } from "@/lib/chart-colours";
import { cn } from "@/lib/utils";

/** The bar runs to 130% so a line at 85% and a person at 110% both show. */
const SCALE = 1.3;
const at = (share: number) => `${Math.max(0, Math.min(100, (share * 100) / SCALE))}%`;

export type Tone = "ok" | "warn" | "bad";

/** Under the utilisation threshold is fine, within `AT_RISK_MARGIN` (10 points) under is a warning, at or over is bad (`riskOf`). */
export function toneOf(busy: number, line: number): Tone {
  const risk = riskOf(busy, line);
  return risk === "over" ? "bad" : risk === "near" ? "warn" : "ok";
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

/**
 * A department's clients today against the most that fit: the bar fills to today's clients, the heavy tick is the most that fit. The scale
 * runs a little past whichever is larger so both show.
 */
export function RoomBar({ clients, max, tone, label }: { clients: number; max: number; tone: Tone; label: string }) {
  const top = Math.max(clients, max, 1) * 1.05;
  const x = (v: number) => `${Math.max(0, Math.min(100, (v * 100) / top))}%`;
  return (
    <div className="relative h-3 rounded-full bg-panel-2" role="img" aria-label={label} data-room-bar>
      <i className={cn("absolute inset-y-0 left-0 rounded-full", TONE_BG[tone])} style={{ width: x(clients) }} />
      <b className="absolute -top-1 -bottom-1 w-[3px] -translate-x-1/2 rounded-full bg-fg" style={{ left: x(max) }} />
    </div>
  );
}

/** One person's busy share as a bar coloured by tone, with a black tick at their own utilisation threshold (0-130% scale). */
export function ThresholdBar({ busy, line }: { busy: number; line: number }) {
  const tone = toneOf(busy, line);
  return (
    <div className="relative h-3 rounded-full bg-panel-2" aria-hidden data-busy={Math.round(busy * 100)}>
      <i className={cn("absolute inset-y-0 left-0 rounded-full", TONE_BG[tone])} style={{ width: at(busy) }} />
      <b className="absolute -top-1 -bottom-1 w-0.5 -translate-x-1/2 bg-fg" style={{ left: at(line) }} />
    </div>
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
        <b className="absolute top-0 bottom-0 w-0.5 -translate-x-1/2 bg-fg" style={{ left: at(line) }} />
        <i className={cn("absolute top-[5px] h-1 rounded-full opacity-70", TONE_BG[tone])} style={{ left: at(lo), width: `calc(${at(hi)} - ${at(lo)})` }} />
        <i className="absolute top-0.5 -ml-[5px] size-2.5 rounded-full border-2 border-fg-3 bg-panel" style={{ left: at(before) }} />
        <i className={cn("absolute top-0.5 -ml-[5px] size-2.5 rounded-full", TONE_BG[tone])} style={{ left: at(after) }} />
      </div>
      <span className="w-24 text-right text-xs tabular-nums">
        {formatPercent(before)} → <b className="font-semibold text-fg">{formatPercent(after)}</b>
      </span>
    </div>
  );
}

/** One bar split into parts with a legend; `unit` follows each figure. A part's `color` (a CSS colour, from lib/chart-colours.ts) overrides
 * the categorical slot by position (`categoricalColour`: past eight, "Other"). A 2px surface gap between parts. */
export function StackBar({ parts, unit = "h", legend = true, label }: { parts: { key: string; name: string; value: number; color?: string }[]; unit?: string; legend?: boolean; label?: string }) {
  const total = parts.reduce((s, p) => s + p.value, 0) || 1;
  return (
    <div data-stack>
      <div className="flex h-3.5 overflow-hidden rounded bg-panel-2" role="img" aria-label={`${label ? `${label}: ` : ""}${parts.map((p) => `${p.name} ${formatNumber(p.value)} ${unit}`).join(", ")}`}>
        {parts.map((p, i) => (
          <i
            key={p.key}
            className={cn("block h-full", i > 0 && "border-l-2 border-panel")}
            style={{ width: `${(p.value * 100) / total}%`, background: p.color ?? categoricalColour(i) }}
            title={`${p.name} ${formatNumber(p.value)} ${unit}`}
            data-part={p.name}
          />
        ))}
      </div>
      {legend && (
        <ul className="mt-1.5 flex flex-wrap gap-x-3.5 gap-y-1 text-xs text-muted-foreground">
          {parts.map((p, i) => (
            <li key={p.key} className="flex items-center gap-1.5">
              <i className="size-2.5 shrink-0 rounded-sm" style={{ background: p.color ?? categoricalColour(i) }} />
              {p.name} <b className="tabular-nums text-fg">{formatNumber(p.value)}</b>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** One legend for several bars coloured by the same names (`purposeColours`). */
export function ColourLegend({ colours }: { colours: ReadonlyMap<string, string> }) {
  return (
    <ul className="flex flex-wrap gap-x-3.5 gap-y-1 text-xs text-muted-foreground" data-legend>
      {[...colours].map(([name, color]) => (
        <li key={name} className="flex items-center gap-1.5">
          <i className="size-2.5 shrink-0 rounded-sm" style={{ background: color }} />
          {name}
        </li>
      ))}
    </ul>
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
    <div className="min-w-0 rounded-md border border-line bg-panel px-3.5 py-3" data-kpi>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-0.5 text-xl font-semibold tabular-nums">{value}</div>
      {sub && <div className="mt-0.5 text-xs text-muted-foreground">{sub}</div>}
    </div>
  );
}

/** How a headline figure stands against its goal: the bar colour along the top, and the words in the badge (the words carry it, not the colour). */
export type KpiStatus = { tone: "good" | "warn"; words: string };

const STATUS_EDGE: Record<KpiStatus["tone"], string> = { good: "shadow-[inset_3px_0_0_var(--good)]", warn: "shadow-[inset_3px_0_0_var(--warn)]" };
const STATUS_BADGE: Record<KpiStatus["tone"], string> = { good: "bg-good-soft", warn: "bg-warn-soft" };
const STATUS_DOT: Record<KpiStatus["tone"], string> = { good: "bg-good", warn: "bg-warn" };

/** A page's headline figure, bigger than a `Kpi`: the label, the number large, an optional status against a goal (in words, with a thin edge in its colour), then the note. Flat: a border, no shadow. */
export function HeroKpi({ label, value, sub, status }: { label: string; value: ReactNode; sub?: ReactNode; status?: KpiStatus }) {
  return (
    <div
      className={cn("flex h-full min-w-0 flex-col gap-1 rounded-xl border border-line bg-panel px-3.5 py-3", status && STATUS_EDGE[status.tone])}
      data-kpi
      data-kpi-status={status?.tone}
    >
      <div className="truncate text-xs font-medium text-fg-2">{label}</div>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="text-2xl leading-tight font-semibold tracking-tight text-fg tabular-nums">{value}</span>
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

/**
 * A flat strip of headline figures (docs/plans/ui-cleanup.md, `KpiTile`): one bordered surface with the tiles side by side, divided by hairlines, and
 * no card around each. It wraps onto more rows on a narrow screen; the tiles' own top and left hairlines are clipped at the strip's edge.
 */
export function KpiStrip({ children, className, ...rest }: { children: ReactNode; className?: string } & Omit<React.HTMLAttributes<HTMLDivElement>, "children">) {
  return (
    <div className={cn("grid min-w-0 grid-cols-[repeat(auto-fit,minmax(11rem,1fr))] overflow-hidden rounded-xl border border-line bg-panel", className)} {...rest}>
      {children}
    </div>
  );
}

const EDGE: Record<"good" | "warn" | "crit", string> = {
  good: "shadow-[inset_3px_0_0_var(--good)]",
  warn: "shadow-[inset_3px_0_0_var(--warn)]",
  crit: "shadow-[inset_3px_0_0_var(--crit)]",
};

/**
 * One figure in a `KpiStrip`: the label, the number, an optional status against a goal (in words, with the colour as a stripe at the left edge),
 * then a note. `data-kpi` (and `data-kpi-status`) are the hooks the tests read.
 */
export function KpiTile({ label, value, sub, status, edge, ...rest }: { label: ReactNode; value: ReactNode; sub?: ReactNode; status?: KpiStatus; edge?: "good" | "warn" | "crit" } & Omit<React.HTMLAttributes<HTMLDivElement>, "children">) {
  const stripe = edge ?? status?.tone;
  return (
    <div className={cn("-mt-px -ml-px flex min-w-0 flex-col gap-0.5 border-t border-l border-line px-4 py-3", stripe && EDGE[stripe])} data-kpi data-kpi-status={status?.tone} {...rest}>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="text-2xl leading-tight font-semibold text-fg tabular-nums">{value}</span>
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
