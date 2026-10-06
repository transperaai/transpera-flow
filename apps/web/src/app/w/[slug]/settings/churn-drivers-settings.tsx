"use client";

// Settings, Churn drivers (A56, issue #121; the prototype's Settings screen of the same name): the reasons clients
// leave, each with a weight and an on/off switch, plus your own. The simulation measures the ones it can; this section
// shows each one's value now, its weight and how much of the churn it explains, and projects churn as the weights
// move (no new simulation: it works from what the latest run measured).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ModelError, toEngineModel, type ChurnDriverRow, type ProcessBundle } from "@transpera-flow/db";
import { CHURN_DRIVER_SPECS, CHURN_WEIGHT_MAX, CHURN_WEIGHT_MIN, CUSTOM_DRIVER_VALUE, projectChurn, type ChurnCauses, type EngineModel } from "@transpera-flow/engine";
import { Help } from "@/components/help";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  CONTROL_HELP,
  DRIVER_HELP,
  MAX_CUSTOM_DRIVERS,
  NEW_DRIVER_NAME,
  PRICE_MONTH_HELP,
  VALUE_HELP,
  driverStates,
  engineIdOf,
  parseDriverPatch,
  pressureKey,
  sourceLabel,
  toEngineDrivers,
  valueNow,
  type DriverPatch,
  type DriverState,
} from "@/lib/churn-drivers";
import { historyNote } from "@/lib/calibration/client-view";
import { useSimulation } from "@/lib/sim/use-simulation";
import { cn } from "@/lib/utils";
import { addChurnDriver, removeChurnDriver, saveChurnDriver } from "./churn-drivers-actions";
import { SettingsSection } from "./section";

export type DriversMode = "live" | "readonly" | "demo";

/** What the latest clients-and-servicing calibration saw (the date it was counted up to, and each check). */
export interface DriverHistory {
  asOf: number;
  checks: readonly { id: string; n: number; value: number | null; enough: boolean }[];
}

type SaveState = { kind: "idle" } | { kind: "saving" } | { kind: "saved" } | { kind: "error"; message: string };

const SAVE_DELAY_MS = 500;

