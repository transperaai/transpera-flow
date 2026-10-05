// The Overview's health strip (issue #173, B15): four cards on how well the operation runs. Process health and Open issues
// count by rating; Flow efficiency is the share of elapsed time that is hands-on work; Improvement delivered is what the
// implemented solutions saved. Each has a plain empty state. No (i)s (QA wave 1): each card says what it counts.

import type { ReactNode } from "react";
import { RATING_LABELS, type Rating } from "@transpera-flow/engine";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { formatNumber } from "@/lib/format";
import { flowEfficiencyWords, type OpenIssues } from "@/lib/overview/health";
import type { Delivered } from "@/lib/overview/impact";
import { cn } from "@/lib/utils";

const LABEL = "text-2xs font-semibold tracking-wider text-muted-foreground uppercase";
const VALUE = "font-heading text-2xl font-semibold tracking-tight";

function HealthCard({ id, label, children, busy = false }: { id: string; label: string; children: ReactNode; busy?: boolean }) {
  return (
    <Card className="min-w-0 gap-1.5 px-4 py-3.5 shadow-token" data-card={id} aria-busy={busy || undefined}>
      <h3 className={LABEL}>{label}</h3>
      {children}
    </Card>
  );
}

function Loading() {
  return (
    <>
      <Skeleton className="h-8 w-24" />
      <Skeleton className="h-2 w-full" />
      <Skeleton className="h-3.5 w-32" />
    </>
  );
}

/** A thin bar split into parts, 2px apart, each part as wide as its share. Text beside it carries the numbers. */
export function Meter({ parts, label }: { parts: { key: string; value: number; fill: string; pattern?: boolean }[]; label: string }) {
  const total = parts.reduce((a, p) => a + p.value, 0);
  return (
    <span role="img" aria-label={label} className="flex h-2 w-full gap-0.5 overflow-hidden rounded-full bg-muted/60">
      {total > 0 &&
        parts.map((p) =>
          p.value > 0 ? (
            <span
              key={p.key}
              className="block h-full first:rounded-l-full last:rounded-r-full"
              style={{
                flexGrow: p.value,
                flexBasis: 0,
                background: p.pattern ? `repeating-linear-gradient(135deg, ${p.fill} 0 1.5px, transparent 1.5px 4px)` : p.fill,
              }}
            />
          ) : null,
        )}
    </span>
  );
}

/** Counts by rating as a line of dots and numbers, worst first. */
function RatingLine({ counts }: { counts: { rating: Rating; count: number }[] }) {
  return (
    <ul className="flex flex-wrap gap-x-2.5 gap-y-0.5 text-xs text-muted-foreground">
      {counts.map((c) => (
        <li key={c.rating} className="inline-flex items-center gap-1" data-rating={c.rating}>
          <i aria-hidden className="size-2 rounded-full" style={{ background: `var(--rate-${c.rating})` }} />
          <b className="font-semibold text-foreground tabular-nums">{c.count}</b> {RATING_LABELS[c.rating]}
        </li>
      ))}
    </ul>
  );
}

const ratingParts = (counts: { rating: Rating; count: number }[]) => counts.map((c) => ({ key: c.rating, value: c.count, fill: `var(--rate-${c.rating})` }));

const plural = (n: number, one: string, many = `${one}s`) => `${formatNumber(n, 0)} ${n === 1 ? one : many}`;

export function ProcessHealthCard({ counts }: { counts: { rating: Rating; count: number }[] | null }) {
  const total = counts?.reduce((a, c) => a + c.count, 0) ?? 0;
  const attention = counts?.filter((c) => c.rating === "risk" || c.rating === "bad").reduce((a, c) => a + c.count, 0) ?? 0;
  return (
    <HealthCard id="process-health" label="Process health" busy={!counts}>
      {!counts ? (
        <Loading />
      ) : total === 0 ? (
        <p className="text-sm text-muted-foreground">No process is published yet.</p>
      ) : (
        <>
          <p className={VALUE}>
            {attention ? `${attention} of ${total}` : `${total} of ${total}`}
            <span className="ml-1.5 text-sm font-normal text-muted-foreground">{attention ? "need attention" : "running well"}</span>
          </p>
          <Meter parts={ratingParts(counts)} label={counts.map((c) => `${c.count} ${RATING_LABELS[c.rating]}`).join(", ")} />
          <RatingLine counts={counts.filter((c) => c.count > 0)} />
        </>
      )}
    </HealthCard>
  );
}

