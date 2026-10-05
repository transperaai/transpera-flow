"use client";

// "Missing for simulation" (issue #167, B14): what a process still lacks before its numbers mean something. The check is one
// shared function (packages/db/src/simulation-gaps.ts): this file only shows its answer, in the upload preview, compactly at the
// top of the process page and the Editor, and as a note on simulation results while any gap remains. It never blocks anything.

import { TriangleAlert } from "lucide-react";
import type { SimulationGap } from "@transpera-flow/db/simulation-gaps";
import { Help } from "@/components/help";
import { cn } from "@/lib/utils";

export const GAPS_HELP = {
  label: "Missing for simulation",
  description:
    "The least a process needs for its numbers to mean something: a role and hands-on time on every work step, a wait on every wait step, odds on every branch of a decision, and how many leads (or recurring tasks) come in. These are values nobody has given yet, which is different from estimates you are still to confirm. Nothing is blocked: the simulation runs with what it has, and says so.",
  example: "Write proposal has no hands-on time: enter how long it takes and it drops off this list.",
} as const;

/** Where to send someone to fix a gap: the step on the canvas, or the Settings section. */
function settingsAnchor(gap: SimulationGap): string {
  return gap.fix.type === "settings" ? `#${gap.fix.where}` : "";
}

/** The gaps as a list; each links to its step (or Settings) when it can. */
export function GapList({
  gaps,
  onSelectStep,
  settingsHref,
}: {
  gaps: readonly SimulationGap[];
  /** Called with a step's id: select it on the canvas. Without it a step gap is plain text. */
  onSelectStep?: (stepId: string) => void;
  /** The workspace's Settings page; a volume gap links to the section that fixes it. Without it that gap is plain text. */
  settingsHref?: string;
}) {
  return (
    <ul className="flex flex-col gap-1" data-gap-list>
      {gaps.map((g, i) => (
        <li key={`${g.kind}-${g.stepId ?? "all"}-${i}`} data-gap-kind={g.kind} className="break-words">
          {g.fix.type === "step" && onSelectStep ? (
            <button type="button" className="text-left underline decoration-dotted underline-offset-2 hover:decoration-solid" onClick={() => onSelectStep((g.fix as { stepId: string }).stepId)}>
              {g.text}
            </button>
          ) : g.fix.type === "settings" && settingsHref ? (
            <a href={`${settingsHref}${settingsAnchor(g)}`} className="underline decoration-dotted underline-offset-2 hover:decoration-solid">
              {g.text}
            </a>
          ) : (
            g.text
          )}
        </li>
      ))}
    </ul>
  );
}

/** The compact warning near the top of the process page and the Editor: "Missing for simulation (3)", opening to the list. */
export function MissingForSimulation({
  gaps,
  onSelectStep,
  settingsHref,
  className,
}: {
  gaps: readonly SimulationGap[];
  onSelectStep?: (stepId: string) => void;
  settingsHref?: string;
  className?: string;
}) {
  if (!gaps.length) return null;
  return (
    <details data-missing-for-simulation className={cn("group rounded-token border border-warn bg-warn-soft px-3 py-2 text-sm", className)}>
      <summary className="flex cursor-pointer list-none items-center gap-2 font-medium [&::-webkit-details-marker]:hidden">
        <TriangleAlert aria-hidden className="size-4 shrink-0" />
        <span>Missing for simulation ({gaps.length})</span>
        <span className="text-xs font-normal text-fg-2 group-open:hidden">Show</span>
        <span className="hidden text-xs font-normal text-fg-2 group-open:inline">Hide</span>
        <Help {...GAPS_HELP} />
      </summary>
      <div className="mt-2">
        <GapList gaps={gaps} onSelectStep={onSelectStep} settingsHref={settingsHref} />
      </div>
    </details>
  );
}

/** A short note under simulation results while any gap remains: the numbers come from what the process has so far. */
export function IncompleteDataNote({ count, className }: { count: number; className?: string }) {
  if (count <= 0) return null;
  return (
    <p role="note" data-incomplete-data className={cn("text-xs text-fg-2", className)}>
      Based on incomplete data: {count} {count === 1 ? "thing is" : "things are"} still missing for simulation (see the list above).
    </p>
  );
}
