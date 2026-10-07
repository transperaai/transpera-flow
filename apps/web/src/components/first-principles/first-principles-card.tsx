"use client";

// The first-principles card at the top of the process page (issue #119, A54): the job, how often each success measure
// is met today (from the run on screen), the root cause, and how many requirements and delete candidates are in
// question. "Open →" goes to the flow. Replaces A38's "Not started" placeholder.

import { useMemo } from "react";
import Link from "next/link";
import type { ProcessBundle } from "@transpera-flow/db";
import {
  countFilled,
  countFlags,
  describeTarget,
  firstPrinciplesFlags,
  firstPrinciplesSummary,
  isBlank,
  measuresMetToday,
  type EngineModel,
  type FirstPrinciples,
  type SimulationResult,
} from "@transpera-flow/engine";
import { Help } from "@/components/help";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { namedForViewer, viewerOf } from "@/lib/viewer";
import { EDIT_ONLY } from "@/lib/phone";

const tone = (pct: number) => (pct >= 80 ? "text-good" : pct >= 50 ? "text-warn" : "text-crit");

export function FirstPrinciplesCard({
  bundle,
  doc,
  model,
  result,
  href,
  canEdit,
  draftChanged = false,
  inheritedFrom = null,
}: {
  /** The version the page shows, for the people and steps the checks compare with. */
  bundle: ProcessBundle;
  /** The answers for that version; null when there are none ("Not started"). */
  doc: FirstPrinciples | null;
  model: EngineModel | null;
  /** The run on the page, which the "met today" shares come from; null while it runs. */
  result: SimulationResult | null;
  href: string;
  canEdit: boolean;
  /** The draft has answers the live version doesn't. */
  draftChanged?: boolean;
  /** The version has no answers of its own; these are from this earlier one. */
  inheritedFrom?: number | null;
}) {
  const started = doc !== null && !isBlank(doc);
  const rows = useMemo(() => (doc && model && result ? measuresMetToday(doc, model, result, bundle.process.id) : []), [doc, model, result, bundle.process.id]);
  const flagCount = useMemo(() => {
    if (!doc) return 0;
    const checks = rows.flatMap((r) => (r.check ? [r.check] : []));
    return countFlags(
      firstPrinciplesFlags(doc, {
        steps: bundle.steps.map((s) => ({ id: s.id, name: s.name })),
        people: namedForViewer(viewerOf(bundle), bundle.people).map((p) => ({ id: p.id, name: p.name })),
        roles: bundle.roles.map((r) => ({ name: r.name })),
        checks,
      }),
    );
  }, [doc, rows, bundle]);

  if (!started || !doc) {
    return (
      <div className="flex flex-col gap-2 rounded-token border border-dashed border-line p-4" data-testid="first-principles">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm font-semibold">
            Not started
            {draftChanged && <span className="ml-2 rounded-full border border-warn bg-warn-soft px-2 py-0.5 text-xs font-normal text-fg">Draft has changes that aren&apos;t published</span>}
          </p>
          <Button asChild size="sm" className={canEdit ? `bg-edit text-edit-fg hover:bg-edit/90 ${EDIT_ONLY}` : "bg-edit text-edit-fg hover:bg-edit/90"} data-edit-entry={canEdit || undefined}>
            <Link href={href}>{canEdit ? "Work through the 7 steps →" : "Open →"}</Link>
          </Button>
        </div>
        <p className="text-sm text-fg-2">
          Strip the process back to what is true: the job it does, hard truths, who owns each requirement, what to delete and how success is measured. The
          analysis will judge the process against it.
        </p>
      </div>
    );
  }

  const s = firstPrinciplesSummary(doc);
  const measures = rows.filter((r) => r.measure.kpi !== null || r.measure.text.trim());
  return (
    <div className="flex flex-col gap-3 rounded-token border border-line bg-card p-4 shadow-token" data-testid="first-principles">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-fg-2">
          {countFilled(doc)} of 7 steps ·{" "}
          {flagCount ? <span className="font-semibold text-warn">{flagCount} {flagCount === 1 ? "flag" : "flags"} to look at</span> : "no flags"}
          {draftChanged && <span className="ml-2 rounded-full border border-warn bg-warn-soft px-2 py-0.5 text-xs text-fg">Draft has changes that aren&apos;t published</span>}
          {inheritedFrom !== null && <span className="ml-2 text-xs">From version {inheritedFrom}</span>}
        </p>
        <Button asChild size="sm" className="bg-edit text-edit-fg hover:bg-edit/90">
          <Link href={href}>Open →</Link>
        </Button>
      </div>
      <div className="grid gap-4 md:grid-cols-3">
        <div className="min-w-0">
          <span className="text-xs font-semibold tracking-wide text-fg-2 uppercase">The job</span>
          <p className="text-sm font-medium">{s.job || "Not written yet"}</p>
          {(doc.job.who.trim() || doc.job.done.trim()) && (
            <p className="text-xs text-fg-2">
              {doc.job.who.trim() && <>For {doc.job.who.trim()}. </>}
              {doc.job.done.trim() && <>Done: {doc.job.done.trim()}.</>}
            </p>
          )}
        </div>
        <div className="min-w-0">
          <span className="flex items-center text-xs font-semibold tracking-wide text-fg-2 uppercase">
            Success measures · met today
            <Help
              label="Met today"
              description="For each measure the simulation can work out, the share of its 30 runs that reach your target, for the process as it is on this page. Measures it can't work out are listed without a share."
              example="“Win rate above 30%: 61%” means 61 of every 100 runs reach a win rate over 30%."
            />
          </span>
          {measures.length ? (
            <ul className="mt-1 flex flex-col gap-1">
              {measures.map(({ measure, metShare }) => {
                const pct = metShare === null ? null : Math.round(metShare * 100);
                return (
                  <li key={measure.id} className="flex items-baseline justify-between gap-2 text-sm">
                    <span className="min-w-0">
                      {measure.text.trim() || describeTarget(measure)}
                      {measure.kpi === null && <span className="block text-xs text-fg-2">Not checked by simulation</span>}
                    </span>
                    <span className={cn("shrink-0 tabular-nums", pct === null ? "text-fg-2" : tone(pct))}>{pct === null ? (measure.kpi === null ? "—" : result ? "—" : "…") : `${pct}%`}</span>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="text-sm text-fg-2">No measures yet.</p>
          )}
        </div>
        <div className="min-w-0">
          <span className="text-xs font-semibold tracking-wide text-fg-2 uppercase">Root cause</span>
          <p className="text-sm font-medium">{s.root || "Not found yet"}</p>
          <span className="mt-2 block text-xs font-semibold tracking-wide text-fg-2 uppercase">Challenged</span>
          <p className="text-sm">
            {s.challenged} {s.challenged === 1 ? "requirement" : "requirements"} · {s.deleteCandidates} delete {s.deleteCandidates === 1 ? "candidate" : "candidates"}
          </p>
        </div>
      </div>
    </div>
  );
}
