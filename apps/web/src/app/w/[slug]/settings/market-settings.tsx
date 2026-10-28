"use client";

import { useActionState, useState, useTransition } from "react";
import type { MarketConditionRow } from "@transpera-flow/db";
import { TextField } from "@/components/fields";
import { Help, HelpLabel } from "@/components/help";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";
import type { WorkspaceSettingsData } from "@/lib/data";
import {
  conditionTone,
  FACTORS,
  helpFor,
  MARKET_MONTHS,
  monthRange,
  orderConditions,
  SCHEDULE_HELP,
  segments,
  SLIDER_MAX,
  SLIDER_MIN,
} from "@/lib/market";
import { SettingsSection } from "./section";
import {
  addMarketChange,
  createMarketCondition,
  removeMarketChange,
  removeMarketCondition,
  saveMarketField,
  type ActionResult,
} from "./actions";

const TONE_CLASS = {
  good: "bg-good-soft",
  plain: "bg-panel-2",
  warn: "bg-warn-soft",
  crit: "bg-crit-soft",
  own: "bg-accent-soft",
} as const;

/** Settings → Market conditions (A57): pick a condition or make your own, then plan how it changes over 2 years. */
export function MarketSettings({ data }: { data: WorkspaceSettingsData }) {
  const { canEdit } = data;
  const workspaceId = data.workspace.id;
  const conditions = orderConditions(data.marketConditions);
  const stable = conditions.find((c) => c.preset === "stable");
  const [selectedId, setSelectedId] = useState<string | undefined>(stable?.id ?? conditions[0]?.id);
  const selected = conditions.find((c) => c.id === selectedId) ?? conditions[0];
  const [pending, start] = useTransition();
  const [error, setError] = useState<string>();

  const create = (sourceId: string | null) =>
    start(async () => {
      const r = await createMarketCondition(workspaceId, sourceId);
      setError(r.error);
      if (r.id) setSelectedId(r.id);
    });

  return (
    <SettingsSection
      id="market"
      title="Market conditions"
      description="How good or bad business conditions are. Pick one, or make your own, then plan how it changes over the next 2 years."
    >
      {!canEdit && <p className="text-fg-2">You can view market conditions here; Agency admins can change them.</p>}

      <div role="group" aria-label="Market conditions" className="flex flex-wrap gap-2">
        {conditions.map((c) => (
          <span key={c.id} className="inline-flex items-center">
            <button
              type="button"
              aria-pressed={c.id === selected?.id}
              onClick={() => setSelectedId(c.id)}
              className={`flex min-w-24 flex-col items-start rounded-lg border px-3 py-1.5 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                c.id === selected?.id ? "border-accent bg-accent-soft" : "border-line bg-panel hover:bg-panel-2"
              }`}
            >
              <b className="font-semibold">{c.name}</b>
              <span className="text-xs text-fg-2">{c.preset ? "Preset" : "Custom"}</span>
            </button>
            <Help label={c.name} {...helpFor(c)} />
          </span>
        ))}
        {canEdit && (
          <button
            type="button"
            disabled={pending}
            onClick={() => create(null)}
            className="flex min-w-24 flex-col items-start rounded-lg border border-dashed border-line px-3 py-1.5 text-left text-sm outline-none hover:bg-panel-2 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          >
            <b className="font-semibold">+ Custom</b>
            <span className="text-xs text-fg-2">Start from Stable</span>
          </button>
        )}
      </div>
      {error && (
        <p role="alert" className="text-crit">
          {error}
        </p>
      )}

      {selected && <ConditionCard key={selected.id} condition={selected} canEdit={canEdit} onDuplicate={() => create(selected.id)} duplicating={pending} onRemoved={() => setSelectedId(stable?.id)} />}

      <Schedule data={data} conditions={conditions} />
    </SettingsSection>
  );
}

function ConditionCard({
  condition: c,
  canEdit,
  onDuplicate,
  duplicating,
  onRemoved,
}: {
  condition: MarketConditionRow;
  canEdit: boolean;
  onDuplicate: () => void;
  duplicating: boolean;
  onRemoved: () => void;
}) {
  const readOnly = Boolean(c.preset) || !canEdit;
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-line p-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        {c.preset ? (
          <h3 className="font-semibold">
            {c.name} <span className="text-xs font-normal text-fg-2">preset, read only</span>
          </h3>
        ) : (
          <div className="w-full max-w-xs">
            <TextField
              label="Name"
              value={c.name}
              disabled={!canEdit}
              save={async (_base, next) => {
                const r = await saveMarketField(c.id, "name", next ?? "");
                return r.status === "saved" ? { status: "saved", value: String(r.value) } : r.status === "conflict" ? { status: "conflict", theirs: String(r.theirs) } : r;
              }}
              help={{ description: "The name this market goes by on the schedule.", example: "Cautious 2027" }}
            />
          </div>
        )}
        <div className="flex gap-2">
          {canEdit && (
            <Button variant="outline" size="sm" type="button" disabled={duplicating} onClick={onDuplicate}>
              {c.preset ? "Duplicate to customise" : "Duplicate"}
            </Button>
          )}
          {canEdit && !c.preset && <RemoveCondition id={c.id} name={c.name} onRemoved={onRemoved} />}
        </div>
      </div>

      <div className="flex flex-col gap-2">
        {FACTORS.map((f) => (
          <FactorRow key={`${f.key}-${c[f.key]}`} condition={c} factor={f} readOnly={readOnly} />
        ))}
      </div>
      <p className="text-xs text-fg-2">
        100% means the same as today. Time to hire stretches the Sandbox&apos;s hiring delay; Late payments don&apos;t change the simulation yet.
      </p>
    </div>
  );
}