export function ChurnDriversSettings({
  mode,
  workspaceId,
  bundle,
  rows,
  history = null,
}: {
  mode: DriversMode;
  workspaceId: string | null;
  /** The live process: its model is simulated for what each cause measures now. */
  bundle: ProcessBundle | null;
  /** The drivers the workspace has set; a built-in with no row is at its default. */
  rows: readonly ChurnDriverRow[];
  /** The latest clients-and-servicing calibration's checks (Settings → Historical data): shown beside what the simulation measures, never fed to it. */
  history?: DriverHistory | null;
}) {
  const canEdit = mode !== "readonly";
  const [states, setStates] = useState<DriverState[]>(() => driverStates(rows));
  const [save, setSave] = useState<SaveState>({ kind: "idle" });
  const [adding, setAdding] = useState(false);
  const nextDemoId = useRef(1);

  // Saves: edits to one driver are merged and sent after a short pause, one request at a time per driver.
  const pending = useRef(new Map<string, DriverPatch>());
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const chains = useRef(new Map<string, Promise<void>>());

  const send = useCallback(
    (key: string) => {
      const patch = pending.current.get(key);
      pending.current.delete(key);
      timers.current.delete(key);
      if (!patch || !workspaceId) return;
      const run = async () => {
        setSave({ kind: "saving" });
        try {
          const out = await saveChurnDriver(workspaceId, key, patch);
          if (out.status === "saved") {
            setSave((s) => (pending.current.size || s.kind === "error" ? s : { kind: "saved" }));
          } else setSave({ kind: "error", message: out.message });
        } catch {
          setSave({ kind: "error", message: "Couldn't save. Check your connection and try again." });
        }
      };
      chains.current.set(key, (chains.current.get(key) ?? Promise.resolve()).then(run));
    },
    [workspaceId],
  );

  const change = useCallback(
    (key: string, patch: DriverPatch) => {
      const { description, example, name, ...rest } = patch;
      setStates((all) =>
        all.map((d) =>
          d.key === key
            ? { ...d, ...rest, name: name ?? d.name, description: description === undefined ? d.description : (description ?? ""), example: example === undefined ? d.example : (example ?? "") }
            : d,
        ),
      );
      if (mode !== "live" || !parseDriverPatch(key, patch)) return;
      pending.current.set(key, { ...pending.current.get(key), ...patch });
      const old = timers.current.get(key);
      if (old) clearTimeout(old);
      timers.current.set(key, setTimeout(() => send(key), SAVE_DELAY_MS));
    },
    [mode, send],
  );

  // Leaving the page: send what is pending rather than drop it.
  useEffect(() => {
    const t = timers.current;
    return () => {
      for (const [key, timer] of t) {
        clearTimeout(timer);
        send(key);
      }
    };
  }, [send]);

  const add = async () => {
    if (mode === "demo") {
      const key = `demo-${nextDemoId.current++}`;
      setStates((all) => [...all, newCustom(key, null)]);
      return;
    }
    if (!workspaceId) return;
    setAdding(true);
    const out = await addChurnDriver(workspaceId).catch(() => null);
    setAdding(false);
    if (out?.status === "saved") {
      setStates((all) => [...all, newCustom(out.rowId, out.rowId)]);
      setSave({ kind: "saved" });
    } else setSave({ kind: "error", message: out?.status === "error" ? out.message : "Couldn't add it. Try again." });
  };

  const remove = async (d: DriverState) => {
    if (mode === "live" && workspaceId) {
      const out = await removeChurnDriver(workspaceId, d.key).catch(() => null);
      if (out?.status !== "saved") return setSave({ kind: "error", message: out?.status === "error" ? out.message : "Couldn't remove it. Try again." });
      pending.current.delete(d.key);
    }
    setStates((all) => all.filter((x) => x.key !== d.key));
  };

  // What each cause measures now: simulated once, and again only when something the measures depend on changes
  // (an entered number or a driver of your own). Moving a weight or a switch doesn't run anything.
  const model = useMemo<EngineModel | null>(() => {
    if (!bundle) return null;
    try {
      return toEngineModel(bundle);
    } catch (err) {
      if (err instanceof ModelError) return null;
      throw err;
    }
  }, [bundle]);
  const key = pressureKey(states);
  const [measured, setMeasured] = useState({ key, states });
  useEffect(() => {
    if (key === measured.key) return;
    const t = setTimeout(() => setMeasured({ key, states }), 700);
    return () => clearTimeout(t);
  }, [key, states, measured.key]);
  const simModel = useMemo(() => (model ? { ...model, churnDrivers: toEngineDrivers(measured.states) } : null), [model, measured]);
  const sim = useSimulation(simModel);
  const causes: ChurnCauses | null = sim.run?.result.churnCauses ?? null;
  const causeOf = (d: DriverState) => causes?.causes.find((c) => c.id === engineIdOf(d));

  const projection = useMemo(
    () => (causes ? projectChurn(causes, states.map((d) => ({ id: engineIdOf(d), weight: d.weight, enabled: d.enabled }))) : null),
    [causes, states],
  );
  const customs = states.filter((d) => !d.builtin).length;
  const clientCount = model?.activeClients ?? 0;

  return (
    <SettingsSection
      id="churn-drivers"
      title="Churn drivers"
      description="Base churn per service is multiplied by these drivers. Weights are your estimates; the simulation measures the drivers marked Measured. Contribution shows how much of the churn in the latest run each driver explains."
    >
      {mode === "live" && <SaveStatus state={save} />}
      {mode === "readonly" && (
        <p role="note" className="rounded-lg border border-border bg-muted/50 px-3 py-2 text-sm text-muted-foreground">
          Only owners and editors can change the churn drivers. You can see them here.
        </p>
      )}
      {mode === "demo" && (
        <p role="note" className="rounded-lg border border-border bg-muted/50 px-3 py-2 text-sm text-muted-foreground">
          Demo mode: Northbeam&apos;s sample numbers. Your changes stay in this tab, gone when you reload.
        </p>
      )}
      {save.kind === "error" && (
        <p role="alert" className="text-sm text-destructive">
          {save.message}
        </p>
      )}
      {!model && bundle && (
        <p className="rounded-lg border border-line p-4 text-sm text-muted-foreground">This workspace&apos;s live process can&apos;t be simulated yet, so there is nothing to measure. Fix it on the map first. You can still set the weights.</p>
      )}

      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex min-w-56 flex-col gap-1 rounded-lg border border-line p-4">
          <div className="contents">
            <span className="flex items-center text-2xs font-semibold tracking-wider text-muted-foreground uppercase">
              Projected churn
              <Help label="Projected churn" {...CONTROL_HELP.projected} />
            </span>
            <span className="text-3xl font-semibold tabular-nums" aria-live="polite">
              {projection ? projection.clientsPerMonth.toLocaleString("en-GB", { maximumFractionDigits: 2, minimumFractionDigits: 2 }) : "–"}
              <small className="ml-1.5 text-sm font-normal text-muted-foreground">clients / month</small>
            </span>
            <span className="text-xs text-muted-foreground">
              {projection
                ? `with these weights; normal churn alone is ${causes!.baseClientsPerMonth.toLocaleString("en-GB", { maximumFractionDigits: 2, minimumFractionDigits: 2 })}${clientCount ? ` for ${clientCount} clients` : ""}`
                : sim.status === "error"
                  ? `The simulation failed: ${sim.error}`
                  : model
                    ? "Running the simulation…"
                    : "no simulation to project from"}
            </span>
          </div>
        </div>
        <div className="flex items-center">
          <Button type="button" variant="outline" disabled={!canEdit || adding || customs >= MAX_CUSTOM_DRIVERS} onClick={() => void add()}>
            + Add driver
          </Button>
          {customs >= MAX_CUSTOM_DRIVERS && <span className="ml-2 text-xs text-muted-foreground">Up to {MAX_CUSTOM_DRIVERS} of your own.</span>}
        </div>
      </div>

      <div className="rounded-lg border border-line">
        <ul className="flex flex-col" aria-label="Churn drivers" aria-busy={sim.status === "running"}>
          {states.map((d) => (
            <DriverRow
              key={d.key}
              d={d}
              cause={causeOf(d)}
              history={history}
              model={model}
              share={projection ? (projection.shares[engineIdOf(d)] ?? 0) : null}
              canEdit={canEdit}
              onChange={(patch) => change(d.key, patch)}
              onRemove={() => void remove(d)}
            />
          ))}
          <li className="grid items-center gap-3 border-t border-line px-4 py-3 md:grid-cols-[3.5rem_minmax(0,1.6fr)_minmax(0,1fr)_minmax(0,1fr)]">
            <span />
            <span className="flex items-center text-sm font-medium">
              Normal churn
              <Help label="Normal churn" {...CONTROL_HELP.normal} />
            </span>
            <span />
            <Contribution share={projection ? projection.normalShare : null} tone="plain" label="Normal churn" />
          </li>
        </ul>
      </div>
    </SettingsSection>
  );
}

