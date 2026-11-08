"use client";

// The Acknowledge dialog (issue #112, A47; prototype: "Acknowledge as an issue"). One dialog for three jobs:
// acknowledging an insight (opened with its rating, steps and sources filled in), "+ New issue" (empty) and
// "Edit issue". It only edits a draft and reports it; the caller saves it (acknowledgeInsight, or the issue store).

import { useState, type ReactNode } from "react";
import { RATING_LABELS, type Rating } from "@transpera-flow/engine";
import { Help, HelpLabel } from "@/components/help";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { DIALOG_RATINGS, RATING_MEANINGS, hasErrors, toggle, validateDraft, type DraftErrors, type IssueDraft, type IssueFormOptions } from "@/lib/issues/draft";
import { MAX_TITLE } from "@/lib/issues/validate";
import { cn } from "@/lib/utils";

/** The (i) texts: what each control does, in plain words, with an example. */
export const ACK_HELP = {
  title: {
    label: "Title",
    description: "A short sentence saying what is wrong. It is how the issue is listed everywhere.",
    example: "Proposals wait too long for review.",
  },
  rating: {
    label: "How bad is it?",
    description: "How serious the problem is, in the same four ratings the analysis uses. It sets the colour of the issue.",
    example: "Operational risk for a step that only one person can do.",
  },
  process: {
    label: "Process",
    description: "The process the issue is in. An issue belongs to a process, as its solutions do.",
    example: "Lead to live.",
  },
  owners: {
    label: "Owners",
    description: "The people who will sort this out. More than one is fine; each is told it is theirs.",
    example: "Rosa Diaz and Priya Shah.",
  },
  sources: {
    label: "Sources",
    description: "Interviews, notes or documents that show the problem is real. Linked sources stay with the issue so others can check it.",
    example: "Interview with Maya Collins: “I review every report before it goes out.”",
  },
} as const;

export type AckMode = "acknowledge" | "new" | "edit";

export interface AcknowledgeDialogProps {
  /** Whether it is showing. The dialog starts again from `draft` each time it opens. */
  open: boolean;
  mode: AckMode;
  draft: IssueDraft;
  /** The insight it comes from (acknowledge) or the number of the issue (edit), for the heading. */
  fromTitle?: string;
  issueNumber?: number | null;
  options: IssueFormOptions;
  /** Saves it. Resolve to something falsy when the save failed, so the dialog stays open and shows `error`. */
  onSubmit: (draft: IssueDraft) => Promise<unknown>;
  onClose: () => void;
  busy?: boolean;
  error?: string | null;
}

const heading = (mode: AckMode, n?: number | null) => (mode === "edit" ? (n ? `Edit issue #${n}` : "Edit issue") : mode === "acknowledge" ? "Acknowledge as an issue" : "New issue");

