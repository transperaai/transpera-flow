"use client";

// Adding a finding by hand, or editing one (issue #175, B17). A finding has the same shape whoever wrote it: a title, how
// bad it is, what kind of problem, where it sits (a process, or across the company, and optionally a step), what was found
// and why it matters. Editing a proposed AI finding can accept it in the same step.

import { useState } from "react";
import { FINDING_LIMITS, type FindingDraft, type FindingType } from "@transpera-flow/db";
import { RATING_LABELS, type Rating } from "@transpera-flow/engine";
import { Help } from "@/components/help";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { RATING_MEANINGS } from "@/lib/issues/draft";
import { TYPE_LABELS } from "@/lib/issues/register";

const KINDS: readonly FindingType[] = ["delay", "capacity", "bottleneck", "spof", "failure", "manual", "sla", "churn_risk", "idea"];
const RATINGS: readonly Rating[] = ["risk", "bad", "good", "great"];

/** The one (i) the form needs: what "where" means. Every other field says what it is. */
export const FINDING_HELP = {
  where: {
    label: "Where",
    description: "The process the finding is about, or the whole company when it is about people, roles or clients rather than one process. Pick a step to put it on the map's step when it is acknowledged as an issue.",
    example: "Lead to live, step Audit & proposal; or Across the company for “The account team is short of a person”.",
  },
} as const;

export interface FindingDialogOptions {
  /** The processes it may sit in. With `company`, "Across the company" is offered too (the Overview). */
  processes: { id: string; name: string }[];
  company: boolean;
  steps: { id: string; name: string; processId: string }[];
}

export const emptyFindingDraft = (processId: string | null): FindingDraft => ({ processId, stepId: null, rating: "bad", type: "delay", title: "", evidence: "", why: "" });

export function FindingDialog({
  open,
  mode,
  initial,
  options,
  busy,
  error,
  onSave,
  onClose,
}: {
  open: boolean;
  /** "add": by hand. "edit": an accepted finding. "review": a proposed AI finding, saved with or without accepting it. */
  mode: "add" | "edit" | "review";
  initial: FindingDraft;
  options: FindingDialogOptions;
  busy?: boolean;
  error?: string | null;
  /** Resolve falsy when the save failed, so the dialog stays open. */
  onSave: (draft: FindingDraft, accept: boolean) => Promise<unknown>;
  onClose: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-lg" data-finding-dialog={mode}>
        {open && <Form key={JSON.stringify(initial)} mode={mode} initial={initial} options={options} busy={busy} error={error} onSave={onSave} onClose={onClose} />}
      </DialogContent>
    </Dialog>
  );
}

function Form({ mode, initial, options, busy, error, onSave, onClose }: Omit<Parameters<typeof FindingDialog>[0], "open">) {
  const [draft, setDraft] = useState<FindingDraft>(initial);
  const [tried, setTried] = useState(false);
  const set = (patch: Partial<FindingDraft>) => setDraft((d) => ({ ...d, ...patch }));
  const steps = options.steps.filter((s) => s.processId === draft.processId);
  const titleMissing = !draft.title.trim();
  const save = async (accept: boolean) => {
    setTried(true);
    if (titleMissing) return;
    if (await onSave(draft, accept)) onClose();
  };
  return (
    <>
      <DialogHeader>
        <DialogTitle>{mode === "add" ? "Add a finding" : mode === "review" ? "Edit before accepting" : "Edit finding"}</DialogTitle>
        <DialogDescription>
          {mode === "add" ? "Your own conclusion, in the same shape as AI's. It is accepted as you save it." : mode === "review" ? "Change what AI wrote, then accept it." : "Change what the finding says."}
        </DialogDescription>
      </DialogHeader>
      <form
        className="flex flex-col gap-3"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void save(mode !== "edit");
        }}
      >
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-xs font-medium text-muted-foreground uppercase">Title</span>
          <Input
            name="title"
            value={draft.title}
            maxLength={FINDING_LIMITS.title}
            placeholder="What's wrong, in a sentence"
            aria-invalid={tried && titleMissing}
            onChange={(e) => set({ title: e.target.value })}
          />
          {tried && titleMissing && <span className="text-xs text-destructive">Give the finding a title.</span>}
        </label>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-xs font-medium text-muted-foreground uppercase">How bad is it?</span>
            <NativeSelect name="rating" value={draft.rating} onChange={(e) => set({ rating: e.target.value as Rating })}>
              {RATINGS.map((r) => (
                <option key={r} value={r}>
                  {RATING_LABELS[r]}: {RATING_MEANINGS[r]}
                </option>
              ))}
            </NativeSelect>
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-xs font-medium text-muted-foreground uppercase">Kind</span>
            <NativeSelect name="type" value={draft.type} onChange={(e) => set({ type: e.target.value as FindingType })}>
              {KINDS.map((k) => (
                <option key={k} value={k}>
                  {TYPE_LABELS[k]}
                </option>
              ))}
            </NativeSelect>
          </label>
        </div>
        <fieldset className="grid gap-3 sm:grid-cols-2">
          <legend className="mb-1 flex items-center text-xs font-medium text-muted-foreground uppercase">
            {FINDING_HELP.where.label}
            <Help {...FINDING_HELP.where} />
          </legend>
          {(options.company || options.processes.length > 1) && (
            <NativeSelect aria-label="Process" name="process" value={draft.processId ?? ""} onChange={(e) => set({ processId: e.target.value || null, stepId: null })}>
              {options.company && <option value="">Across the company</option>}
              {options.processes.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </NativeSelect>
          )}
          <NativeSelect aria-label="Step" name="step" value={draft.stepId ?? ""} disabled={!steps.length} onChange={(e) => set({ stepId: e.target.value || null })}>
            <option value="">{draft.processId ? "No step in particular" : "No step"}</option>
            {steps.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </NativeSelect>
        </fieldset>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-xs font-medium text-muted-foreground uppercase">What we found</span>
          <Textarea name="evidence" rows={3} value={draft.evidence} maxLength={FINDING_LIMITS.evidence} placeholder="The evidence, with the numbers from the run" onChange={(e) => set({ evidence: e.target.value })} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-xs font-medium text-muted-foreground uppercase">Why it matters</span>
          <Textarea name="why" rows={2} value={draft.why} maxLength={FINDING_LIMITS.why} placeholder="What it costs the business or its clients" onChange={(e) => set({ why: e.target.value })} />
        </label>
        {error && (
          <p role="alert" className="rounded-lg border border-crit bg-crit-soft p-2 text-xs">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          {mode === "review" && (
            <Button type="button" variant="outline" disabled={busy} onClick={() => void save(false)}>
              Save, don&apos;t accept yet
            </Button>
          )}
          <Button type="submit" disabled={busy}>
            {mode === "add" ? "Add finding" : mode === "review" ? "Save and accept" : "Save"}
          </Button>
        </DialogFooter>
      </form>
    </>
  );
}