function newCustom(key: string, rowId: string | null): DriverState {
  return { key, builtin: null, rowId, name: NEW_DRIVER_NAME, description: "", example: "", weight: 1, enabled: true, value: CUSTOM_DRIVER_VALUE.default, month: null };
}

function SaveStatus({ state }: { state: SaveState }) {
  const text = state.kind === "saving" ? "Saving…" : state.kind === "saved" ? "Saved" : "";
  if (!text) return null;
  return (
    <span role="status" className="text-xs text-muted-foreground">
      {text}
    </span>
  );
}

function DriverRow({
  d,
  cause,
  history,
  model,
  share,
  canEdit,
  onChange,
  onRemove,
}: {
  d: DriverState;
  cause: ChurnCauses["causes"][number] | undefined;
  history: DriverHistory | null;
  model: EngineModel | null;
  share: number | null;
  canEdit: boolean;
  onChange: (patch: DriverPatch) => void;
  onRemove: () => void;
}) {
  const valueHelp = d.builtin ? VALUE_HELP[d.builtin] : undefined;
  const range = d.builtin ? CHURN_DRIVER_SPECS[d.builtin].valueRange : { min: CUSTOM_DRIVER_VALUE.min, max: CUSTOM_DRIVER_VALUE.max };
  const help = d.builtin ? DRIVER_HELP[d.builtin] : { description: d.description || "Your own cause of clients leaving.", example: d.example || "Add an example below." };
  return (
    <li className={cn("grid gap-3 border-t border-line px-4 py-3 first:border-t-0 md:grid-cols-[3.5rem_minmax(0,1.6fr)_minmax(0,1fr)_minmax(0,1fr)] md:items-center", !d.enabled && "opacity-60")}>
      <span className="flex items-center">
        <Switch checked={d.enabled} disabled={!canEdit} onCheckedChange={(on) => onChange({ enabled: on })} aria-label={`Use ${d.name}`} />
        <Help label={`Use ${d.name}`} {...CONTROL_HELP.switch} />
      </span>

      <div className="flex min-w-0 flex-col gap-1.5">
        {d.builtin ? (
          <span className="flex items-center">
            <b className="text-sm font-semibold">{d.name}</b>
            <Help label={d.name} {...help} />
          </span>
        ) : (
          <CustomFields d={d} canEdit={canEdit} onChange={onChange} onRemove={onRemove} />
        )}
        <span className="text-xs text-muted-foreground">
          {sourceLabel(d)} · now: {valueNow(d, cause, model)}
          {d.builtin ? historyNote(d.builtin, history) : ""}
        </span>
        {(valueHelp || !d.builtin) && (
          <div className="flex flex-wrap items-end gap-x-4 gap-y-2">
            <NumberBox
              label={valueHelp ? valueHelp.label : "Extra churn at weight 1"}
              unit={valueHelp ? valueHelp.unit : "%"}
              help={{ label: valueHelp ? valueHelp.label : "Extra churn", ...(valueHelp ?? CONTROL_HELP.ownValue) }}
              value={d.value}
              min={range?.min ?? 0}
              max={range?.max ?? 100}
              step={valueHelp?.step ?? 1}
              disabled={!canEdit}
              onCommit={(v) => onChange({ value: v })}
            />
            {d.builtin === "price" && (
              <NumberBox
                label={PRICE_MONTH_HELP.label}
                unit="of 24"
                help={{ label: PRICE_MONTH_HELP.label, description: PRICE_MONTH_HELP.description, example: PRICE_MONTH_HELP.example }}
                value={d.month}
                min={1}
                max={24}
                step={1}
                whole
                disabled={!canEdit}
                onCommit={(v) => v !== null && onChange({ month: v })}
              />
            )}
          </div>
        )}
      </div>

      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
        <span className="flex items-center">
          Weight
          <Help label={`Weight for ${d.name}`} {...CONTROL_HELP.weight} />
          <span className="ml-auto text-sm font-medium text-foreground tabular-nums">{d.weight.toFixed(1)}</span>
        </span>
        <input
          type="range"
          min={CHURN_WEIGHT_MIN}
          max={CHURN_WEIGHT_MAX}
          step={0.1}
          value={d.weight}
          disabled={!canEdit}
          aria-label={`Weight for ${d.name}`}
          onChange={(e) => onChange({ weight: Number(e.target.value) })}
          className="w-full accent-[var(--accent)] disabled:opacity-50"
        />
      </label>

      <Contribution share={d.enabled ? share : 0} tone="accent" label={d.name} hint={CONTROL_HELP.contribution} />
    </li>
  );
}

