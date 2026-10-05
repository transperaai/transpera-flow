"use client";

// The Add / Link source dialog (issue #118, A53; prototype: "Add source" and "Link source"). Title, type, date and quote,
// then "Link it to (required)": what kind of thing, and which one. A source is never added without a link. With a source
// given it only asks for the link ("Link source"). Reusable: any screen's "+ Link" opens it with `preset` set to the thing
// the screen is about, and gets the draft back to save. It edits a draft and reports it; the caller saves it.

import { useState, type ReactNode } from "react";
import type { LinkTargets, SourceLinkKind, SourceLinkTarget, SourceRow } from "@transpera-flow/db";
import { Help } from "@/components/help";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import {
  KIND_CHOICES,
  LINK_KIND_LABELS,
  SOURCE_LINK_KINDS,
  draftToSubmission,
  emptyDraft,
  NEEDS_A_SOURCE,
  hasErrors,
  targetOptions,
  validateDraft,
  type SourceDraft,
  type SourceDraftErrors,
} from "@/lib/sources/links";
import { MAX_TITLE, SOURCE_KIND_LABELS, type SourceInput } from "@/lib/sources/validate";
import { cn } from "@/lib/utils";

/** The (i) texts: what each control does, in plain words, with an example. */
export const SOURCE_DIALOG_HELP = {
  title: {
    label: "Title",
    description: "A name that tells people what this source is, so they can find it again.",
    example: "Interview: Leah Brooks.",
  },
  type: {
    label: "Type",
    description: "What sort of material it is: a Transcript of a conversation, Notes someone wrote up, Data such as an export or a spreadsheet, or a Screenshot of a screen or document.",
    example: "Data, for the HubSpot export of last year's deals.",
  },
  date: {
    label: "Date",
    description: "When the conversation happened or the notes were written. Leave it blank if you don't know.",
    example: "12 September.",
  },
  quote: {
    label: "Quote or excerpt",
    description: "The words from the source that matter most. People checking the evidence read this first, and the full text can be added later.",
    example: "“I review every single report before it goes out. Most weeks that's my Sunday.”",
  },
  kind: {
    label: "Link it to (required)",
    description: "What this source is evidence for. A source that isn't linked to anything doesn't count as evidence, so pick at least one thing. You can link it to more things afterwards.",
    example: "A step, when the quote is about how long that step takes.",
  },
  choice: {
    label: "New or existing source",
    description: "Add a new source here, or link one you have already added to this. Either way, it is linked to the thing you opened this from.",
    example: "Use a source you already have when the ops notes also back up this step.",
  },
  existing: {
    label: "Source",
    description: "A source you have already added. Linking it here doesn't change what else it is linked to.",
    example: "Interview: Maya Collins.",
  },
  target: {
    label: "Which one",
    description: "The exact process, step, insight, issue or solution. The list shows what your workspace has.",
    example: "Review monthly report.",
  },
} as const;

/** The part of a source the dialog needs: which one it is and what to call it. */
export type DialogSource = Pick<SourceRow, "id" | "title" | "kind">;

/** What the dialog gives back: a new source with its first link, or a link for a source that is already there. */
export type SourceSubmission = { kind: "add"; input: SourceInput; link: SourceLinkTarget } | { kind: "link"; source: DialogSource; link: SourceLinkTarget };

export interface SourceDialogProps {
  /** Whether it is showing. The dialog starts again from its props each time it opens. */
  open: boolean;
  targets: LinkTargets;
  /** The source to link ("Link source"); without one the dialog adds a new source ("Add source"). */
  source?: DialogSource | null;
  /** A thing to have picked already, when a screen's "+ Link" opens the dialog for it. */
  preset?: SourceLinkTarget | null;
  /** What `preset` is called ("Step: Check fit"), for the line saying what an existing source will be linked to. */
  presetLabel?: string;
  /** Sources that could be linked to `preset` instead of adding a new one (the ones not linked to it yet). */
  existingSources?: readonly SourceRow[];
  /** Saves it. Resolve to an error message, or null when it saved (the dialog then closes). */
  onSubmit: (submission: SourceSubmission) => Promise<string | null>;
  onClose: () => void;
}

