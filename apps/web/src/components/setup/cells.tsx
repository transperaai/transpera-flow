"use client";

// The cells the two Set up tables are made of. An editable cell is an ordinary self-saving field with its label for screen readers only (its
// column heading carries the (i)); a Viewer gets the value as text, never an input. Under a cell: a small source label when the number
// isn't one somebody typed, and "missing" when the capacity figures need it and it isn't entered yet.

import type { ReactNode } from "react";
import { NumberField, SelectField, TextField, type FieldHelp } from "@/components/fields";
import { Help } from "@/components/help";
import { TableHead } from "@/components/ui/table";
import type { Saver } from "@/lib/fields/field-controller";
import { sourceLabel } from "@transpera-flow/db";

/** A column heading with its (i): a plain-English line and an example. */
export function HeadHelp({ children, help, align = "right", className }: { children: ReactNode; help: FieldHelp & { label?: string }; align?: "left" | "right"; className?: string }) {
  const label = help.label ?? (typeof children === "string" ? children : "this column");
  return (
    <TableHead className={`${align === "right" ? "text-right" : ""} ${className ?? ""}`}>
      <span className="inline-flex items-center whitespace-nowrap">
        {children}
        <Help label={label} description={help.description} example={help.example} />
      </span>
    </TableHead>
  );
}

/** The small marks under a number. */
export function Marks({ provenance, column, missing, value }: { provenance?: unknown; column: string; missing?: boolean; value: unknown }) {
  const label = value === null || value === undefined ? null : sourceLabel(provenance, column);
  if (!label && !missing) return null;
  return (
    <span className="mt-0.5 flex flex-wrap gap-x-2 text-2xs text-fg-3">
      {missing && <span data-missing className="font-medium text-warn">missing</span>}
      {label && <span data-source>{label}</span>}
    </span>
  );
}

interface NumberCellProps {
  label: string;
  value: number | null;
  save: Saver<number | null>;
  canEdit: boolean;
  /** The editable value is stored × scale (100 shows a share as a percentage). */
  scale?: number;
  unit?: string;
  min?: number;
  max?: number;
  step?: number;
  /** Blank is allowed (null: not entered, or "use the tier's"). */
  optional?: boolean;
  /** What a blank cell uses, shown greyed. */
  placeholder?: string;
  help?: FieldHelp;
  provenance?: unknown;
  column?: string;
  missing?: boolean;
  /** Decimals when read as text. */
  digits?: number;
}

const fmt = (v: number, digits: number) => (Math.round(v * 10 ** digits) / 10 ** digits).toLocaleString("en-AU", { maximumFractionDigits: digits });

/** A number in a table cell. */
export function NumberCell({ label, value, save, canEdit, scale = 1, unit, min, max, step, optional = true, placeholder, help, provenance, column, missing, digits = 2 }: NumberCellProps) {
  return (
    <div className="flex min-w-16 flex-col">
      {canEdit ? (
        <NumberField label={label} hideLabel value={value} save={save} optional={optional} scale={scale} unit={unit} min={min} max={max} step={step} placeholder={placeholder} help={help} />
      ) : (
        <span className="text-right tabular-nums" aria-label={label}>
          {value === null ? <span className="text-fg-3">{placeholder ?? "–"}</span> : `${fmt(value * scale, digits)}${unit ? ` ${unit}` : ""}`}
        </span>
      )}
      <Marks provenance={provenance} column={column ?? ""} missing={missing && value === null} value={value} />
    </div>
  );
}

/** A name in a table cell. */
export function TextCell({ label, value, save, canEdit, optional }: { label: string; value: string | null; save: Saver<string | null>; canEdit: boolean; optional?: boolean }) {
  return canEdit ? <TextField label={label} value={value} save={save} optional={optional} /> : <span aria-label={label}>{value ?? "–"}</span>;
}

/** A choice in a table cell. */
export function SelectCell({
  label,
  value,
  save,
  options,
  canEdit,
  noneLabel,
}: {
  label: string;
  value: string | null;
  save: Saver<string | null>;
  options: { value: string; label: string }[];
  canEdit: boolean;
  noneLabel?: string;
}) {
  if (canEdit) return <SelectField label={label} value={value} save={save} options={options} noneLabel={noneLabel} />;
  const shown = options.find((o) => o.value === value)?.label;
  return <span aria-label={label}>{shown ?? noneLabel ?? "–"}</span>;
}

/** The notes under a table (the prototype's). */
export function Note({ children }: { children: ReactNode }) {
  return <p className="mt-2 text-xs text-fg-2">{children}</p>;
}
