"use client";

// Inputs that save themselves one field at a time, with the "keep mine / keep
// theirs" prompt for same-field conflicts (docs/adr/0001-per-field-saves.md).
// Text-like fields save on blur or Enter (Escape reverts); toggles and
// checklists save on each change.

import { useId, type KeyboardEvent, type ReactNode } from "react";
import { Help } from "@/components/help";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { mapOutcome, type FieldValue, type Saver } from "@/lib/fields/field-controller";
import { useField, type Field } from "@/lib/fields/use-field";

/** The plain-English (i) for a field: what it does, and an example. */
export interface FieldHelp {
  description: string;
  example: string;
}


/** The "keep mine / keep theirs" prompt for a same-field conflict. `subject` names the field when it isn't next to it. */
export function ConflictPrompt({
  subject,
  by = null,
  theirs,
  mine,
  onKeepMine,
  onKeepTheirs,
}: {
  subject?: ReactNode;
  /** Who made the other change, when known ("Tom"). */
  by?: string | null;
  theirs: string;
  mine: string;
  onKeepMine: () => void;
  onKeepTheirs: () => void;
}) {
  return (
    <div role="alert" className="mt-1 rounded-lg border border-warn bg-warn-soft p-2 text-xs text-foreground">
      <p>
        {by ?? "Someone else"} changed {subject ?? "this"} to <strong>{theirs}</strong> while you were editing. Keep yours or
        theirs?
      </p>
      <div className="mt-1.5 flex gap-2">
        <Button type="button" size="xs" onClick={onKeepMine}>
          Keep mine ({mine})
        </Button>
        <Button type="button" size="xs" variant="outline" onClick={onKeepTheirs}>
          Keep theirs
        </Button>
      </div>
    </div>
  );
}

function FieldStatus<T extends FieldValue>({ field, display }: { field: Field<T>; display: (v: T) => string }) {
  if (field.phase === "saving") {
    return (
      <p className="text-xs text-muted-foreground" aria-live="polite">
        Saving…
      </p>
    );
  }
  if (field.phase === "conflict") {
    return (
      <ConflictPrompt
        theirs={display(field.theirs as T)}
        mine={display(field.draft)}
        onKeepMine={() => void field.keepMine()}
        onKeepTheirs={field.keepTheirs}
      />
    );
  }
  if (field.phase === "error") {
    return (
      <p role="alert" className="text-xs text-crit">
        {field.message}{" "}
        <button type="button" onClick={field.revert} className="underline">
          Undo
        </button>
      </p>
    );
  }
  return null;
}

function Shell<T extends FieldValue>({
  id,
  label,
  help,
  hint,
  field,
  display,
  hideLabel = false,
  children,
}: {
  id: string;
  label: string;
  help?: FieldHelp;
  hint?: ReactNode;
  field: Field<T>;
  display: (v: T) => string;
  /** The label stays for screen readers only, for an input under a column heading (that heading carries the (i)). */
  hideLabel?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className={hideLabel ? "sr-only" : "flex items-center"}>
        <label htmlFor={id} className="text-xs font-medium text-fg-2">
          {label}
        </label>
        {help && !hideLabel && <Help label={label} {...help} />}
      </span>
      {children}
      {hint && field.phase === "idle" && <p className="text-xs text-muted-foreground">{hint}</p>}
      <FieldStatus field={field} display={display} />
    </div>
  );
}

const showText = (v: string | null) => (v === null || v === "" ? "blank" : v);

