"use client";

// The analysis panel (issue #175, B17; decision D40) at the top of a page's findings: "Analyse", what AI last wrote (its
// read), whether that is out of date, what it cost and which model wrote it, the AI findings waiting for review (Accept,
// Edit, Dismiss), and "Add a finding" for a finding by hand. AI runs only when someone presses Analyse, and a stored
// analysis is shown until the model changes, then marked out of date. Viewers see the read; the review list and the
// buttons are for owners and editors.

import Link from "next/link";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus, Sparkles } from "lucide-react";
import { readCitations, type FindingDraft, type FindingRow } from "@transpera-flow/db";
import { Button } from "@/components/ui/button";
import { RatingPill } from "@/components/overview/rating-pill";
import { formatCost } from "@/lib/ai/cost";
import { AI_NOT_SET_UP, type AiMode, type AiPanelData } from "@/lib/ai/types";
import type { AiRunReply } from "@/lib/ai/reply";
import type { FindingsState } from "@/lib/findings/use-findings";
import { proposedFindings } from "@/lib/findings/view";
import { cn } from "@/lib/utils";
import { emptyFindingDraft, FindingDialog, type FindingDialogOptions } from "./finding-dialog";

const when = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

const draftOf = (f: FindingRow): FindingDraft => ({ processId: f.process_id, stepId: f.step_id, rating: f.rating, type: f.type, title: f.title, evidence: f.evidence, why: f.why, sourceIds: f.source_ids });

