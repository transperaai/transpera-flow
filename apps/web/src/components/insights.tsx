"use client";

// Insights v2 (issue #110, A45): the raw analysis from the latest run as rated rows, worst first, on the process page and
// the Overview alike. Hovering or focusing a row lights up the steps it touches on the page's map; clicking opens the
// detail. An insight only becomes an issue (and only then reaches the map) when someone acknowledges it (D24).

import Link from "next/link";
import { useMemo, useState } from "react";
import { ChevronRight, Sparkles } from "lucide-react";
import type { DetectedIssue } from "@transpera-flow/engine";
import type { IssueRow, ScenarioRow } from "@transpera-flow/db";
import { RATING_LABELS, type Rating } from "@transpera-flow/engine";
import { AcknowledgeDialog } from "@/components/acknowledge-dialog";
import { Help } from "@/components/help";
import { LinkedSources, useSourceLinking } from "@/components/sources/linking-context";
import { RatingPill } from "@/components/overview/rating-pill";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { entriesInProcess, formatIssueCost, issueLabel, registerEntries } from "@/lib/issues/register";
import { acknowledgeDraft, acknowledgeInsight, dismissInsight, type InsightContext } from "@/lib/insights/actions";
import type { IssueDraft, IssueFormOptions } from "@/lib/issues/draft";
import { buildInsights, filterByRating, limitInsights, ratingCountsOf, type Insight } from "@/lib/insights/insights";
import type { IssuesState } from "@/lib/issues/use-issues";

/** The (i) texts in an opened insight: only what the screen does not say by itself. */
export const INSIGHT_HELP = {
  cost: {
    label: "Cost per month",
    description: "A rough price of this problem each month, worked out from the numbers in the run. It is an estimate, not a bill. It says n/a when the problem has no money price.",
    example: "About £4,200 a month (estimate): the strategist's overtime and the work that waits for them.",
  },
  dismiss: {
    label: "Dismiss",
    description: "Say this isn't a problem. It leaves the list and stays away until the process's next published version: if the analysis still finds it then, it is listed again and you can dismiss it again. It never reaches the map.",
    example: "Dismiss “Spare time” on a person who is meant to have slack. Publish a new version of the process and, if they still have slack, it comes back for another look.",
  },
} as const;

const RATING_STRIPE: Record<Rating, string> = { risk: "var(--rate-risk)", bad: "var(--rate-bad)", good: "var(--rate-good)", great: "var(--rate-great)" };

export interface InsightsProps {
  /** The insights to show, in order; null while the run is not in. */
  insights: Insight[] | null;
  currency: string;
  /** A step's name on this page's map. */
  stepName: (stepId: string) => string | null;
  /** The process a step belongs to, to name it on each row (the Overview). Omit on a process page. */
  processName?: (stepId: string) => string | null;
  /** The pointer or focus is on a row: its steps light up on the map; null when it leaves. */
  onLight: (stepIds: string[] | null) => void;
  /** "Settings → Analysis rules", where each rule's limits are changed. */
  rulesHref?: string;
  /** The issues register; an acknowledged insight links to its issue there. */
  registerHref?: string;
  /** Whether the viewer may acknowledge or dismiss. */
  canAct: boolean;
  /** Saves the Acknowledge dialog's draft. Resolve to something falsy when the save failed, so the dialog stays open. */
  onAcknowledge: (insight: Insight, draft: IssueDraft) => Promise<unknown>;
  /** The draft the Acknowledge dialog opens with for an insight: its rating, steps and sources. */
  ackDraft: (insight: Insight) => IssueDraft;
  /** What the Acknowledge dialog offers to pick: processes, steps, people and sources. */
  formOptions: IssueFormOptions;
  onDismiss: (insight: Insight) => Promise<unknown>;
  /** The sources linked to an insight, if any are known before it is acknowledged. */
  linkedSources?: (insight: Insight) => { id: string; title: string }[];
  /** Show this many at first, with a button for the rest. */
  initialLimit?: number;
  busy?: boolean;
  error?: string | null;
  running?: boolean;
}

/** An acknowledged insight links to its issue's page, `<issues>/<number>`. */
const issueHref = (registerHref: string | undefined, issue: IssueRow) => (registerHref ? `${registerHref}/${issue.number ?? issue.id}` : null);

