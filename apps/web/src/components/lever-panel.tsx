"use client";

// The lever panel (docs/PRD.md §4.1): one slider per lever generated from the
// model. Moving one re-runs the scenario straight away (debounced in the
// simulation hook, stale runs cancelled).

import { useId } from "react";
import Link from "next/link";
import { Help } from "@/components/help";
import { leverResult, neutral, type Lever, type LeverGroup, type LeverValues } from "@/lib/scenarios/levers";
import { GROUP_LABELS, LEVER_GROUP_ORDER, leverKind, leverKindId } from "@/lib/scenarios/lever-catalogue";
import { formatCurrency, formatNumber } from "@/lib/format";

const GROUPS: readonly LeverGroup[] = LEVER_GROUP_ORDER;

export function formatLeverValue(lever: Lever, value: number, currency: string): string {
  switch (lever.unit) {
    case "per_week":
      return `${formatNumber(value, 1)}/wk`;
    case "clients":
    case "people":
      return formatNumber(value, 0);
    case "share":
      return `${formatNumber(value * 100, 1)}%`;
    case "money":
      return formatCurrency(value, currency);
    case "fte":
      return `${formatNumber(value, 1)} FTE`;
    case "hours":
      return `${formatNumber(value, 1)} h`;
  }
}

function LeverRow({
  lever,
  value,
  currency,
  onChange,
}: {
  lever: Lever;
  value: number;
  currency: string;
  onChange: (value: number | undefined) => void;
}) {
  const id = useId();
  const kindId = leverKindId(lever);
  const kind = kindId ? leverKind(kindId) : undefined;
  const moved = Math.abs(value - neutral(lever)) > 1e-9;
  const pct = Math.round((value - 1) * 100);
  const shown =
    lever.op === "multiply"
      ? moved
        ? `${formatLeverValue(lever, lever.base, currency)} → ${formatLeverValue(lever, leverResult(lever, value), currency)} (${pct > 0 ? "+" : "−"}${Math.abs(pct)}%)`
        : `${formatLeverValue(lever, lever.base, currency)} (±0%)`
      : moved
        ? `${formatLeverValue(lever, lever.base, currency)} → ${formatLeverValue(lever, value, currency)}`
        : formatLeverValue(lever, value, currency);
  return (
    <div className="grid grid-cols-[1fr_auto] items-center gap-x-2 gap-y-0.5">
      <span className="flex min-w-0 items-center">
        <label htmlFor={id} className="truncate text-xs text-fg-2">
          {lever.label}
        </label>
        {kind && <Help label={kind.label} description={kind.description} example={kind.example} />}
      </span>
      <span className="flex items-center gap-1">
        <output htmlFor={id} className={`text-xs tabular-nums ${moved ? "font-semibold text-accent" : "text-fg-2"}`}>
          {shown}
        </output>
        {moved && (
          <button type="button" onClick={() => onChange(undefined)} className="text-xs text-fg-3 hover:text-fg" aria-label={`Reset ${lever.label}`}>
            ↺
          </button>
        )}
      </span>
      <input
        id={id}
        type="range"
        min={lever.min}
        max={lever.max}
        step={lever.step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        aria-valuetext={shown}
        data-lever={lever.path}
        className="col-span-2 w-full accent-[var(--accent)]"
      />
    </div>
  );
}

export function LeverPanel({
  levers,
  values,
  currency,
  onChange,
  onReset,
  status,
  hiddenCount = 0,
  settingsHref,
  clientsPerType = false,
}: {
  levers: Lever[];
  values: LeverValues;
  currency: string;
  onChange: (path: string, value: number | undefined) => void;
  onReset: () => void;
  status: string;
  /** How many lever kinds the workspace has switched off in Settings -> Levers. */
  hiddenCount?: number;
  /** The Levers settings page, to switch them back on. */
  settingsHref?: string;
  /** Clients are counted per type or named, so the pooled client count and churn have no sliders. */
  clientsPerType?: boolean;
}) {
  const moved = levers.filter((l) => values[l.path] !== undefined && Math.abs(values[l.path]! - neutral(l)) > 1e-9).length;
  return (
    <section aria-labelledby="levers-heading" className="flex flex-col gap-2 rounded-token border border-line bg-panel p-3 shadow-token">
      <div className="flex items-baseline justify-between gap-2">
        <h2 id="levers-heading" className="text-sm font-bold">
          Levers
        </h2>
        {moved > 0 && (
          <button type="button" onClick={onReset} className="text-xs text-fg-2 underline">
            Reset {moved} lever{moved === 1 ? "" : "s"}
          </button>
        )}
      </div>
      <p className="text-xs text-fg-3" aria-live="polite">
        {status}
      </p>
      {hiddenCount > 0 && (
        <p className="text-xs text-fg-3">
          {hiddenCount} kind{hiddenCount === 1 ? "" : "s"} of lever hidden.{" "}
          {settingsHref && (
            <Link href={settingsHref} className="underline">
              Change in Settings → Levers
            </Link>
          )}
        </p>
      )}
      <div className="flex max-h-[40rem] flex-col gap-2 overflow-y-auto pr-1">
        {clientsPerType && !levers.some((l) => l.group === "clients") && (
          <div className="rounded-token border border-line px-2 py-1.5" data-clients-per-type>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-fg-2">{GROUP_LABELS.clients}</h3>
            <p className="mt-1 text-xs text-fg-3">Clients and churn are set per client type here: change them in the Sandbox or Settings, Clients.</p>
          </div>
        )}
        {GROUPS.map((group) => {
          const inGroup = levers.filter((l) => l.group === group);
          if (!inGroup.length) return null;
          const sections = [...new Set(inGroup.map((l) => l.section))];
          return (
            <details key={group} open={group !== "process"} className="rounded-token border border-line px-2 py-1.5">
              <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wider text-fg-2">
                {GROUP_LABELS[group]}
                {group === "process" ? <span className="ml-1 font-normal normal-case tracking-normal text-fg-3">relative to today (±%)</span> : null}
              </summary>
              <div className="mt-2 flex flex-col gap-3">
                {sections.map((section) => (
                  <div key={section} className="flex flex-col gap-2">
                    {sections.length > 1 && <h3 className="text-xs font-semibold">{section}</h3>}
                    {inGroup
                      .filter((l) => l.section === section)
                      .map((lever) => (
                        <LeverRow
                          key={lever.path}
                          lever={lever}
                          value={values[lever.path] ?? neutral(lever)}
                          currency={currency}
                          onChange={(v) => onChange(lever.path, v)}
                        />
                      ))}
                  </div>
                ))}
              </div>
            </details>
          );
        })}
      </div>
    </section>
  );
}