export function AcknowledgeDialog(props: AcknowledgeDialogProps) {
  const { open, mode, fromTitle, issueNumber, onClose } = props;
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        className="max-h-[92svh] overflow-y-auto sm:max-w-2xl"
        data-ack-dialog
        data-ack-mode={mode}
        onOpenAutoFocus={(e) => {
          // Not the first (i): its tooltip would cover the title field. Focus the title.
          e.preventDefault();
          (e.currentTarget as HTMLElement).querySelector<HTMLInputElement>("#ack-title")?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>{heading(mode, issueNumber)}</DialogTitle>
          <DialogDescription>{mode === "acknowledge" && fromTitle ? `From insight: ${fromTitle}` : "An issue is a problem you have confirmed. It shows on the map once it is saved."}</DialogDescription>
        </DialogHeader>
        {/* Keyed on opening, so each time starts from the draft it was given. */}
        {open && <Form key={props.draft.id ?? props.draft.from?.detected_key ?? "new"} {...props} />}
      </DialogContent>
    </Dialog>
  );
}

function Form({ mode, draft: initial, options, onSubmit, onClose, busy, error }: AcknowledgeDialogProps) {
  const [draft, setDraft] = useState<IssueDraft>(initial);
  const [errors, setErrors] = useState<DraftErrors>({});
  const [working, setWorking] = useState(false);
  const set = (patch: Partial<IssueDraft>) => setDraft((d) => ({ ...d, ...patch }));

  const submit = async () => {
    const found = validateDraft(draft);
    setErrors(found);
    if (hasErrors(found)) return;
    setWorking(true);
    try {
      if (await onSubmit(draft)) onClose();
    } finally {
      setWorking(false);
    }
  };
  const disabled = working || busy;

  return (
    <form
      className="flex flex-col gap-4"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <Field label={ACK_HELP.title} htmlFor="ack-title" error={errors.title}>
        <Input
          id="ack-title"
          value={draft.title}
          maxLength={MAX_TITLE}
          placeholder="What's wrong, in a sentence"
          aria-invalid={!!errors.title}
          aria-describedby={errors.title ? "ack-title-error" : undefined}
          onChange={(e) => set({ title: e.target.value })}
        />
      </Field>

      <fieldset className="flex flex-col gap-1.5">
        <legend className="flex items-center text-xs font-medium text-muted-foreground uppercase">
          {ACK_HELP.rating.label}
          <Help {...ACK_HELP.rating} />
        </legend>
        <div role="radiogroup" aria-label="How bad is it?" className="grid gap-1.5 sm:grid-cols-2">
          {DIALOG_RATINGS.map((r) => (
            <RatingChoice key={r} rating={r} on={draft.rating === r} onPick={() => set({ rating: r })} />
          ))}
        </div>
      </fieldset>

      {(options.processes.length > 1 || errors.process) && (
      <div className="flex flex-col gap-2">
        {options.processes.length > 1 && (
          <label className="flex max-w-xs flex-col gap-0.5">
            <HelpLabel {...ACK_HELP.process} />
            <NativeSelect
              aria-label="Process"
              value={draft.processId ?? ""}
              onChange={(e) => set({ processId: e.target.value || null, stepIds: [] })}
            >
              {options.processes.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </NativeSelect>
          </label>
        )}
        {errors.process && (
          <p role="alert" className="text-xs text-crit" id="ack-process-error">
            {errors.process}
          </p>
        )}
      </div>
      )}

      <fieldset className="flex flex-col gap-1.5">
        <legend className="flex items-center text-xs font-medium text-muted-foreground uppercase">
          {ACK_HELP.owners.label}
          <Help {...ACK_HELP.owners} />
        </legend>
        {options.people.length ? (
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Owners">
            {options.people.map((p) => (
              <Chip key={p.id} on={draft.ownerIds.includes(p.id)} onClick={() => set({ ownerIds: toggle(draft.ownerIds, p.id) })}>
                {p.name}
              </Chip>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">Nobody to pick yet. Add people under People.</p>
        )}
      </fieldset>

      <fieldset className="flex flex-col gap-1.5">
        <legend className="flex items-center text-xs font-medium text-muted-foreground uppercase">
          {ACK_HELP.sources.label}
          <Help {...ACK_HELP.sources} />
        </legend>
        {options.sources.length ? (
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Sources">
            {options.sources.map((s) => (
              <Chip key={s.id} on={draft.sourceIds.includes(s.id)} onClick={() => set({ sourceIds: toggle(draft.sourceIds, s.id) })}>
                {s.title}
              </Chip>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No sources yet. Add one under Sources, then link it here.</p>
        )}
      </fieldset>

      {error && (
        <p role="alert" className="rounded-lg border border-crit bg-crit-soft p-2 text-xs">
          {error}
        </p>
      )}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" disabled={disabled}>
          {mode === "edit" ? "Save" : "Add to issues"}
        </Button>
      </DialogFooter>
    </form>
  );
}

function Field({ label, htmlFor, error, children }: { label: { label: string; description: string; example: string }; htmlFor: string; error?: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="flex items-center text-xs font-medium text-muted-foreground uppercase">
        <label htmlFor={htmlFor}>{label.label}</label>
        <Help {...label} />
      </span>
      {children}
      {error && (
        <p role="alert" id={`${htmlFor}-error`} className="text-xs text-crit">
          {error}
        </p>
      )}
    </div>
  );
}

function RatingChoice({ rating, on, onPick }: { rating: Rating; on: boolean; onPick: () => void }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={on}
      data-rating={rating}
      onClick={onPick}
      className={cn(
        "flex flex-col gap-0.5 rounded-lg border px-3 py-2 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring",
        on ? "border-foreground bg-muted font-semibold" : "bg-card hover:bg-muted/60",
      )}
      style={on ? { background: `var(--rate-${rating}-soft)` } : undefined}
    >
      <b className="flex items-center gap-1.5 font-semibold">
        <i aria-hidden className="size-2 rounded-full" style={{ background: `var(--rate-${rating})` }} />
        {RATING_LABELS[rating]}
      </b>
      <span className="text-xs font-normal text-muted-foreground">{RATING_MEANINGS[rating]}</span>
    </button>
  );
}

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={cn(
        "inline-flex h-7 max-w-full items-center rounded-full border px-2.5 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring",
        on ? "border-accent bg-accent-soft font-semibold" : "bg-card hover:bg-muted",
      )}
    >
      <span className="truncate">{children}</span>
    </button>
  );
}
