"use client";

// An issue's status track and its linked solutions, drawn under the issue's row on the process page (issue #174):
// Open, Solution idea, Being built, Implemented, Verified. The stage is worked out in lib/process-page/track.ts.

import Link from "next/link";
import { VerdictWord } from "@/components/solutions/solution-cards";
import { TRACK_STAGES, type IssueTrack } from "@/lib/process-page/track";
import { solutionHref } from "@/lib/solutions/cards";

export function IssueTrackView({ track, base, buildHref }: { track: IssueTrack; base: string; /** Where "Build solution" opens the Editor, for those who can edit an issue still open. */ buildHref?: string | null }) {
  const { stage, closed, solutions, verified } = track;
  return (
    <div className="mt-2 flex flex-col gap-1.5 border-t border-line pt-2" data-track={stage ?? closed}>
      {stage === null ? (
        <p className="text-xs text-fg-2">{closed === "wont_fix" ? "Won't fix: closed without a solution." : "Closed: not a problem."}</p>
      ) : (
        <ol className="grid grid-cols-5 gap-1" aria-label="Where this issue is">
          {TRACK_STAGES.map((label, i) => {
            const done = i < stage;
            const here = i === stage;
            return (
              <li key={label} aria-current={here ? "step" : undefined} data-stage={i} data-state={here ? "here" : done ? "done" : "todo"} className="flex min-w-0 flex-col gap-1">
                <span aria-hidden className={`h-1.5 rounded-full ${here ? "bg-accent" : done ? "bg-accent/45" : "bg-line-2"}`} />
                <span className={`text-[11px] leading-tight ${here ? "font-semibold text-fg" : done ? "text-fg-2" : "text-fg-3"}`}>
                  {label}
                  <span className="sr-only">{here ? " (now)" : done ? " (done)" : " (not yet)"}</span>
                </span>
              </li>
            );
          })}
        </ol>
      )}
      {verified && (
        <p className="text-xs" data-verified>
          <span className="font-semibold">Before and after:</span> <VerdictWord verdict={verified.verdict} />
          {verified.holdsPct !== null && <span className="text-fg-2"> · holds in {Math.round(verified.holdsPct)}% of runs</span>}
          {verified.yours && <span className="text-fg-3"> (your verdict)</span>}
        </p>
      )}
      {solutions.length > 0 && (
        <ul className="flex flex-col gap-0.5" aria-label="Linked solutions">
          {solutions.map((s) => (
            <li key={s.solution.id} className="flex flex-wrap items-baseline justify-between gap-x-3 text-xs" data-solution={s.solution.id}>
              <Link href={solutionHref(base, s.solution.id)} className="min-w-0 hover:underline">
                Solution: {s.solution.name}
              </Link>
              <VerdictWord verdict={s.verdict} className="text-xs" />
            </li>
          ))}
        </ul>
      )}
      {buildHref && (
        <Link href={buildHref} className="self-start text-xs font-semibold text-edit hover:underline">
          ✎ Build solution
        </Link>
      )}
    </div>
  );
}