function FactorRow({ condition: c, factor: f, readOnly }: { condition: MarketConditionRow; factor: (typeof FACTORS)[number]; readOnly: boolean }) {
  const stored = c[f.key];
  const [value, setValue] = useState(stored);
  const [message, setMessage] = useState<string>();
  const commit = async () => {
    if (readOnly || value === stored) return;
    const r = await saveMarketField(c.id, f.key, value);
    setMessage(r.status === "saved" ? undefined : r.status === "error" ? r.message : "Couldn't save. Reload the page.");
  };
  const id = `market-${c.id}-${f.key}`;
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 sm:grid-cols-[14rem_minmax(0,1fr)_3.5rem]">
      <span className="flex items-center text-sm font-semibold">
        <label htmlFor={id}>{f.label}</label>
        <Help label={f.label} description={f.description} example={f.example} />
      </span>
      <output htmlFor={id} className="text-right text-sm tabular-nums sm:order-3">
        {value}%
      </output>
      <input
        id={id}
        type="range"
        min={SLIDER_MIN}
        max={SLIDER_MAX}
        step={1}
        value={Math.min(SLIDER_MAX, Math.max(SLIDER_MIN, value))}
        disabled={readOnly}
        onChange={(e) => setValue(Number(e.target.value))}
        onPointerUp={commit}
        onKeyUp={commit}
        onBlur={commit}
        className="col-span-2 w-full accent-[var(--accent)] disabled:opacity-60 sm:col-span-1 sm:order-2"
      />
      {message && (
        <p role="alert" className="col-span-2 text-xs text-crit sm:order-4">
          {message}
        </p>
      )}
    </div>
  );
}

