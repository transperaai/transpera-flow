"use client";

// Editing a step in place on its card (issue #8): name, role, pinned person,
// hands-on time and wait. Each field commits on its own, on Enter or when
// focus leaves it, so each is one per-field save and one undo step. Escape
// drops the field's draft and closes the editor; focus goes back to the card.

import { createContext, useContext, useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { ProcessBundle, StepRow } from "@transpera-flow/db";
import type { ProcessEditor } from "@/lib/editor/editor";
import { commitInline, inlineDraft, type InlineField } from "@/lib/editor/inline-edit";
import { selectableRoles } from "@/lib/roles";

export interface InlineEditing {
  editor: ProcessEditor;
  bundle: ProcessBundle;
  /** Close the editor; `refocus` puts focus back on the card. */
  stop: (id: string, refocus: boolean) => void;
}

export const InlineEditContext = createContext<InlineEditing | null>(null);

const inputClass =
  "w-full min-w-0 rounded-token border border-line bg-panel px-1.5 py-0.5 text-xs text-fg tabular-nums aria-[invalid=true]:border-crit";

export function NodeInlineEditor({ step, focus }: { step: StepRow; focus: InlineField }) {
  const ctx = useContext(InlineEditContext);
  const ref = useRef<HTMLDivElement>(null);
  const working = step.kind !== "start" && step.kind !== "end" && step.kind !== "group" && !step.child_process_id;

  useEffect(() => {
    const root = ref.current;
    const el = root?.querySelector<HTMLElement>(`[data-field="${focus}"]`) ?? root?.querySelector<HTMLElement>("input");
    el?.focus();
    if (el instanceof HTMLInputElement) el.select();
  }, [focus]);

  if (!ctx) return null;
  const { bundle } = ctx;
  const people = bundle.people.filter((p) => p.active || p.id === step.person_id).sort((a, b) => a.name.localeCompare(b.name));

  return (
    <div
      ref={ref}
      role="group"
      aria-label={`Edit ${step.name}`}
      // nodrag/nopan/nokey: typing and clicking here edits, it doesn't move or pan the map.
      className="nodrag nopan nokey flex cursor-auto flex-col gap-1.5 p-2 text-xs"
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) ctx.stop(step.id, false);
      }}
    >
      <TextInput ctx={ctx} step={step} field="name" label="Step name" />
      {working && (
        <>
          <div className="grid grid-cols-[3.25rem_1fr] items-center gap-x-1.5 gap-y-1">
            <label htmlFor={`${step.id}-role`} className="text-fg-2">
              Role
            </label>
            <Select ctx={ctx} step={step} field="role_id" id={`${step.id}-role`} none="No role" options={selectableRoles(bundle.roles, [step.role_id])} />
            <label htmlFor={`${step.id}-person`} className="text-fg-2">
              Pinned
            </label>
            <Select ctx={ctx} step={step} field="person_id" id={`${step.id}-person`} none="Anyone in the role" options={people} />
          </div>
          <div className="grid grid-cols-2 gap-1.5">
            <TextInput ctx={ctx} step={step} field="work_hours" label="Hands-on hours" short="Work h" />
            <TextInput ctx={ctx} step={step} field="wait_hours" label="Wait hours" short="Wait h" />
          </div>
        </>
      )}
      <p className="text-[10px] text-fg-3">Enter saves · Esc cancels</p>
    </div>
  );
}

/**
 * Commit `text` to `field`; returns false (and says why) if it can't be saved.
 */
function useCommit(ctx: InlineEditing, step: StepRow, field: InlineField) {
  const [error, setError] = useState<string | null>(null);
  const commit = (text: string): boolean => {
    const bundle = ctx.editor.getState().bundle;
    const r = commitInline(bundle, step.id, field, text);
    if ("error" in r) {
      setError(r.error);
      return false;
    }
    setError(null);
    if (!r.edit) return true;
    ctx.editor.run(() => r.edit);
    return true;
  };
  return { error, setError, commit };
}

function TextInput({ ctx, step, field, label, short }: { ctx: InlineEditing; step: StepRow; field: InlineField; label: string; short?: string }) {
  const stored = inlineDraft(ctx.bundle, step.id, field);
  const [draft, setDraft] = useState(stored);
  // The stored value editing started from. When it changes (a save or an undo)
  // the input takes it, unless the user is typing: then the typing stays.
  const [base, setBase] = useState(stored);
  if (base !== stored && (draft === base || draft === stored)) {
    setBase(stored);
    setDraft(stored);
  }
  const { error, setError, commit } = useCommit(ctx, step, field);
  // Set once Enter or Escape has dealt with the draft, so the blur that follows doesn't commit again.
  const done = useRef(false);
  const errorId = `${step.id}-${field}-error`;

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (commit(draft)) {
        done.current = true;
        ctx.stop(step.id, true);
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      done.current = true;
      setDraft(stored);
      ctx.stop(step.id, true);
    }
  };
  const input = (
    <input
      data-field={field}
      aria-label={label}
      aria-invalid={error ? true : undefined}
      aria-describedby={error ? errorId : undefined}
      inputMode={field === "name" ? undefined : "decimal"}
      value={draft}
      maxLength={field === "name" ? 200 : 12}
      onChange={(e) => {
        setDraft(e.target.value);
        setError(null);
      }}
      onKeyDown={onKeyDown}
      onBlur={() => {
        if (done.current) return;
        // A value that can't be saved is dropped when focus leaves; the message stays until the next change.
        if (!commit(draft)) setDraft(stored);
      }}
      className={`${inputClass} ${field === "name" ? "font-semibold" : "font-mono"}`}
    />
  );
  return (
    <div className="flex flex-col gap-0.5">
      {short ? (
        <label className="flex flex-col gap-0.5">
          <span className="text-fg-2" aria-hidden>
            {short}
          </span>
          {input}
        </label>
      ) : (
        input
      )}
      {error && (
        <p id={errorId} role="alert" className="text-[10px] text-crit">
          {error}
        </p>
      )}
    </div>
  );
}

function Select({
  ctx,
  step,
  field,
  id,
  none,
  options,
}: {
  ctx: InlineEditing;
  step: StepRow;
  field: "role_id" | "person_id";
  id: string;
  none: string;
  options: { id: string; name: string }[];
}) {
  const { error, commit } = useCommit(ctx, step, field);
  const value = step[field] ?? "";
  return (
    <>
      <select
        id={id}
        data-field={field}
        value={value}
        onChange={(e) => commit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === "Escape") {
            e.preventDefault();
            ctx.stop(step.id, true);
          }
        }}
        className={inputClass}
      >
        <option value="">{none}</option>
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}
          </option>
        ))}
        {value && !options.some((o) => o.id === value) && <option value={value}>A removed item</option>}
      </select>
      {error && (
        <p role="alert" className="col-span-2 text-[10px] text-crit">
          {error}
        </p>
      )}
    </>
  );
}
