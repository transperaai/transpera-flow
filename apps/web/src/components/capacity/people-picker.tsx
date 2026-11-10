"use client";

// The "What if someone leaves?" picker: a full-width button that opens a checkbox list of people, grouped by department, so one or several
// can be taken out at once. Keyboard: Enter, Space or ArrowDown on the button opens it and focuses the first checked (or first) person;
// ArrowUp/ArrowDown/Home/End move between people, Space ticks, Escape closes and returns to the button, Tab moves on as usual and a
// click or focus outside closes it.

import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

export interface PickerPerson {
  id: string;
  name: string;
  /** A short note after the name ("12 clients", "Content team"). */
  note?: string;
}

export interface PickerGroup {
  name: string;
  people: PickerPerson[];
}

/** "Diya", "Diya and Laura", "Diya, Laura and Zach", then "4 people". */
export function pickedLabel(names: string[]): string {
  if (names.length === 0) return "Choose who leaves";
  if (names.length > 3) return `${names.length} people`;
  return names.join(", ");
}

export function PeoplePicker({ groups, value, onChange, label }: { groups: PickerGroup[]; value: string[]; onChange: (ids: string[]) => void; label: string }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const id = useId();
  const order = groups.flatMap((g) => g.people);
  const nameOf = new Map(order.map((p) => [p.id, p.name]));
  const picked = new Set(value);
  const names = order.filter((p) => picked.has(p.id)).map((p) => p.name);

  useEffect(() => {
    if (!open) return;
    const away = (e: Event) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", away);
    document.addEventListener("focusin", away);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("focusin", away);
    };
  }, [open]);

  const boxes = () => [...(list.current?.querySelectorAll<HTMLInputElement>("input[type=checkbox]") ?? [])];
  const focusFirst = () =>
    requestAnimationFrame(() => {
      const all = boxes();
      (all.find((b) => b.checked) ?? all[0])?.focus();
    });

  const toggle = (pid: string) => onChange(picked.has(pid) ? value.filter((v) => v !== pid) : order.filter((p) => picked.has(p.id) || p.id === pid).map((p) => p.id));

  const onButtonKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === "ArrowDown" || (!open && (e.key === "Enter" || e.key === " "))) {
      e.preventDefault();
      setOpen(true);
      focusFirst();
    }
  };
  const onListKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
      button.current?.focus();
      return;
    }
    const all = boxes();
    const i = all.indexOf(document.activeElement as HTMLInputElement);
    const go = (j: number) => all[Math.max(0, Math.min(all.length - 1, j))]?.focus();
    if (e.key === "ArrowDown") go(i + 1);
    else if (e.key === "ArrowUp") go(i - 1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(all.length - 1);
    else if (e.key === "Enter" && i >= 0) all[i]!.click();
    else return;
    e.preventDefault();
  };

  return (
    <div ref={wrap} className="relative" data-leaver-picker>
      <span id={`${id}-label`} className="mb-1 block text-xs font-medium text-fg-2">
        {label}
      </span>
      <div className="flex items-stretch gap-2">
        <button
          ref={button}
          type="button"
          className="flex min-h-10 min-w-0 flex-1 items-center justify-between gap-2 rounded-md border border-line-2 bg-panel px-3 py-2 text-left text-sm font-medium shadow-xs outline-none hover:bg-panel-2 focus-visible:ring-2 focus-visible:ring-ring"
          aria-haspopup="true"
          aria-expanded={open}
          aria-controls={`${id}-list`}
          aria-labelledby={`${id}-label ${id}-value`}
          onClick={() => {
            setOpen((o) => !o);
            if (!open) focusFirst();
          }}
          onKeyDown={onButtonKey}
          data-leaver-select
        >
          <span id={`${id}-value`} className={cn("truncate", !names.length && "text-muted-foreground")} title={names.join(", ")}>
            {pickedLabel(names)}
          </span>
          <ChevronDown aria-hidden className={cn("size-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")} />
        </button>
        {value.length > 0 && (
          <button
            type="button"
            className="rounded-md border border-line px-3 text-sm text-fg-2 outline-none hover:bg-panel-2 focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => {
              onChange([]);
              button.current?.focus();
            }}
            data-leaver-clear
          >
            Clear
          </button>
        )}
      </div>
      {open && (
        <div
          ref={list}
          id={`${id}-list`}
          role="group"
          aria-label={label}
          className="absolute inset-x-0 top-full z-20 mt-1 max-h-80 overflow-y-auto rounded-md border border-line-2 bg-panel p-1.5 shadow-[var(--shadow)]"
          onKeyDown={onListKey}
          data-leaver-options
        >
          {groups.map((g) => (
            <fieldset key={g.name} className="min-w-0 border-0 p-0 not-first:mt-1.5">
              <legend className="px-2 pt-1 pb-0.5 text-2xs font-semibold tracking-wider text-muted-foreground uppercase">{g.name}</legend>
              {g.people.map((p) => (
                <label key={p.id} className="flex cursor-pointer items-center gap-2.5 rounded-sm px-2 py-1.5 text-sm hover:bg-panel-2 has-focus-visible:bg-panel-2 has-focus-visible:ring-2 has-focus-visible:ring-ring" data-leaver-option={nameOf.get(p.id)}>
                  <input type="checkbox" className="size-4 shrink-0 accent-[var(--accent)] outline-none" checked={picked.has(p.id)} onChange={() => toggle(p.id)} />
                  <span className="min-w-0 truncate">{p.name}</span>
                  {p.note && <span className="ml-auto shrink-0 text-xs text-muted-foreground tabular-nums">{p.note}</span>}
                </label>
              ))}
            </fieldset>
          ))}
        </div>
      )}
    </div>
  );
}