export function TextField({
  label,
  value,
  save,
  optional = false,
  multiline = false,
  type = "text",
  disabled,
  hint,
  help,
}: {
  label: string;
  value: string | null;
  save: Saver<string | null>;
  /** Blank saves as null; otherwise blank is refused. */
  optional?: boolean;
  multiline?: boolean;
  type?: "text" | "email";
  disabled?: boolean;
  hint?: ReactNode;
  help?: FieldHelp;
}) {
  const id = useId();
  const field = useField<string | null>(value, async (base, next) => {
    const cleaned = next === null ? null : next.trim() || null;
    if (cleaned === null && !optional) return { status: "error", message: `${label} can't be blank.` };
    return save(base, cleaned);
  });
  const props = {
    id,
    disabled,
    value: field.draft ?? "",
    onChange: (e: { target: { value: string } }) => field.edit(e.target.value),
    onBlur: () => void field.commit(),
    onKeyDown: (e: KeyboardEvent) => {
      if (e.key === "Escape") field.revert();
      if (e.key === "Enter" && !multiline) void field.commit();
    },
  };
  return (
    <Shell id={id} label={label} help={help} hint={hint} field={field} display={showText}>
      {multiline ? <Textarea rows={2} {...props} /> : <Input type={type} {...props} />}
    </Shell>
  );
}

/** Dates save on change: the browser's picker commits a whole value at once. */
export function DateField({
  label,
  value,
  save,
  disabled,
  help,
}: {
  label: string;
  value: string | null;
  save: Saver<string | null>;
  disabled?: boolean;
  help?: FieldHelp;
}) {
  const id = useId();
  const field = useField<string | null>(value, (base, next) => save(base, next || null));
  return (
    <Shell id={id} label={label} help={help} field={field} display={(v) => v || "blank"}>
      <Input
        id={id}
        type="date"
        disabled={disabled}
        value={field.draft ?? ""}
        onChange={(e) => void field.commit(e.target.value || null)}
      />
    </Shell>
  );
}

export function NumberField({
  label,
  value,
  save,
  optional = false,
  scale = 1,
  unit,
  min,
  max,
  step,
  placeholder,
  disabled,
  hint,
  help,
  hideLabel,
}: {
  label: string;
  value: number | null;
  save: Saver<number | null>;
  /** Show the label to screen readers only: for a table cell under a column heading. */
  hideLabel?: boolean;
  optional?: boolean;
  /** Shown value = stored × scale, e.g. 100 to edit a fraction as a percentage. */
  scale?: number;
  unit?: string;
  /** Limits on the shown value. */
  min?: number;
  max?: number;
  step?: number;
  placeholder?: string;
  disabled?: boolean;
  hint?: ReactNode;
  help?: FieldHelp;
}) {
  const id = useId();
  const toText = (v: number | null) => (v === null ? "" : String(Math.round(Number(v) * scale * 1e6) / 1e6));
  const field = useField<string>(toText(value), async (base, next) => {
    const trimmed = next.trim();
    const shown = trimmed === "" ? null : Number(trimmed);
    if (shown === null && !optional) return { status: "error", message: `${label} can't be blank.` };
    if (shown !== null && !Number.isFinite(shown)) return { status: "error", message: "Enter a number." };
    if (shown !== null && ((min !== undefined && shown < min) || (max !== undefined && shown > max))) {
      return { status: "error", message: `Enter a number from ${min ?? "–"} to ${max ?? "–"}.` };
    }
    const parse = (s: number | null) => (s === null ? null : s / scale);
    const baseValue = base.trim() === "" ? null : Number(base) / scale;
    return mapOutcome(await save(baseValue, parse(shown)), toText);
  });
  const display = (v: string) => (v === "" ? "blank" : unit ? `${v} ${unit}` : v);
  return (
    <Shell id={id} label={label} help={help} hint={hint} field={field} display={display} hideLabel={hideLabel}>
      <span className="flex items-center gap-1.5">
        <Input
          id={id}
          type="number"
          inputMode="decimal"
          min={min}
          max={max}
          step={step}
          placeholder={placeholder}
          disabled={disabled}
          value={field.draft}
          className="tabular-nums"
          onChange={(e) => field.edit(e.target.value)}
          onBlur={() => void field.commit()}
          onKeyDown={(e) => {
            if (e.key === "Escape") field.revert();
            if (e.key === "Enter") void field.commit();
          }}
        />
        {unit && <span className="shrink-0 text-muted-foreground">{unit}</span>}
      </span>
    </Shell>
  );
}

export interface SelectOption {
  value: string;
  label: string;
}