export function SourceDialog(props: SourceDialogProps) {
  const { open, source, onClose } = props;
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        className="max-h-[92svh] overflow-y-auto sm:max-w-xl"
        data-source-dialog
        data-source-mode={source ? "link" : "add"}
        onOpenAutoFocus={(e) => {
          // Not the first (i): its tooltip would cover the field. Focus the title, or the picker when the source is already named.
          e.preventDefault();
          (e.currentTarget as HTMLElement).querySelector<HTMLElement>("#src-title, #src-target")?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>{source ? "Link source" : "Add source"}</DialogTitle>
          <DialogDescription>
            {source ? "Say what this source is evidence for. One more link doesn't replace the others." : "Every source must be linked to something, or it won't count as evidence."}
          </DialogDescription>
        </DialogHeader>
        {/* Keyed on opening, so each time starts from what it was given. */}
        {open && <Form key={source?.id ?? "new"} {...props} />}
      </DialogContent>
    </Dialog>
  );
}

const today = () => new Date().toISOString().slice(0, 10);

function Form({ targets, source, preset, presetLabel, existingSources, onSubmit, onClose }: SourceDialogProps) {
  const [draft, setDraft] = useState<SourceDraft>(() => emptyDraft(preset, today()));
  // From a screen's "+ Link", a source you already have can be linked to that screen's thing instead of adding a new one.
  const canPickExisting = !source && !!preset && (existingSources?.length ?? 0) > 0;
  const [use, setUse] = useState<"new" | "existing">("new");
  const [picked, setPicked] = useState("");
  const existing = canPickExisting && use === "existing";
  const [errors, setErrors] = useState<SourceDraftErrors>({});
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const set = (patch: Partial<SourceDraft>) => setDraft((d) => ({ ...d, ...patch }));
  const options = targetOptions(draft.linkKind, targets);

  const submit = async () => {
    if (existing) {
      const chosen = existingSources!.find((s) => s.id === picked);
      if (!chosen) return setErrors({ link: NEEDS_A_SOURCE });
      setErrors({});
      setError(null);
      setWorking(true);
      try {
        const problem = await onSubmit({ kind: "link", source: chosen, link: preset! });
        if (problem) setError(problem);
        else onClose();
      } finally {
        setWorking(false);
      }
      return;
    }
    const found = validateDraft(draft, targets, !!source);
    setErrors(found);
    setError(null);
    if (hasErrors(found)) return;
    const made = draftToSubmission(source ? { ...draft, title: source.title } : draft, targets);
    if (!made.ok) return setErrors(made.errors);
    setWorking(true);
    try {
      const problem = await onSubmit(source ? { kind: "link", source, link: made.link } : { kind: "add", input: made.input, link: made.link });
      if (problem) setError(problem);
      else onClose();
    } finally {
      setWorking(false);
    }
  };

  return (
    <form
      className="flex flex-col gap-4"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      {canPickExisting && (
        <div role="group" aria-label="New or existing" className="flex flex-wrap items-center gap-1.5">
          <ChoiceChip on={use === "new"} onPick={() => setUse("new")}>
            Add a new source
          </ChoiceChip>
          <ChoiceChip on={use === "existing"} onPick={() => setUse("existing")}>
            Use a source you already have
          </ChoiceChip>
          <Help {...SOURCE_DIALOG_HELP.choice} />
        </div>
      )}
      {existing ? (
        <>
          <Field label="Source" help={SOURCE_DIALOG_HELP.existing} htmlFor="src-existing" error={errors.link} errorId="src-link-error">
            <NativeSelect id="src-existing" value={picked} aria-invalid={!!errors.link} aria-describedby={errors.link ? "src-link-error" : undefined} onChange={(e) => setPicked(e.target.value)}>
              <option value="">Choose…</option>
              {existingSources!.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.title} ({SOURCE_KIND_LABELS[s.kind]})
                </option>
              ))}
            </NativeSelect>
          </Field>
          {presetLabel && (
            <p className="text-sm">
              Links it to <b>{presetLabel}</b>.
            </p>
          )}
        </>
      ) : source ? (
        <p className="text-sm">
          <b>{source.title}</b> <span className="text-muted-foreground">· {SOURCE_KIND_LABELS[source.kind]}</span>
        </p>
      ) : (
        <>
          <Field label="Title" help={SOURCE_DIALOG_HELP.title} htmlFor="src-title" error={errors.title}>
            <Input
              id="src-title"
              value={draft.title}
              maxLength={MAX_TITLE}
              placeholder="e.g. Interview: Leah Brooks"
              aria-invalid={!!errors.title}
              aria-describedby={errors.title ? "src-title-error" : undefined}
              onChange={(e) => set({ title: e.target.value })}
            />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Type" help={SOURCE_DIALOG_HELP.type} htmlFor="src-type">
              <NativeSelect id="src-type" value={draft.kind} onChange={(e) => set({ kind: e.target.value as SourceDraft["kind"] })}>
                {KIND_CHOICES.map((k) => (
                  <option key={k} value={k}>
                    {SOURCE_KIND_LABELS[k]}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <Field label="Date" help={SOURCE_DIALOG_HELP.date} htmlFor="src-date" error={errors.date}>
              <Input id="src-date" type="date" value={draft.date} aria-invalid={!!errors.date} aria-describedby={errors.date ? "src-date-error" : undefined} onChange={(e) => set({ date: e.target.value })} />
            </Field>
          </div>
          <Field label="Quote or excerpt" help={SOURCE_DIALOG_HELP.quote} htmlFor="src-quote" error={errors.quote}>
            <Textarea
              id="src-quote"
              rows={3}
              value={draft.quote}
              placeholder="The words that matter most"
              aria-invalid={!!errors.quote}
              aria-describedby={errors.quote ? "src-quote-error" : undefined}
              onChange={(e) => set({ quote: e.target.value })}
            />
          </Field>
        </>
      )}

      {!existing && (
      <fieldset className="flex flex-col gap-2" aria-describedby={errors.link ? "src-link-error" : undefined}>
        <legend className="flex items-center text-xs font-medium text-muted-foreground uppercase">
          {SOURCE_DIALOG_HELP.kind.label}
          <Help {...SOURCE_DIALOG_HELP.kind} />
        </legend>
        <div role="group" aria-label="What kind of thing" className="flex flex-wrap gap-1.5">
          {SOURCE_LINK_KINDS.map((k) => (
            <KindChip key={k} kind={k} on={draft.linkKind === k} onPick={() => set({ linkKind: k, linkValue: "" })} />
          ))}
        </div>
        <Field label="Which one" help={SOURCE_DIALOG_HELP.target} htmlFor="src-target" error={errors.link} errorId="src-link-error">
          <NativeSelect
            id="src-target"
            value={draft.linkValue}
            disabled={options.length === 0}
            aria-invalid={!!errors.link}
            aria-describedby={errors.link ? "src-link-error" : undefined}
            onChange={(e) => set({ linkValue: e.target.value })}
          >
            <option value="">{options.length ? "Choose…" : `There is no ${LINK_KIND_LABELS[draft.linkKind].replace(/^An? /, "").toLowerCase()} to pick yet`}</option>
            {options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </NativeSelect>
        </Field>
      </fieldset>
      )}

      {error && (
        <p role="alert" className="rounded-lg border border-crit bg-crit-soft p-2 text-xs">
          {error}
        </p>
      )}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" disabled={working}>
          {source || existing ? "Link" : "Add source"}
        </Button>
      </DialogFooter>
    </form>
  );
}

function Field({ label, help, htmlFor, error, errorId, children }: { label: string; help: { label: string; description: string; example: string }; htmlFor: string; error?: string; errorId?: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="flex items-center text-xs font-medium text-muted-foreground uppercase">
        <label htmlFor={htmlFor}>{label}</label>
        <Help {...help} />
      </span>
      {children}
      {error && (
        <p role="alert" id={errorId ?? `${htmlFor}-error`} className="text-xs text-crit">
          {error}
        </p>
      )}
    </div>
  );
}

function ChoiceChip({ on, onPick, children }: { on: boolean; onPick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onPick}
      className={cn(
        "inline-flex h-7 items-center rounded-full border px-2.5 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring",
        on ? "border-accent bg-accent-soft font-semibold" : "bg-card hover:bg-muted",
      )}
    >
      {children}
    </button>
  );
}

function KindChip({ kind, on, onPick }: { kind: SourceLinkKind; on: boolean; onPick: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      data-link-kind={kind}
      onClick={onPick}
      className={cn(
        "inline-flex h-7 items-center rounded-full border px-2.5 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring",
        on ? "border-accent bg-accent-soft font-semibold" : "bg-card hover:bg-muted",
      )}
    >
      {LINK_KIND_LABELS[kind]}
    </button>
  );
}
