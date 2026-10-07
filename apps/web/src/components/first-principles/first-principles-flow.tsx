"use client";

// The first-principles flow (issue #119, A54): seven steps, a stepper, back and next, progress, and a panel of rule
// checks beside every answer. Answers are saved as they are typed, per process version: into the draft (the page says
// so), never the live version. Beside them, the AI review panel (A46) shows what AI wrote about the live version.

import { Fragment, useMemo, type ReactNode } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Sparkles } from "lucide-react";
import type { ProcessBundle } from "@transpera-flow/db";
import { countFilled, countFlags, FP_STEPS, firstPrinciplesFlags, isAttention, measuresMetToday, stepsFilled, type FirstPrinciples, type FpFlag, type FpStepKey } from "@transpera-flow/engine";
import { Help } from "@/components/help";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AiReviewPanel } from "@/components/ai/ai-review-panel";
import { PhoneNotice } from "@/components/shell/phone-read-only";
import { useIsPhone } from "@/hooks/use-mobile";
import type { AiMode, AiPanelData } from "@/lib/ai/types";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { useEngineModel } from "@/components/process-view";
import { useSimulation } from "@/lib/sim/use-simulation";
import { useFirstPrinciplesDraft, type DraftStatus } from "@/lib/first-principles/use-draft";
import type { FpBase, FpSaver } from "@/lib/first-principles/types";
import { cn } from "@/lib/utils";
import { StepBody, STEP_TEXT } from "./step-bodies";
import { namedForViewer, viewerOf } from "@/lib/viewer";

export type FlowEditing =
  /** Editing the process's open draft. */
  | { kind: "draft"; number: number }
  /** No draft yet: the first change opens one from the live version. */
  | { kind: "opens-draft"; liveNumber: number }
  /** A process never published: its only version is the draft. */
  | { kind: "first-draft"; number: number }
  /** The viewer can't edit. */
  | { kind: "readonly" }
  /** The demo: answers stay in this tab. */
  | { kind: "demo" };

const FLAG_STYLE: Record<FpFlag["level"], { mark: string; box: string; label: string }> = {
  bad: { mark: "!", box: "bg-crit-soft", label: "Needs fixing" },
  warn: { mark: "?", box: "bg-warn-soft", label: "Worth a look" },
  ok: { mark: "✓", box: "bg-good-soft", label: "Looks fine" },
  info: { mark: "i", box: "bg-panel-2", label: "For information" },
};

const MARK_COLOUR: Record<FpFlag["level"], string> = { bad: "bg-crit", warn: "bg-warn", ok: "bg-good", info: "bg-accent" };

const STATUS_TEXT: Record<DraftStatus, string> = {
  saved: "Saved",
  unsaved: "Unsaved changes",
  saving: "Saving…",
  error: "Not saved",
  conflict: "Not saved: changed by someone else",
  stale: "Not saved: the draft changed",
};