/** A choice, saved on change. "" is the value for "none" (null). */
export function SelectField({
  label,
  value,
  save,
  options,
  noneLabel,
  disabled,
  hint,
  help,
}: {
  label: string;
  value: string | null;
  save: Saver<string | null>;
  options: SelectOption[];
  /** Offer "none" (saved as null) under this label. */
  noneLabel?: string;
  disabled?: boolean;
  hint?: ReactNode;
  help?: FieldHelp;
}) {
  const id = useId();
  const field = useField<string | null>(value, (base, next) => save(base, next || null));
  const names = new Map(options.map((o) => [o.value, o.label]));
  const display = (v: string | null) => (v ? (names.get(v) ?? "a removed item") : (noneLabel ?? "none"));
  return (
    <Shell id={id} label={label} help={help} hint={hint} field={field} display={display}>
      <NativeSelect
        id={id}
        disabled={disabled}
        value={field.draft ?? ""}
        onChange={(e) => void field.commit(e.target.value || null)}
      >
        {noneLabel !== undefined && <option value="">{noneLabel}</option>}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
        {/* A stored value that is no longer an option (a removed role) still shows. */}
        {field.draft && !names.has(field.draft) && <option value={field.draft}>A removed item</option>}
      </NativeSelect>
    </Shell>
  );
}

export function ToggleField({
  label,
  value,
  save,
  onLabel,
  offLabel,
  disabled,
  hint,
  help,
}: {
  label: string;
  value: boolean;
  save: Saver<boolean>;
  onLabel: string;
  offLabel: string;
  disabled?: boolean;
  hint?: ReactNode;
  help?: FieldHelp;
}) {
  const id = useId();
  const field = useField<boolean>(value, save);
  return (
    <Shell id={id} label={label} help={help} hint={hint} field={field} display={(v) => (v ? onLabel : offLabel)}>
      <span className="flex items-center gap-2 py-1.5">
        <input
          id={id}
          type="checkbox"
          disabled={disabled}
          checked={field.draft}
          onChange={(e) => void field.commit(e.target.checked)}
          className="size-4 accent-[var(--accent)]"
        />
        <span>{field.draft ? onLabel : offLabel}</span>
      </span>
    </Shell>
  );
}

export interface ChecklistOption {
  id: string;
  label: string;
  sublabel?: string;
}

/** A set of ids, saved as a whole on each tick. */
export function ChecklistField({
  label,
  value,
  save,
  options,
  hint,
  emptyLabel = "none",
  disabled,
  help,
}: {
  label: string;
  value: readonly string[];
  save: Saver<readonly string[]>;
  options: ChecklistOption[];
  hint?: ReactNode;
  emptyLabel?: string;
  disabled?: boolean;
  help?: FieldHelp;
}) {
  const id = useId();
  const field = useField<readonly string[]>(value, save);
  const names = new Map(options.map((o) => [o.id, o.label]));
  const display = (ids: readonly string[]) =>
    ids.length ? ids.map((i) => names.get(i) ?? "a removed item").join(", ") : emptyLabel;
  const toggle = (option: string, on: boolean) => {
    const next = on ? [...field.draft, option] : field.draft.filter((v) => v !== option);
    void field.commit(next);
  };
  return (
    <fieldset className="flex flex-col gap-1" id={id}>
      <legend className="mb-1 flex items-center text-xs font-medium text-fg-2">
        {label}
        {help && <Help label={label} {...help} />}
      </legend>
      <ul className="flex flex-wrap gap-x-4 gap-y-1">
        {options.map((o) => (
          <li key={o.id}>
            <label className="flex items-center gap-1.5">
              <input
                type="checkbox"
                disabled={disabled || field.phase === "conflict"}
                checked={field.draft.includes(o.id)}
                onChange={(e) => toggle(o.id, e.target.checked)}
                className="size-4 accent-[var(--accent)]"
              />
              <span>
                {o.label}
                {o.sublabel && <span className="text-muted-foreground"> · {o.sublabel}</span>}
              </span>
            </label>
          </li>
        ))}
      </ul>
      {hint && field.phase === "idle" && <p className="text-xs text-muted-foreground">{hint}</p>}
      <FieldStatus field={field} display={display} />
    </fieldset>
  );
}
