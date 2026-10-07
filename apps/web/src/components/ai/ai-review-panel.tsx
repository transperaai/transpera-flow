"use client";

// The AI review panel of the first-principles flow (issue #111, A46; fills A54's placeholder). The rule checks above it run
// in the browser on every keystroke; this panel shows what AI wrote about the version that is live: its findings on the
// step on screen, each checked against the simulation's numbers before it was stored. It reads what was stored, so the page
// never calls the model, and it says so when it hasn't run, can't (no API key) or reviewed a different version.

import { isReadOnly } from "@/lib/mode";
import { Help } from "@/components/help";
import { Button } from "@/components/ui/button";
import { AI_NOT_SET_UP, type AiMode, type AiPanelData, type AiReviewFinding } from "@/lib/ai/types";
import { cn } from "@/lib/utils";
import { useAiRun } from "./use-ai-run";
import { EDIT_ONLY } from "@/lib/phone";

const STYLE: Record<AiReviewFinding["level"], { mark: string; box: string; label: string; colour: string }> = {
  bad: { mark: "!", box: "bg-crit-soft", label: "Needs fixing", colour: "bg-crit" },
  warn: { mark: "?", box: "bg-warn-soft", label: "Worth a look", colour: "bg-warn" },
  ok: { mark: "✓", box: "bg-good-soft", label: "Looks fine", colour: "bg-good" },
  info: { mark: "i", box: "bg-panel-2", label: "For information", colour: "bg-accent" },
};

export function AiReviewPanel({
  mode,
  processId,
  step,
  ai,
  canRun = true,
}: {
  mode: AiMode;
  processId: string;
  /** The first-principles step on screen: only AI's findings on it are listed. */
  step: AiReviewFinding["step"];
  ai: AiPanelData;
  canRun?: boolean;
}) {
  const demo = mode === "demo";
  const { view, configured, hasFirstPrinciples, versionNumber } = ai;
  const { pending, message, run } = useAiRun(demo, processId);
  const runnable = canRun && !isReadOnly(mode) && (demo || (configured && hasFirstPrinciples));
  const here = view?.review.filter((f) => f.step === step) ?? [];

  let body;
  if (view && (view.status === "ok" || view.review.length)) {
    body = (
      <>
        {here.length ? (
          <ul className="flex flex-col gap-2" data-testid="ai-review-findings">
            {here.map((f, i) => (
              <li key={i} className={cn("grid grid-cols-[22px_minmax(0,1fr)] gap-2 rounded-lg p-2 text-[13px]", STYLE[f.level].box)} data-ai-finding={f.level}>
                <span aria-hidden className={cn("grid size-5 place-items-center rounded-full font-mono text-[11px] font-bold text-panel", STYLE[f.level].colour)}>
                  {STYLE[f.level].mark}
                </span>
                <span>
                  <span className="sr-only">{STYLE[f.level].label}: </span>
                  {f.text}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-fg-2">Nothing to add on this step.</p>
        )}
        <p className="text-xs text-fg-2" data-ai-review-footer>
          Reviewed by AI{view.runBy ? ` · run by ${view.runBy}` : ""}. It reviewed {versionNumber ? `version ${versionNumber}` : "the live version"} and its first principles. {view.checked} number{view.checked === 1 ? "" : "s"} checked against the run
          {view.dropped ? `; ${view.dropped} finding${view.dropped === 1 ? "" : "s"} left out for citing a figure the run doesn't have` : ""}. Edits you are making now are included after you publish.
        </p>
      </>
    );
  } else if (view) {
    body = <p className="text-xs text-fg-2">AI couldn&apos;t review this version{view.reason ? `: ${view.reason}` : ""}. Analyse again to try once more.</p>;
  } else if (!configured && !demo) {
    body = (
      <p className="text-xs text-fg-2">
        <b className="font-medium text-fg">{AI_NOT_SET_UP}.</b> This server has no Anthropic API key. The checks above come straight from rules.
      </p>
    );
  } else if (!hasFirstPrinciples && !demo) {
    body = <p className="text-xs text-fg-2">AI reviews the first principles of the published version. Publish this one, then it can judge the process against them.</p>;
  } else {
    body = <p className="text-xs text-fg-2">AI hasn&apos;t reviewed this version yet. It runs when someone presses Analyse{runnable ? " here or on the process page" : ""}.</p>;
  }

  return (
    <div data-ai-review={view ? view.status : "empty"} className="flex flex-col gap-1.5 rounded-lg border p-3" aria-busy={pending}>
      <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
        AI review
        <Help
          label="AI review"
          description="A reviewer that reads these answers next to the simulation's results and writes findings. It uses only numbers the simulation produced, and leaves out any finding whose number doesn't match. It reviews the published version when someone presses Analyse."
          example="“You named proposal review; the simulation's bottleneck is the discovery call.”"
        />
        {canRun && !isReadOnly(mode) && (
          <span className={`ml-auto flex items-center ${EDIT_ONLY}`} data-edit-entry>
            <Button variant="ghost" size="sm" disabled={!runnable || pending} onClick={run} title={!runnable ? (!configured ? AI_NOT_SET_UP : "Publish first principles first") : undefined}>
              {pending ? "Analysing…" : "Analyse"}
            </Button>
          </span>
        )}
      </p>
      {body}
      {message && (
        <p role="status" className={message.kind === "error" ? "text-xs text-destructive" : "text-xs text-fg-2"}>
          {message.text}
        </p>
      )}
    </div>
  );
}