function RemoveCondition({ id, name, onRemoved }: { id: string; name: string; onRemoved: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string>();
  if (!confirming) {
    return (
      <Button variant="ghost" size="sm" type="button" className="text-muted-foreground hover:text-destructive" onClick={() => setConfirming(true)}>
        Remove
      </Button>
    );
  }
  return (
    <div className="flex flex-col items-end gap-1 text-xs">
      <span>Remove {name}?</span>
      <span className="flex gap-2">
        <Button
          variant="destructive"
          size="sm"
          type="button"
          disabled={pending}
          onClick={() =>
            start(async () => {
              const r = await removeMarketCondition(id);
              setError(r.error);
              if (!r.error) onRemoved();
            })
          }
        >
          {pending ? "Removing…" : "Remove"}
        </Button>
        <Button variant="outline" size="sm" type="button" onClick={() => setConfirming(false)}>
          Cancel
        </Button>
      </span>
      {error && (
        <p role="alert" className="max-w-56 text-right text-crit">
          {error}
        </p>
      )}
    </div>
  );
}

function Schedule({ data, conditions }: { data: WorkspaceSettingsData; conditions: MarketConditionRow[] }) {
  const { marketSchedule: schedule, canEdit } = data;
  const byId = new Map(conditions.map((c) => [c.id, c]));
  const stable = conditions.find((c) => c.preset === "stable");
  const [adding, setAdding] = useState(false);
  const runs = segments(schedule);
  const changes = [...schedule].sort((a, b) => a.from_month - b.from_month);
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-line p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center font-semibold">
          Schedule over 24 months
          <Help label="the schedule" {...SCHEDULE_HELP} />
        </h3>
        {canEdit && !adding && (
          <Button variant="outline" size="sm" type="button" onClick={() => setAdding(true)}>
            + Add change
          </Button>
        )}
      </div>

      {adding && <AddChange workspaceId={data.workspace.id} conditions={conditions} schedule={schedule} onDone={() => setAdding(false)} />}

      <div role="img" aria-label={`Market schedule: ${runs.map((r) => `${monthRange(r.from, r.to)} ${(r.conditionId ? byId.get(r.conditionId) : stable)?.name ?? "Stable"}`).join(", ")}`}>
        <div className="grid h-9 overflow-hidden rounded-md border border-line" style={{ gridTemplateColumns: `repeat(${MARKET_MONTHS}, minmax(0, 1fr))` }}>
          {runs.map((r) => {
            const c = r.conditionId ? byId.get(r.conditionId) : stable;
            return (
              <div
                key={r.from}
                title={`${monthRange(r.from, r.to)}: ${c?.name ?? "Stable"}`}
                style={{ gridColumn: `span ${r.to - r.from + 1}` }}
                className={`flex items-center overflow-hidden border-l border-line px-1.5 text-xs font-medium whitespace-nowrap first:border-l-0 ${TONE_CLASS[conditionTone(c)]}`}
              >
                <span className="truncate">{c?.name ?? "Stable"}</span>
              </div>
            );
          })}
        </div>
        <div aria-hidden className="mt-1 grid text-[10px] text-fg-3" style={{ gridTemplateColumns: `repeat(${MARKET_MONTHS}, minmax(0, 1fr))` }}>
          {Array.from({ length: MARKET_MONTHS }, (_, i) => (
            <span key={i} className="overflow-visible whitespace-nowrap">
              {(i + 1) % 6 === 0 || i === 0 ? `M${i + 1}` : ""}
            </span>
          ))}
        </div>
      </div>

      {changes.length === 0 ? (
        <p className="text-sm text-fg-2">No changes yet, so every month is Stable.</p>
      ) : (
        <ul className="flex flex-wrap gap-2">
          {changes.map((e) => (
            <li key={e.id} className="inline-flex items-center gap-1 rounded-full border border-line px-2.5 py-0.5 text-xs">
              <span>
                {monthRange(e.from_month, e.to_month)}: {byId.get(e.condition_id)?.name ?? "Unknown"}
              </span>
              {canEdit && <RemoveChange id={e.id} label={`${monthRange(e.from_month, e.to_month)} ${byId.get(e.condition_id)?.name ?? ""}`} />}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function RemoveChange({ id, label }: { id: string; label: string }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string>();
  return (
    <>
      <button
        type="button"
        disabled={pending}
        aria-label={`Remove ${label}`}
        onClick={() =>
          start(async () => {
            const r = await removeMarketChange(id);
            setError(r.error);
          })
        }
        className="inline-grid size-6 place-items-center rounded-full text-base leading-none text-fg-3 outline-none hover:text-destructive focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
      >
        ×
      </button>
      {error && (
        <span role="alert" className="text-crit">
          {error}
        </span>
      )}
    </>
  );
}

function AddChange({
  workspaceId,
  conditions,
  schedule,
  onDone,
}: {
  workspaceId: string;
  conditions: MarketConditionRow[];
  schedule: WorkspaceSettingsData["marketSchedule"];
  onDone: () => void;
}) {
  const [state, action, pending] = useActionState<ActionResult, FormData>(async (prev, form) => {
    const r = await addMarketChange(workspaceId, prev, form);
    if (!r.error) onDone();
    return r;
  }, {});
  // Offer the first month nothing covers yet.
  const covered = new Set(schedule.flatMap((e) => Array.from({ length: e.to_month - e.from_month + 1 }, (_, i) => e.from_month + i)));
  const firstFree = Array.from({ length: MARKET_MONTHS }, (_, i) => i + 1).find((m) => !covered.has(m)) ?? 1;
  const soft = conditions.find((c) => c.preset === "soft") ?? conditions[0];
  const months = Array.from({ length: MARKET_MONTHS }, (_, i) => i + 1);
  return (
    <form action={action} className="flex flex-wrap items-end gap-2 rounded-lg bg-panel-2 p-3">
      <label className="flex min-w-36 flex-1 flex-col gap-1 text-xs font-medium text-fg-2">
        <HelpLabel label="Market" description="The market conditions that apply over these months. Pick one of the four presets or one of your own." example="Soft from month 7 to month 14: fewer enquiries and slower decisions for those 8 months." />
        <NativeSelect name="condition_id" defaultValue={soft?.id} required>
          {conditions.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </NativeSelect>
      </label>
      <label className="flex w-24 flex-col gap-1 text-xs font-medium text-fg-2">
        <HelpLabel label="From month" description="The first month of the change. Month 1 is the first month of the run." example="M7 starts the change in the seventh month." />
        <NativeSelect name="from_month" defaultValue={firstFree}>
          {months.map((m) => (
            <option key={m} value={m}>
              M{m}
            </option>
          ))}
        </NativeSelect>
      </label>
      <label className="flex w-24 flex-col gap-1 text-xs font-medium text-fg-2">
        <HelpLabel label="To month" description="The last month the change applies. After the last month in the schedule the final market carries on." example="M14 ends it after the fourteenth month." />
        <NativeSelect name="to_month" defaultValue={MARKET_MONTHS}>
          {months.map((m) => (
            <option key={m} value={m}>
              M{m}
            </option>
          ))}
        </NativeSelect>
      </label>
      <Button type="submit" size="sm" disabled={pending}>
        {pending ? "Adding…" : "Add"}
      </Button>
      <Button type="button" variant="outline" size="sm" onClick={onDone}>
        Cancel
      </Button>
      {state.error && (
        <p role="alert" className="w-full text-sm text-crit">
          {state.error}
        </p>
      )}
    </form>
  );
}
