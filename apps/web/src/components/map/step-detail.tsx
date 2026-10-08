"use client";

// A step's detail on a read-only map (issue #99): who does it, hands-on time, wait,
// its rating, the insights and confirmed issues on it, and the sources behind its
// numbers. Opens when a step is clicked (or Enter on it) and closes with Escape.

import { useEffect, useRef } from "react";
import { X } from "lucide-react";
import { RATING_LABELS, type Rating } from "@transpera-flow/engine";
import { EVIDENCE_COLUMNS, evidenceOf, type StepRow } from "@transpera-flow/db";
import { LinkedSources, useSourceLinking } from "@/components/sources/linking-context";
import { formatHours } from "@/lib/format";
import { RATING_STYLE } from "@/lib/map/rating";

/** What a screen knows about a step beyond its own numbers. */
export interface StepExtras {
  /** Titles of what the analysis found on the step and nobody has acknowledged yet. */
  insights: string[];
  /** Titles of the confirmed (tracked) open issues on the step. */
  issues: string[];
}

export const NO_EXTRAS: StepExtras = { insights: [], issues: [] };

/** The titles of the sources cited for a step's numbers, in order of first use. */
export function sourcesOf(step: Pick<StepRow, "provenance">, titles: Readonly<Record<string, string>> | undefined): string[] {
  const out: string[] = [];
  for (const column of EVIDENCE_COLUMNS) {
    for (const c of evidenceOf(step, column)) {
      const title = titles?.[c.source_id] ?? "A source that has been deleted";
      if (!out.includes(title)) out.push(title);
    }
  }
  return out;
}

function List({ title, items, empty }: { title: string; items: string[]; empty: string }) {
  return (
    <section className="mt-3">
      <h4 className="text-[11px] font-semibold tracking-wide text-fg-3 uppercase">{title}</h4>
      {items.length ? (
        <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs text-fg">
          {items.map((t) => (
            <li key={t}>{t}</li>
          ))}
        </ul>
      ) : (
        <p className="mt-1 text-xs text-fg-3">{empty}</p>
      )}
    </section>
  );
}

export function StepDetail({
  step,
  who,
  rating,
  reworkTo,
  extras,
  sources,
  onClose,
}: {
  step: StepRow;
  who: string | null;
  rating: Rating | null;
  /** The name of the step rework goes back to; null when it is redone at this step. */
  reworkTo: string | null;
  extras: StepExtras;
  sources: string[];
  onClose: () => void;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  // Where the page loads source links, the Sources block is the links (cited sources are linked automatically) with "+ Link".
  const linking = useSourceLinking();
  // Move focus in when it opens, so a keyboard user lands on it; Escape hands it back to the caller.
  useEffect(() => heading.current?.focus(), [step.id]);
  return (
    <aside
      role="dialog"
      aria-modal="false"
      aria-label={`${step.name}, detail`}
      data-step-detail={step.id}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
        }
      }}
      className="nodrag nopan absolute top-2.5 right-2.5 z-20 max-h-[calc(100%-1.25rem)] w-[min(18rem,calc(100%-1.25rem))] overflow-y-auto rounded-token border border-line bg-panel p-3 shadow-md"
    >
      <div className="flex items-start justify-between gap-2">
        <h3 ref={heading} tabIndex={-1} className="text-sm leading-tight font-semibold outline-none">
          {step.name}
        </h3>
        <button type="button" onClick={onClose} aria-label="Close step detail" className="rounded-sm p-0.5 text-fg-2 hover:bg-panel-2 hover:text-fg">
          <X aria-hidden className="size-4" />
        </button>
      </div>
      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        <dt className="text-fg-3">Who does it</dt>
        <dd>{who ?? "No one assigned"}</dd>
        <dt className="text-fg-3">Hands-on time</dt>
        <dd className="tabular-nums">{Number(step.work_hours) ? formatHours(step.work_hours) : "Not entered"}</dd>
        <dt className="text-fg-3">Wait</dt>
        <dd className="tabular-nums">{Number(step.wait_hours) ? formatHours(step.wait_hours) : "None"}</dd>
        {Number(step.rework_rate) > 0 && (
          <>
            <dt className="text-fg-3">Rework</dt>
            <dd className="tabular-nums">
              {Math.round(Number(step.rework_rate) * 1000) / 10}%{reworkTo ? ` back to ${reworkTo}` : ", redone at this step"}
            </dd>
          </>
        )}
        <dt className="text-fg-3">Rating</dt>
        <dd className="flex items-center gap-1.5">
          {rating ? (
            <>
              <i aria-hidden className="size-2.5 rounded-[3px]" style={{ background: RATING_STYLE[rating].stripe }} />
              {RATING_LABELS[rating]}
            </>
          ) : (
            "Nothing to fix"
          )}
        </dd>
      </dl>
      <List title="Insights" items={extras.insights} empty="Nothing found on this step yet." />
      <List title="Confirmed issues" items={extras.issues} empty="No confirmed issues." />
      {linking ? (
        <LinkedSources
          className="mt-3 flex flex-col gap-1.5"
          target={{ kind: "step", processId: step.process_id, stepId: step.id }}
          label={`Step: ${step.name}`}
          empty="None linked"
        />
      ) : (
        <List title="Sources" items={sources} empty="No source cited for this step's numbers." />
      )}
    </aside>
  );
}