export function Insights(props: InsightsProps) {
  const { insights, currency, stepName, processName, onLight, registerHref, initialLimit, error, running } = props;
  const [rating, setRating] = useState<Rating | "">("");
  const [open, setOpen] = useState<string | null>(null);
  const [acking, setAcking] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  const counts = useMemo(() => ratingCountsOf(insights ?? []), [insights]);

  if (!insights) {
    return (
      <div className="flex flex-col gap-2" aria-busy="true">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-[4.5rem] w-full rounded-xl" />
        ))}
      </div>
    );
  }
  if (!insights.length) {
    return <p className="rounded-xl border border-dashed p-4 text-sm text-muted-foreground">Nothing to report from the latest run. Every rule is within its limits.</p>;
  }

  const filtered = filterByRating(insights, rating);
  const shown = initialLimit && !all ? limitInsights(filtered, initialLimit) : filtered;
  const opened = insights.find((i) => i.key === open) ?? null;
  const ackFor = insights.find((i) => i.key === acking) ?? null;

  return (
    <div className="flex min-w-0 flex-col gap-3" data-insights>
      <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Filter by rating">
        <Chip on={rating === ""} onClick={() => setRating("")} count={insights.length}>
          All
        </Chip>
        {counts.map((c) => (
          <Chip key={c.rating} on={rating === c.rating} disabled={c.count === 0} onClick={() => setRating(rating === c.rating ? "" : c.rating)} count={c.count} dot={c.rating}>
            {RATING_LABELS[c.rating]}
          </Chip>
        ))}
        <span className="ml-auto flex items-center text-xs text-muted-foreground" aria-live="polite">
          {running ? "Checking the latest run…" : `${filtered.length} insight${filtered.length === 1 ? "" : "s"}`}
        </span>
      </div>

      {error && (
        <p role="alert" className="rounded-lg border border-crit bg-crit-soft p-2 text-xs">
          {error}
        </p>
      )}

      {shown.length === 0 ? (
        <p className="rounded-xl border border-dashed p-4 text-sm text-muted-foreground">No insights have this rating.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {shown.map((i) => {
            const names = i.stepIds.map((id) => stepName(id)).filter((n): n is string => !!n);
            const where = [names.join(", "), processName && i.stepIds[0] ? processName(i.stepIds[0]) : null].filter(Boolean).join(" · ");
            const link = i.issue ? issueHref(registerHref, i.issue) : null;
            const light = i.stepIds.length ? i.stepIds : null;
            return (
              <li
                key={i.key}
                data-insight={i.key}
                data-acknowledged={i.issue ? "" : undefined}
                onMouseEnter={() => onLight(light)}
                onMouseLeave={() => onLight(null)}
                onFocus={() => onLight(light)}
                onBlur={() => onLight(null)}
                className="group flex items-stretch gap-2 rounded-xl border bg-card shadow-token transition-colors focus-within:bg-muted/50 hover:bg-muted/50"
                style={{ borderLeft: `3px solid ${RATING_STRIPE[i.rating]}` }}
              >
                <button type="button" onClick={() => setOpen(i.key)} className="flex min-w-0 flex-1 flex-col gap-1 px-4 py-3 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  <b className="font-semibold">{i.title}</b>
                  <span className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-muted-foreground">
                    <RatingPill rating={i.rating} />
                    <span className="tabular-nums" data-cost title={i.cost.method}>
                      {formatIssueCost(i.cost, currency)}
                    </span>
                    <span className="min-w-0">{i.number}</span>
                  </span>
                  {where && <span className="truncate text-xs text-muted-foreground">{where}</span>}
                </button>
                <span className="flex shrink-0 items-center gap-2 pr-3 text-xs text-muted-foreground">
                  <SourceTag insight={i} />
                  {i.issue &&
                    (link ? (
                      <Link href={link} className="rounded-md border px-2 py-0.5 font-medium text-foreground hover:bg-muted" data-issue-link>
                        {issueLabel(i.issue)} →
                      </Link>
                    ) : (
                      <span className="font-medium text-foreground">{issueLabel(i.issue)}</span>
                    ))}
                  <ChevronRight aria-hidden className="size-4 transition-transform group-hover:translate-x-0.5" />
                </span>
              </li>
            );
          })}
        </ul>
      )}

      {initialLimit && filtered.length > initialLimit && (
        <Button variant="ghost" size="sm" className="self-start" onClick={() => setAll((v) => !v)}>
          {all ? "Show fewer" : `Show all ${filtered.length}`}
        </Button>
      )}

      <InsightDialog
        insight={opened}
        onClose={() => setOpen(null)}
        onStartAcknowledge={(i) => {
          setOpen(null);
          setAcking(i.key);
        }}
        {...props}
        stepName={stepName}
      />
      <AcknowledgeDialog
        open={!!ackFor}
        mode="acknowledge"
        draft={ackFor ? props.ackDraft(ackFor) : EMPTY_DRAFT}
        fromTitle={ackFor?.title}
        options={props.formOptions}
        busy={props.busy}
        error={error}
        onSubmit={(draft) => (ackFor ? props.onAcknowledge(ackFor, draft) : Promise.resolve(false))}
        onClose={() => setAcking(null)}
      />
    </div>
  );
}