function Contribution({ share, tone, label, hint }: { share: number | null; tone: "accent" | "plain"; label: string; hint?: { description: string; example: string } }) {
  const pct = share === null ? null : Math.round(share * 100);
  return (
    <div className="flex items-center gap-3">
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="flex items-center text-xs text-muted-foreground">
          Contribution
          {hint && <Help label={`Contribution of ${label}`} {...hint} />}
        </span>
        <div role="img" aria-label={pct === null ? `${label}: not measured yet` : `${label}: ${pct}% of churn`} className="h-2.5 overflow-hidden rounded-full bg-panel-2">
          <i className={cn("block h-full rounded-full", tone === "accent" ? "bg-accent" : "bg-fg-3")} style={{ width: `${pct ?? 0}%` }} />
        </div>
      </div>
      <span className="w-10 text-right text-sm font-medium tabular-nums">{pct === null ? "–" : `${pct}%`}</span>
    </div>
  );
}

function CustomFields({ d, canEdit, onChange, onRemove }: { d: DriverState; canEdit: boolean; onChange: (patch: DriverPatch) => void; onRemove: () => void }) {
  return (
    <div className="flex flex-col gap-1.5">
      <TextBox label="Name" help={{ label: "Driver name", ...CONTROL_HELP.name }} value={d.name} maxLength={80} required disabled={!canEdit} onCommit={(v) => v && onChange({ name: v })} />
      <TextBox
        label="What it is, in one sentence"
        help={{ label: "Driver description", ...CONTROL_HELP.describe }}
        value={d.description}
        maxLength={300}
        disabled={!canEdit}
        placeholder="What it is, in one sentence"
        onCommit={(v) => onChange({ description: v || null })}
      />
      <TextBox
        label="An example"
        help={{ label: "Driver example", ...CONTROL_HELP.exampleField }}
        value={d.example}
        maxLength={300}
        disabled={!canEdit}
        placeholder="An example"
        onCommit={(v) => onChange({ example: v || null })}
      />
      <span className="flex items-center">
        <Button type="button" variant="ghost" size="sm" disabled={!canEdit} onClick={onRemove} aria-label={`Remove ${d.name}`}>
          Remove
        </Button>
        <Help label="Remove a driver" {...CONTROL_HELP.remove} />
      </span>
    </div>
  );
}