export function AnalysisPanel({
  mode,
  scope,
  ai,
  findings,
  proposed,
  options,
  defaultProcessId,
  stepName,
  analyse,
  canRun = true,
  firstPrinciplesHref,
  short = false,
}: {
  mode: AiMode;
  scope: "company" | "process";
  ai: AiPanelData;
  findings: FindingsState;
  /** The proposed AI findings of this page's scope, for review. */
  proposed: readonly FindingRow[];
  options: FindingDialogOptions;
  /** Where a finding added here sits by default: this process, or null across the company. */
  defaultProcessId: string | null;
  stepName: (id: string) => string | null;
  /** Run the analysis (a Server Action, or the demo's stand-in). */
  analyse: () => Promise<AiRunReply>;
  /** False on an earlier version or a draft, where nothing can be run. */
  canRun?: boolean;
  firstPrinciplesHref?: string;
  /** Show the read's first paragraph only, with a button for the rest (the Overview). */
  short?: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [whole, setWhole] = useState(false);
  const [dialog, setDialog] = useState<{ mode: "add" } | { mode: "review"; finding: FindingRow } | null>(null);
  const { view, configured, hasFirstPrinciples, stale } = ai;
  const demo = mode === "demo";
  const canEdit = mode !== "readonly" && findings.canEdit;
  const runnable = canRun && canEdit && (demo || (configured && hasFirstPrinciples));
  const review = proposedFindings(proposed);

  const run = () => {
    setMessage(null);
    start(async () => {
      try {
        const out = await analyse();
        setMessage({ kind: out.status, text: out.message });
        if (out.status === "ok" && !demo) router.refresh();
      } catch {
        setMessage({ kind: "error", text: "Couldn't run the analysis. Check your connection and try again." });
      }
    });
  };

  const cost = formatCost(view?.costUsd);
  let body;
  if (view && view.summary.length) {
    body = (
      <>
        {(short && !whole ? view.summary.slice(0, 1) : view.summary).map((p, i) => (
          <p key={i} className={cn("max-w-[75ch] text-sm leading-relaxed", stale && "text-muted-foreground")}>
            {p}
          </p>
        ))}
        {short && view.summary.length > 1 && (
          <button type="button" className="self-start text-xs font-medium text-accent hover:underline" aria-expanded={whole} onClick={() => setWhole((w) => !w)} data-ai-read-more>
            {whole ? "Show less" : "Read the rest"}
          </button>
        )}
      </>
    );
  } else if (view) {
    body = <p className="text-sm text-muted-foreground">AI couldn&apos;t write an analysis that matched the run{view.reason ? `: ${view.reason}` : ""}. Analyse again to try once more.</p>;
  } else if (!configured && !demo) {
    body = (
      <p className="text-sm text-muted-foreground">
        <b className="font-medium text-foreground">{AI_NOT_SET_UP}.</b> This server has no Anthropic API key, so AI writes nothing. You can still add findings by hand, and the facts below come straight from the simulation.
      </p>
    );
  } else if (!hasFirstPrinciples && !demo) {
    body = (
      <p className="text-sm text-muted-foreground">
        Not analysed yet. Write {scope === "company" ? "your main process's" : "this process's"} first principles first: AI judges the {scope === "company" ? "company" : "process"} against them.{" "}
        {firstPrinciplesHref && (
          <Link href={firstPrinciplesHref} className="font-medium text-foreground underline">
            Write first principles
          </Link>
        )}
      </p>
    );
  } else {
    body = <p className="text-sm text-muted-foreground">Not analysed yet. {runnable ? "Press Analyse to have AI read the facts and propose findings for you to review." : "Someone who can edit this workspace can run it."}</p>;
  }

  return (
    <div data-analysis={view ? (stale ? "stale" : view.status) : "empty"} className="flex flex-col gap-2 rounded-xl border bg-card p-4" aria-busy={pending}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-medium">
        <Sparkles aria-hidden className="size-4 text-accent" />
        <span>{scope === "company" ? "AI analysis of the company" : "AI analysis"}</span>
        {stale && (
          <span className="rounded-full border border-warn bg-warn-soft px-2 py-0.5 text-xs font-medium" data-stale>
            Out of date
          </span>
        )}
        <span className="ml-auto flex flex-wrap items-center gap-1">
          {canEdit && (
            <Button variant="ghost" size="sm" onClick={() => setDialog({ mode: "add" })} data-add-finding>
              <Plus aria-hidden />
              Add a finding
            </Button>
          )}
          {canEdit && canRun && (
            <Button variant="outline" size="sm" disabled={!runnable || pending} onClick={run} title={!runnable ? (!configured ? AI_NOT_SET_UP : "Write first principles first") : undefined} data-analyse>
              {pending ? "Analysing…" : view ? "Analyse again" : "Analyse"}
            </Button>
          )}
        </span>
      </div>
      {stale && <p className="text-xs text-muted-foreground">The {scope === "company" ? "company model" : "process"} has changed since this was written. Analyse again to bring it up to date.</p>}
      {body}
      {view && (
        <p className="text-xs text-muted-foreground" data-analysis-footer>
          {demo ? "Written in advance for the demo" : `Written ${when(view.at)}`}
          {view.model ? ` by ${view.model}` : ""}
          {view.runBy ? `, run by ${view.runBy}` : ""}. {view.checked} number{view.checked === 1 ? "" : "s"} checked against the run
          {view.dropped ? `; ${view.dropped} item${view.dropped === 1 ? "" : "s"} left out for citing a figure the run doesn't have` : ""}.{cost ? ` Cost ${cost}.` : ""}
        </p>
      )}
      {message && (
        <p role="status" className={message.kind === "error" ? "text-xs text-destructive" : "text-xs text-muted-foreground"}>
          {message.text}
        </p>
      )}

      {review.length > 0 &&
        (canEdit ? (
          <div className="mt-1 flex flex-col gap-2 border-t pt-3" data-review>
            <p className="text-xs font-medium text-muted-foreground uppercase">
              To review · {review.length}
              <span className="ml-1 font-normal normal-case">AI proposed these. Only the ones you accept show on the pages.</span>
            </p>
            <ul className="flex flex-col gap-2">
              {review.map((f) => {
                const facts = readCitations(f.facts);
                const step = f.step_id ? stepName(f.step_id) : null;
                return (
                  <li key={f.id} data-proposed={f.id} className="flex flex-col gap-1.5 rounded-lg border bg-background/60 p-3 sm:flex-row sm:items-start sm:justify-between">
                    <div className="flex min-w-0 flex-col gap-1">
                      <b className="text-sm font-semibold">{f.title}</b>
                      <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                        <RatingPill rating={f.rating} />
                        {step && <span>{step}</span>}
                        <span>
                          Rests on {facts.length} fact{facts.length === 1 ? "" : "s"}
                        </span>
                      </span>
                      {f.evidence && <p className="text-xs text-muted-foreground">{f.evidence}</p>}
                    </div>
                    <span className="flex shrink-0 gap-1">
                      <Button size="sm" disabled={findings.busy} onClick={() => void findings.accept(f.id)}>
                        Accept
                      </Button>
                      <Button size="sm" variant="outline" disabled={findings.busy} onClick={() => setDialog({ mode: "review", finding: f })}>
                        Edit
                      </Button>
                      <Button size="sm" variant="ghost" disabled={findings.busy} onClick={() => void findings.dismiss(f.id)}>
                        Dismiss
                      </Button>
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground" data-review-waiting>
            AI proposed {review.length} finding{review.length === 1 ? "" : "s"}, waiting for someone who can edit to review.
          </p>
        ))}
      {findings.error && !dialog && (
        <p role="alert" className="rounded-lg border border-crit bg-crit-soft p-2 text-xs">
          {findings.error}
        </p>
      )}

      <FindingDialog
        open={!!dialog}
        mode={dialog?.mode ?? "add"}
        initial={dialog?.mode === "review" ? draftOf(dialog.finding) : emptyFindingDraft(defaultProcessId)}
        options={options}
        busy={findings.busy}
        error={findings.error}
        onSave={(draft, accept) => (dialog?.mode === "review" ? findings.edit(dialog.finding.id, draft, accept) : findings.create(draft))}
        onClose={() => {
          setDialog(null);
          findings.dismissError();
        }}
      />
    </div>
  );
}

export { draftOf as findingDraftOf };
