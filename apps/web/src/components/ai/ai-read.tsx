"use client";

// "AI read of this run" (issue #111, A46; prototype: aiSummary on the Overview and the Process page): a short summary of
// the version's run written by AI, with "Run again". It shows what was stored for the version, so a page view never
// calls the model. The empty state asks for first principles when there are none, and with no API key it says
// "AI analysis isn't set up". On the public demo the text is written in advance and "Run again" calls nothing.

import Link from "next/link";
import { useState } from "react";
import { Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AI_NOT_SET_UP, type AiMode, type AiPanelData } from "@/lib/ai/types";
import { useAiRun } from "./use-ai-run";

const when = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

export function AiRead({
  mode,
  scope,
  processId,
  ai,
  firstPrinciplesHref,
  canRun = true,
  short = false,
}: {
  mode: AiMode;
  /** "company" on the Overview, "process" on a process page: only the wording differs. */
  scope: "company" | "process";
  processId: string;
  ai: AiPanelData;
  firstPrinciplesHref?: string;
  /** False on an earlier version, where nothing can be run. */
  canRun?: boolean;
  /** Show the first paragraph only, with a button for the rest (the Overview's findings tier, issue #173). */
  short?: boolean;
}) {
  const { view, configured, hasFirstPrinciples, versionNumber } = ai;
  const demo = mode === "demo";
  const { pending, message, run } = useAiRun(demo, processId);
  const runnable = canRun && mode !== "readonly" && (demo || (configured && hasFirstPrinciples));
  const [whole, setWhole] = useState(false);

  let body;
  if (view && view.summary.length) {
    body = (
      <>
        {(short && !whole ? view.summary.slice(0, 1) : view.summary).map((p, i) => (
          <p key={i} className="max-w-[75ch] text-sm leading-relaxed">
            {p}
          </p>
        ))}
        {short && view.summary.length > 1 && (
          <button type="button" className="self-start text-xs font-medium text-accent hover:underline" aria-expanded={whole} onClick={() => setWhole((w) => !w)} data-ai-read-more>
            {whole ? "Show less" : "Read the rest"}
          </button>
        )}
        <p className="text-xs text-muted-foreground" data-ai-read-footer>
          {versionNumber ? `Version ${versionNumber}, ` : ""}written {when(view.at)}
          {view.model ? ` by ${view.model}` : ""}
          {demo ? " (written in advance for the demo)" : ""}. Reviewed by AI{view.runBy ? ` · run by ${view.runBy}` : ""}. {view.checked} number{view.checked === 1 ? "" : "s"} checked against the run
          {view.dropped ? `; ${view.dropped} item${view.dropped === 1 ? "" : "s"} left out for citing a figure the run doesn't have` : ""}.
        </p>
      </>
    );
  } else if (view && view.status === "ok") {
    body = <p className="text-sm text-muted-foreground">AI couldn&apos;t write a read that matched the run{view.reason ? `: ${view.reason}` : ""}. Run again to try once more.</p>;
  } else if (view) {
    body = <p className="text-sm text-muted-foreground">AI couldn&apos;t review this version{view.reason ? `: ${view.reason}` : ""}. Run again to try once more.</p>;
  } else if (!configured && !demo) {
    body = (
      <p className="text-sm text-muted-foreground">
        <b className="font-medium text-foreground">{AI_NOT_SET_UP}.</b> This server has no Anthropic API key, so nothing is written. The findings below still come straight from the analysis rules.
      </p>
    );
  } else if (!hasFirstPrinciples && !demo) {
    body = (
      <p className="text-sm text-muted-foreground">
        AI hasn&apos;t reviewed {scope === "company" ? "the company" : "this process"} yet. Write its first principles so the review can judge it against your goal.{" "}
        {firstPrinciplesHref && (
          <Link href={firstPrinciplesHref} className="font-medium text-foreground underline">
            Write first principles
          </Link>
        )}
      </p>
    );
  } else {
    body = <p className="text-sm text-muted-foreground">AI hasn&apos;t reviewed this version yet. It reviews each version when it is published{runnable ? ", or press Run again to review it now" : ""}.</p>;
  }

  return (
    <div data-ai-read={view ? view.status : "empty"} className="flex flex-col gap-2 rounded-xl border bg-card p-4" aria-busy={pending}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-medium">
        <Sparkles aria-hidden className="size-4 text-accent" />
        <span>AI read of this run</span>
        <span className="text-xs font-normal text-muted-foreground">· uses {scope === "company" ? "the company's" : "this process's"} first principles, results and sources</span>
        {canRun && mode !== "readonly" && (
          <span className="ml-auto flex items-center">
            <Button variant="ghost" size="sm" disabled={!runnable || pending} onClick={run} title={!runnable ? (!configured ? AI_NOT_SET_UP : "Write first principles first") : undefined}>
              {pending ? "Running…" : "Run again"}
            </Button>
          </span>
        )}
      </div>
      {body}
      {message && (
        <p role="status" className={message.kind === "error" ? "text-xs text-destructive" : "text-xs text-muted-foreground"}>
          {message.text}
        </p>
      )}
    </div>
  );
}