/** A text field that saves when you leave it or press Enter; Escape puts back what was there. */
function TextBox({
  label,
  help,
  value,
  onCommit,
  disabled,
  maxLength,
  placeholder,
  required,
}: {
  label: string;
  help: { label: string; description: string; example: string };
  value: string;
  onCommit: (v: string) => void;
  disabled?: boolean;
  maxLength: number;
  placeholder?: string;
  required?: boolean;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? value;
  const commit = () => {
    if (draft === null) return;
    const next = draft.trim();
    setDraft(null);
    if (next !== value.trim() && !(required && !next)) onCommit(next);
  };
  return (
    <label className="flex flex-col gap-0.5 text-xs text-muted-foreground">
      <span className="flex items-center">
        {label}
        <Help {...help} />
      </span>
      <Input
        value={shown}
        maxLength={maxLength}
        disabled={disabled}
        placeholder={placeholder}
        aria-label={label}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          else if (e.key === "Escape") setDraft(null);
        }}
      />
    </label>
  );
}

/** A number field that saves when you leave it or press Enter, if it is in range; Escape puts back what was there. */
function NumberBox({
  label,
  unit,
  help,
  value,
  min,
  max,
  step,
  whole,
  disabled,
  onCommit,
}: {
  label: string;
  unit: string;
  help: { label: string; description: string; example: string };
  value: number | null;
  min: number;
  max: number;
  step: number;
  whole?: boolean;
  disabled?: boolean;
  onCommit: (v: number | null) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? (value === null ? "" : String(value));
  const parsed = draft === null || draft.trim() === "" ? null : Number(draft);
  const valid = draft === null || (parsed !== null && Number.isFinite(parsed) && parsed >= min && parsed <= max && (!whole || Number.isInteger(parsed)));
  const commit = () => {
    if (draft === null) return;
    if (valid && parsed !== null && parsed !== value) onCommit(parsed);
    setDraft(null);
  };
  return (
    <label className="flex flex-col gap-0.5 text-xs text-muted-foreground">
      <span className="flex items-center">
        {label}
        <Help {...help} />
      </span>
      <span className="flex items-center gap-1.5">
        <Input
          type="number"
          inputMode="decimal"
          className="w-24"
          value={shown}
          min={min}
          max={max}
          step={step}
          disabled={disabled}
          aria-label={label}
          aria-invalid={!valid}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
            else if (e.key === "Escape") setDraft(null);
          }}
        />
        <span>{unit}</span>
      </span>
      {!valid && (
        <span role="alert" className="text-crit">
          Between {min} and {max}.
        </span>
      )}
    </label>
  );
}