export function FirstPrinciplesFlow({
  bundle,
  initial,
  base,
  canEdit,
  save,
  editing,
  processHref,
  processesHref,
  peopleHref,
  processPicker,
  ai,
}: {
  /** What AI wrote about the live version (A46), for the AI review panel; omitted, the panel isn't shown. */
  ai?: { mode: AiMode; data: AiPanelData; canRun: boolean };
  /** The version being edited (the draft if there is one, else live), for its steps, people and the run the checks read. */
  bundle: ProcessBundle;
  initial: FirstPrinciples;
  base: FpBase;
  canEdit: boolean;
  save: FpSaver;
  editing: FlowEditing;
  processHref: string;
  processesHref: string;
  peopleHref?: string;
  processPicker?: ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const stepNumber = Math.min(7, Math.max(1, Number(searchParams.get("step")) || 1));
  const index = stepNumber - 1;
  const step = FP_STEPS[index]!;
  const goTo = (n: number) => {
    const next = new URLSearchParams(searchParams.toString());
    next.set("step", String(Math.min(7, Math.max(1, n))));
    router.replace(`${pathname}?${next.toString()}`, { scroll: false });
    window.scrollTo({ top: 0 });
  };

  const draft = useFirstPrinciplesDraft({ initial, base, save, canEdit });
  const { doc } = draft;

  // The checks read the latest run of the version being edited.
  const { model } = useEngineModel(bundle, null);
  const sim = useSimulation(model);
  const result = sim.status === "done" ? sim.run.result : null;
  const rows = useMemo(() => (model && result ? measuresMetToday(doc, model, result, bundle.process.id) : []), [doc, model, result, bundle.process.id]);
  const checks = useMemo(() => rows.flatMap((r) => (r.check ? [r.check] : [])), [rows]);

  const ctx = useMemo(
    () => ({
      steps: bundle.steps.filter((s) => s.kind === "task" || s.kind === "wait" || s.kind === "decision" || s.kind === "subprocess").map((s) => ({ id: s.id, name: s.name })),
      people: namedForViewer(viewerOf(bundle), bundle.people).map((p) => ({ id: p.id, name: p.name })),
      roles: bundle.roles.map((r) => ({ name: r.name })),
      checks,
    }),
    [bundle, checks],
  );
  const flags = useMemo(() => firstPrinciplesFlags(doc, ctx), [doc, ctx]);
  const filled = stepsFilled(doc);
  const done = countFilled(doc);
  const total = countFlags(flags);
  const attention = (k: FpStepKey) => flags[k].filter(isAttention).length;

  // A phone is read only (issue #44): the answers stay readable and the steps still turn, but nothing can be typed.
  const isPhone = useIsPhone();
  const disabled = !canEdit || isPhone;
  return (
    <div className="flex min-h-svh flex-1 flex-col">
      <div className="sticky top-0 z-20 flex items-center gap-x-2 border-b bg-background/95 px-4 py-2 backdrop-blur">
        <SidebarTrigger className="-ml-1" />
        <Separator orientation="vertical" className="data-[orientation=vertical]:h-4" />
        <Fragment key="picker">{processPicker ?? <h1 className="truncate px-1 font-display text-base font-bold">{bundle.process.name}</h1>}</Fragment>
      </div>

      <div className="mx-auto flex w-full max-w-7xl flex-col gap-5 px-4 py-5">
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <nav aria-label="Breadcrumb" className="flex flex-wrap items-center gap-1.5 text-xs text-fg-2">
              <Link href={processesHref} className="hover:underline">
                Processes
              </Link>
              <span aria-hidden>/</span>
              <Link href={processHref} className="hover:underline">
                {bundle.process.name}
              </Link>
              <span aria-hidden>/</span>
              <span>First principles</span>
            </nav>
            <h1 className="mt-1 font-display text-2xl font-bold">First principles · {bundle.process.name}</h1>
            <p className="mt-1 max-w-3xl text-sm text-fg-2">Strip the process back to what is actually true, then rebuild it. Seven steps; the checks compare every answer with the process and its latest simulation.</p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <span className="flex items-center text-sm text-fg-2" data-testid="fp-progress">
              {done} of 7 steps filled in · {total} {total === 1 ? "flag" : "flags"}
              <Help
                label="Steps filled in and flags"
                description="How many of the seven steps have an answer, and how many things the checks want you to look at. Flags are prompts to think again, not errors."
                example="“3 of 7 steps filled in · 5 flags”: three steps have answers and five answers need another look."
              />
            </span>
            <span className="h-2 w-28 rounded-full bg-panel-2" role="progressbar" aria-valuemin={0} aria-valuemax={7} aria-valuenow={done} aria-label="Steps filled in">
              <span className="block h-2 rounded-full bg-accent" style={{ width: `${(done / 7) * 100}%` }} />
            </span>
            <Button asChild variant="outline">
              <Link href={processHref}>Back to {bundle.process.name}</Link>
            </Button>
          </div>
        </header>

        <EditingNote editing={editing} status={draft.status} message={draft.message} />
        {canEdit && <PhoneNotice />}

        {draft.status === "conflict" && (
          <Alert role="alert" className="border-warn bg-warn-soft">
            <AlertDescription className="flex flex-wrap items-center gap-3 text-fg">
              Someone else saved these answers while you were editing.
              <Button size="sm" onClick={draft.keepMine}>
                Keep mine
              </Button>
              <Button size="sm" variant="outline" onClick={draft.takeTheirs}>
                Use theirs
              </Button>
            </AlertDescription>
          </Alert>
        )}
        {draft.status === "stale" && (
          <Alert role="alert" className="border-warn bg-warn-soft">
            <AlertDescription className="flex flex-wrap items-center gap-3 text-fg">
              The draft you were editing was published or discarded, so this change isn&apos;t saved.
              <Button size="sm" onClick={() => router.refresh()}>
                Reload
              </Button>
            </AlertDescription>
          </Alert>
        )}

        <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-5 md:grid-cols-[13rem_minmax(0,1fr)] xl:grid-cols-[14rem_minmax(0,1fr)_18.75rem]">
          <nav aria-label="Steps" className="min-w-0 md:sticky md:top-16">
            <ol className="flex gap-1 overflow-x-auto md:flex-col md:overflow-visible">
              {FP_STEPS.map((s, j) => {
                const n = attention(s.key);
                return (
                  <li key={s.key} className="shrink-0">
                    <button
                      type="button"
                      aria-current={j === index ? "step" : undefined}
                      onClick={() => goTo(j + 1)}
                      className={cn(
                        "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm text-fg-2 hover:bg-panel-2",
                        j === index && "bg-panel font-semibold text-fg shadow-[inset_0_0_0_1px_var(--line)]",
                      )}
                    >
                      <span
                        className={cn(
                          "grid size-6 shrink-0 place-items-center rounded-full border-[1.5px] border-line-2 bg-panel font-mono text-xs",
                          filled[s.key] && "border-good bg-good text-panel",
                          n > 0 && "border-warn bg-warn text-fg",
                          j === index && !filled[s.key] && n === 0 && "border-accent",
                        )}
                      >
                        {n > 0 ? n : filled[s.key] ? "✓" : j + 1}
                      </span>
                      <span className="whitespace-nowrap md:whitespace-normal">{s.name}</span>
                    </button>
                  </li>
                );
              })}
            </ol>
          </nav>

          <section aria-labelledby="fp-step-heading" className="flex min-w-0 flex-col gap-2 rounded-token border border-line bg-card p-5 shadow-token">
            <span className="text-xs font-semibold tracking-wide text-fg-2 uppercase">Step {stepNumber} of 7</span>
            <h2 id="fp-step-heading" className="font-display text-xl font-bold">
              {step.name}
            </h2>
            <p className="max-w-[70ch] text-[15px]">{STEP_TEXT[step.key].question}</p>
            <span className="text-xs text-fg-2">Method: {STEP_TEXT[step.key].method}</span>
            <div className="mt-3 flex flex-col gap-3" data-testid={`fp-step-${step.key}`}>
              <StepBody step={step.key} doc={doc} edit={draft.edit} ctx={ctx} disabled={disabled} checks={checks} />
            </div>
            {peopleHref && (step.key === "reqs" || step.key === "del") && bundle.people.length === 0 && (
              <p className="text-xs text-fg-2">
                There are no people to pick from yet. <Link href={peopleHref} className="underline">Add them in People</Link>, or type a name.
              </p>
            )}
            <div className="mt-3 flex items-center justify-between gap-3 border-t border-line pt-4">
              <Button variant="outline" disabled={index === 0} onClick={() => goTo(stepNumber - 1)}>
                ← {index > 0 ? FP_STEPS[index - 1]!.name : "Back"}
              </Button>
              {index < 6 ? (
                <Button onClick={() => goTo(stepNumber + 1)}>{FP_STEPS[index + 1]!.name} →</Button>
              ) : (
                <Button asChild onClick={() => void draft.flush()}>
                  <Link href={processHref}>Done</Link>
                </Button>
              )}
            </div>
          </section>

          <aside aria-label="AI checks" className="flex flex-col gap-3 rounded-token border border-line bg-card p-4 shadow-token md:col-span-2 xl:sticky xl:top-16 xl:col-span-1">
            <div className="flex items-center gap-1.5 text-sm font-semibold">
              <Sparkles aria-hidden className="size-4 text-accent" />
              AI checks
              <Help
                label="AI checks"
                description="Rules that read your answers and compare them with the process and its latest simulation. They point things out; they never change your answers and they never make up numbers."
                example="“Speeding up Enrich in CRM, which is still a delete candidate. Decide the deletion first.”"
              />
            </div>
            <p className="text-xs text-fg-2">Checked against the latest simulation of {bundle.process.name}.</p>
            <ul className="flex flex-col gap-2" data-testid="fp-flags">
              {flags[step.key].length ? (
                flags[step.key].map((f, i) => (
                  <li key={`${f.code}-${i}`} className={cn("grid grid-cols-[22px_minmax(0,1fr)] gap-2 rounded-lg p-2 text-[13px]", FLAG_STYLE[f.level].box)} data-flag={f.code}>
                    <span aria-hidden className={cn("grid size-5 place-items-center rounded-full font-mono text-[11px] font-bold text-panel", MARK_COLOUR[f.level])}>
                      {FLAG_STYLE[f.level].mark}
                    </span>
                    <span>
                      <span className="sr-only">{FLAG_STYLE[f.level].label}: </span>
                      {f.text}
                    </span>
                  </li>
                ))
              ) : (
                <li className="text-xs text-fg-2">Nothing to check yet.</li>
              )}
            </ul>

            {ai && <AiReviewPanel mode={ai.mode} processId={bundle.process.id} step={step.key} ai={ai.data} canRun={ai.canRun} />}

            <div className="flex flex-col gap-0.5 border-t border-line pt-3">
              <span className="text-xs font-semibold tracking-wide text-fg-2 uppercase">All steps</span>
              {FP_STEPS.map((s, j) => {
                const n = attention(s.key);
                return (
                  <button key={s.key} type="button" onClick={() => goTo(j + 1)} className="flex justify-between gap-2 rounded px-0.5 py-1 text-left text-[13px] hover:text-accent">
                    <span>{s.name}</span>
                    <span className={cn("shrink-0 text-xs tabular-nums", n ? "font-semibold text-warn" : "text-fg-2")}>{n ? `${n} to fix` : "✓"}</span>
                  </button>
                );
              })}
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}

function EditingNote({ editing, status, message }: { editing: FlowEditing; status: DraftStatus; message: string | null }) {
  const text = (() => {
    switch (editing.kind) {
      case "draft":
        return `Editing the draft (version ${editing.number}, not published yet). Answers save as you type and go live when the draft is published.`;
      case "first-draft":
        return "Editing the draft. This process hasn't been published yet, so its draft is its only version. Answers save as you type.";
      case "opens-draft":
        return `Answers are saved in the draft, not the live version ${editing.liveNumber}. Your first change opens a draft from live; nothing goes live until it is published.`;
      case "readonly":
        return "You can read these answers but not change them. Editors and owners can.";
      case "demo":
        return "Demo mode: your answers stay in this tab and are gone when you reload.";
    }
  })();
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line bg-panel-2 px-3 py-2 text-xs" data-testid="fp-editing">
      <span>
        {text}
        <Help
          label="Which version this edits"
          description="First principles belong to a version of the process, like its steps. Changes always go into the draft, so the live version stays as it was published until you publish the draft. Restoring an earlier version brings back its steps, not its answers: the draft keeps the answers it has."
          example="Live is version 3. You type an answer; a draft (version 4) opens with it. Publish the draft and version 4 goes live with those answers."
        />
      </span>
      {editing.kind !== "readonly" && (
        <span role="status" aria-live="polite" className={cn("font-medium", (status === "error" || status === "conflict" || status === "stale") && "text-crit")}>
          {STATUS_TEXT[status]}
          {status === "error" && message ? `: ${message}` : ""}
        </span>
      )}
    </div>
  );
}