function Chip({ on, disabled, onClick, count, dot, children }: { on: boolean; disabled?: boolean; onClick: () => void; count: number; dot?: Rating; children: string }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      disabled={disabled}
      onClick={onClick}
      className={`inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 ${on ? "border-accent bg-accent-soft font-semibold" : "bg-card hover:bg-muted"}`}
    >
      {dot && <i aria-hidden className="size-2 rounded-full" style={{ background: `var(--rate-${dot})` }} />}
      {children}
      <b className="font-mono font-medium text-muted-foreground tabular-nums">{count}</b>
    </button>
  );
}

function SourceTag({ insight }: { insight: Insight }) {
  const ai = insight.source.kind === "ai";
  return (
    <span className="inline-flex max-w-28 items-center gap-1 truncate rounded-md bg-muted px-1.5 py-0.5 sm:max-w-none" data-source={ai ? "ai" : "rule"}>
      {ai && <Sparkles aria-hidden className="size-3 text-accent" />}
      {insight.source.name}
    </span>
  );
}

const EMPTY_DRAFT: IssueDraft = { title: "", rating: "bad", processId: null, scope: "steps", stepIds: [], ownerIds: [], targetMeasure: "", targetNow: "", targetGoal: "", sourceIds: [] };

function InsightDialog({
  insight,
  onClose,
  onStartAcknowledge,
  stepName,
  currency,
  rulesHref,
  registerHref,
  canAct,
  onDismiss,
  linkedSources,
  busy,
  error,
}: InsightsProps & { insight: Insight | null; onClose: () => void; onStartAcknowledge: (insight: Insight) => void }) {
  const [working, setWorking] = useState(false);
  const act = async (run: (i: Insight) => Promise<unknown>) => {
    if (!insight) return;
    setWorking(true);
    try {
      if (await run(insight)) onClose();
    } finally {
      setWorking(false);
    }
  };
  const sources = insight ? (linkedSources?.(insight) ?? []) : [];
  const linking = useSourceLinking();
  const link = insight?.issue ? issueHref(registerHref, insight.issue) : null;
  const ai = insight?.source.kind === "ai";
  return (
    <Dialog open={!!insight} onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        className="max-h-[90svh] overflow-y-auto sm:max-w-xl"
        data-insight-dialog
        onOpenAutoFocus={(e) => {
          // Not the first (i): its tooltip would cover the number. Focus the pop-up itself.
          e.preventDefault();
          (e.currentTarget as HTMLElement).focus();
        }}
      >
        {insight && (
          <>
            <DialogHeader>
              <div className="flex flex-wrap items-center gap-2">
                <RatingPill rating={insight.rating} />
                <span className="inline-flex items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 text-xs">
                  {ai && <Sparkles aria-hidden className="size-3 text-accent" />}
                  {ai ? "AI analysis" : `Rule: ${insight.source.name}`}
                </span>
              </div>
              <DialogTitle>{insight.title}</DialogTitle>
              <DialogDescription>What the analysis found in the latest run.</DialogDescription>
            </DialogHeader>
            <dl className="grid grid-cols-[7.5rem_minmax(0,1fr)] gap-x-4 gap-y-3 text-sm">
              <dt className="text-xs font-medium text-muted-foreground uppercase">The number</dt>
              <dd className="font-mono">{insight.number}</dd>
              {insight.found && (
                <>
                  <dt className="text-xs font-medium text-muted-foreground uppercase">What we found</dt>
                  <dd>{insight.found}</dd>
                </>
              )}
              <dt className="text-xs font-medium text-muted-foreground uppercase">Why it matters</dt>
              <dd>{insight.why}</dd>
              <dt className="text-xs font-medium text-muted-foreground uppercase">Touches</dt>
              <dd className="flex flex-wrap gap-1.5">
                {insight.stepIds.length ? (
                  insight.stepIds.map((id) => (
                    <span key={id} className="rounded-full border px-2 py-0.5 text-xs">
                      {stepName(id) ?? "A removed step"}
                    </span>
                  ))
                ) : (
                  <span className="text-muted-foreground">No step in particular</span>
                )}
              </dd>
              <dt className="flex items-start text-xs font-medium text-muted-foreground uppercase">
                Cost
                <Help {...INSIGHT_HELP.cost} />
              </dt>
              <dd data-cost>{formatIssueCost(insight.cost, currency)}</dd>
              <dt className="text-xs font-medium text-muted-foreground uppercase">How it&apos;s worked out</dt>
              <dd className="text-muted-foreground">
                {ai ? (
                  "AI read this run's results, the process's first principles and linked sources, and wrote this. Every number comes from the simulation."
                ) : (
                  <>
                    The {insight.source.name} rule checked the results of 30 simulated runs against its limits.{" "}
                    {rulesHref && (
                      <Link href={rulesHref} className="text-foreground underline">
                        Settings → Analysis rules
                      </Link>
                    )}
                  </>
                )}
              </dd>
            </dl>

            {linking ? (
              // Where the page loads source links: the links themselves, with the Add / Link source dialog. An insight is linked by its detection key.
              <LinkedSources target={{ kind: "insight", insightKey: insight.key }} label={`Insight: ${insight.title}`} empty="None linked" linkText="+ Link a source" help={false} className="flex flex-col gap-1.5" />
            ) : (
              <div className="flex flex-col gap-1.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-medium text-muted-foreground uppercase">Sources</span>
                  <Button variant="ghost" size="sm" disabled={insight.issue !== null || !canAct} onClick={() => onStartAcknowledge(insight)}>
                    + Link a source
                  </Button>
                </div>
                {sources.length ? (
                  sources.map((s) => (
                    <p key={s.id} className="text-sm font-medium">
                      {s.title}
                    </p>
                  ))
                ) : (
                  <p className="text-sm text-muted-foreground">None linked</p>
                )}
              </div>
            )}

            {error && (
              <p role="alert" className="rounded-lg border border-crit bg-crit-soft p-2 text-xs">
                {error}
              </p>
            )}
            <DialogFooter className="items-center">
              {insight.issue ? (
                link ? (
                  <Button asChild>
                    <Link href={link}>{issueLabel(insight.issue)} →</Link>
                  </Button>
                ) : (
                  <span className="text-sm font-medium">{issueLabel(insight.issue)}</span>
                )
              ) : canAct ? (
                <>
                  <span className="flex items-center">
                    <Button variant="outline" disabled={working || busy} onClick={() => act(onDismiss)}>
                      Dismiss
                    </Button>
                    <Help {...INSIGHT_HELP.dismiss} />
                  </span>
                  <Button disabled={working || busy} onClick={() => onStartAcknowledge(insight)}>
                    Acknowledge as issue…
                  </Button>
                </>
              ) : (
                <p className="text-xs text-muted-foreground">You can read insights here; someone who can edit this workspace acknowledges them.</p>
              )}
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** The insights of one page from its issues state and this run's detections, with Dismiss and Acknowledge wired to the issue store. */
export function InsightsSection({
  state,
  detected,
  processId,
  stepIds,
  scenarios,
  currency,
  processOfStep,
  canEdit,
  ...rest
}: Omit<InsightsProps, "insights" | "onAcknowledge" | "onDismiss" | "busy" | "error" | "canAct" | "ackDraft"> & {
  state: IssuesState;
  /** This run's detections; null until the first run finishes. */
  detected: DetectedIssue[] | null;
  /** The process the detections came from. */
  processId: string;
  /** Keep to these steps (a process page's own and those inside it). Omit for the whole company (the Overview). */
  stepIds?: ReadonlySet<string>;
  scenarios: ScenarioRow[];
  processOfStep?: (stepId: string) => string | null | undefined;
  canEdit: boolean;
}) {
  const insights = useMemo(() => {
    if (detected === null) return null;
    const entries = registerEntries(state.issues, detected, state.revisionOf);
    return buildInsights(stepIds ? entriesInProcess(entries, processId, stepIds) : entries);
  }, [detected, state.issues, state.revisionOf, stepIds, processId]);
  const ctx: InsightContext = { processId, processOfStep, scenarios, options: rest.formOptions };
  const linking = useSourceLinking();
  return (
    <Insights
      {...rest}
      insights={insights}
      currency={currency}
      canAct={canEdit}
      busy={state.busy}
      error={state.error}
      ackDraft={(i) => {
        const draft = acknowledgeDraft(i, ctx);
        // The sources linked to the insight itself come along to the issue it becomes, beside the ones its steps cite.
        const linked = linking?.linkedTo({ kind: "insight", insightKey: i.key }).map((x) => x.source.id) ?? [];
        return linked.length ? { ...draft, sourceIds: [...new Set([...draft.sourceIds, ...linked])] } : draft;
      }}
      onAcknowledge={(i, draft) => acknowledgeInsight(state, i, ctx, draft)}
      onDismiss={(i) => dismissInsight(state, i, ctx)}
    />
  );
}