export function OpenIssuesCard({ issues }: { issues: OpenIssues }) {
  return (
    <HealthCard id="open-issues" label="Open issues">
      <p className={VALUE}>
        {formatNumber(issues.total, 0)}
        <span className="ml-1.5 text-sm font-normal text-muted-foreground">open</span>
      </p>
      {issues.total > 0 ? (
        <>
          <Meter parts={ratingParts(issues.byRating)} label={issues.byRating.map((c) => `${c.count} ${RATING_LABELS[c.rating]}`).join(", ")} />
          <RatingLine counts={issues.byRating.filter((c) => c.count > 0)} />
        </>
      ) : (
        <p className="text-xs text-muted-foreground">Nothing open. Acknowledge an insight to track it as an issue.</p>
      )}
      <p className="text-xs text-muted-foreground" data-resolved-this-month>
        {plural(issues.resolvedThisMonth, "issue")} resolved this month
      </p>
    </HealthCard>
  );
}

export function FlowEfficiencyCard({ share, span, error = false }: { share: number | null | undefined; span: string; error?: boolean }) {
  if (share === undefined)
    return (
      <HealthCard id="flow-efficiency" label="Flow efficiency" busy={!error}>
        {error ? <p className="text-sm text-muted-foreground">Can&apos;t be worked out until the company can be simulated.</p> : <Loading />}
      </HealthCard>
    );
  if (share === null)
    return (
      <HealthCard id="flow-efficiency" label="Flow efficiency">
        <p className="text-sm text-muted-foreground">No work went through the steps in the next {span}, so there is nothing to split.</p>
      </HealthCard>
    );
  const words = flowEfficiencyWords(share);
  return (
    <HealthCard id="flow-efficiency" label="Flow efficiency">
      <p className={VALUE}>
        {words.working}%<span className="ml-1.5 text-sm font-normal text-muted-foreground">working</span>
      </p>
      <Meter
        parts={[
          { key: "working", value: words.working, fill: "var(--accent)" },
          { key: "waiting", value: words.waiting, fill: "var(--fg-3)", pattern: true },
        ]}
        label={words.text}
      />
      <p className="text-xs text-muted-foreground">
        {words.text} over the next {span}: the share of the time at the steps that someone is working on it.
      </p>
    </HealthCard>
  );
}

const hours = (h: number) => `${formatNumber(Math.abs(h), Math.abs(h) < 10 ? 1 : 0)} h`;
const days = (d: number) => `${formatNumber(Math.abs(d), Math.abs(d) < 10 ? 1 : 0)} ${Math.abs(d) === 1 ? "day" : "days"}`;

export function ImprovementCard({ delivered, status }: { delivered: Delivered | null; status: "running" | "done" | "error" }) {
  if (status === "running")
    return (
      <HealthCard id="improvement" label="Improvement delivered" busy>
        <Loading />
      </HealthCard>
    );
  if (status === "error" || !delivered)
    return (
      <HealthCard id="improvement" label="Improvement delivered">
        <p className="text-sm text-muted-foreground" data-empty>
          {status === "error" ? "The before and after of your solutions couldn't be worked out." : "Nothing implemented yet."}
        </p>
        {status !== "error" && (
          <p className="text-xs text-muted-foreground">When an issue is resolved by a solution, the hours a month it saves and the days it cuts from the time to complete show here, from the solution&apos;s before and after.</p>
        )}
      </HealthCard>
    );
  const saved = delivered.hoursSaved;
  return (
    <HealthCard id="improvement" label="Improvement delivered">
      <p className={cn(VALUE, saved < 0 && "text-warn")}>
        {hours(saved)}
        <span className="ml-1.5 text-sm font-normal text-muted-foreground">{saved >= 0 ? "a month saved" : "a month added"}</span>
      </p>
      {delivered.daysCut !== null && (
        <p className="text-xs text-muted-foreground">
          {days(delivered.daysCut)} {delivered.daysCut >= 0 ? "cut from" : "added to"} the time to complete
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        By {plural(delivered.count, "implemented solution")}, from each one&apos;s before and after.
      </p>
    </HealthCard>
  );
}
