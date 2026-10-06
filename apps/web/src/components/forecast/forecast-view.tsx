"use client";

// The Forecast page (issue #35, B6): will someone become too busy, and when? The company model is run forward month
// by month over the horizon picked, with planned hires (people's start dates), end dates and leave, the market
// schedule and the client groups. The first month each role and person crosses the "Too busy" line becomes an insight
// (Acknowledge, as any other), and the monthly timeline shows how busy each role or person is, the client groups by
// service, the market conditions and the planned changes. B7 (#36) will let people drag those markers and compare
// plans on the same timeline.

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";
import { partOf, type IssueRow, type ProcessBundle, type SourceRow } from "@transpera-flow/db";
import { toRatingConfig } from "@transpera-flow/engine";
import { Help } from "@/components/help";
import { HorizonPicker } from "@/components/horizon-picker";
import { InsightsSection } from "@/components/insights";
import { PageHeader } from "@/components/shell/page";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { DEFAULT_FORECAST_MONTHS, forecastInsights, forecastModel, today } from "@/lib/forecast/forecast";
import { timelineData } from "@/lib/forecast/timeline";
import { horizonLabel, horizonWeeks, isHorizonMonths } from "@/lib/horizon";
import { issueFormOptions } from "@/lib/issues/draft";
import { useIssues } from "@/lib/issues/use-issues";
import { ANALYSIS_DEFAULTS } from "@/lib/analysis/defaults";
import { useSimulation } from "@/lib/sim/use-simulation";
import { cn } from "@/lib/utils";
import { ForecastTimeline, TimelineLegend } from "./forecast-timeline";
import { namedForViewer, viewerOf } from "@/lib/viewer";

export interface ForecastViewProps {
  /** The company model's process (the first sales pipeline), with the servicing processes it runs beside. */
  live: ProcessBundle;
  /** Tracked issues: an acknowledged alert is one of them. */
  issues: IssueRow[];
  sources?: SourceRow[];
  mode: "live" | "demo" | "readonly";
  issuesHref: string;
  rulesHref?: string;
  /** Settings, where people's start dates, end dates and leave are set. Null on the demo. */
  peopleHref?: string | null;
  /** The ISO date the forecast starts on; today when omitted. Fixed on the demo so its months don't move. */
  startDate?: string;
  /** A line under the title, e.g. the demo's note about its sample plan. */
  note?: string;
}

const NO_SOURCES: SourceRow[] = [];
const SECTION_TITLE = "font-heading text-lg leading-snug font-semibold tracking-tight";
const isForecastIssue = (i: IssueRow) => i.detected_key?.startsWith("forecast:") ?? false;

export function ForecastView({ live, issues, sources = NO_SOURCES, mode, issuesHref, peopleHref = null, startDate, note }: ForecastViewProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const horizonParam = Number(searchParams.get("horizon"));
  const [months, setMonths] = useState<number>(isHorizonMonths(horizonParam) ? horizonParam : DEFAULT_FORECAST_MONTHS);
  const pick = (m: number) => {
    setMonths(m);
    const next = new URLSearchParams(searchParams.toString());
    next.set("horizon", String(m));
    router.replace(`${pathname}?${next.toString()}`, { scroll: false });
  };
  const [rows, setRows] = useState<"roles" | "people">("roles");
  const start = useMemo(() => startDate ?? today(), [startDate]);

  const built = useMemo(() => forecastModel(live, months, start), [live, months, start]);
  const sim = useSimulation(built.model, 30, 1, { monthly: true, monthStarts: built.monthStarts });
  const result = sim.status === "done" && built.model && sim.run.result.H === built.model.horizonWeeks * built.model.hoursPerWeek ? sim.run.result : null;
  const rules = ANALYSIS_DEFAULTS;
  const cutoffs = useMemo(() => toRatingConfig(rules, live.workspace.settings.hours_per_week).rules.busy.cutoffs, [rules, live.workspace.settings.hours_per_week]);
  const busyLine = cutoffs[1];
  const alerts = useMemo(() => (built.model && result ? forecastInsights(built.model, result, rules, start) : null), [built.model, result, rules, start]);
  const data = useMemo(() => (built.model && result ? timelineData(built.model, result, live, start) : null), [built.model, result, live, start]);

  // Acknowledging an alert tracks it as an issue, as on the Overview; this page lists only the forecast's own.
  const liveRevisions = useMemo(() => Object.fromEntries([partOf(live), ...(live.otherProcesses ?? [])].map((p) => [p.process.id, p.revision.id])), [live]);
  const all = useIssues(live.workspace.id, issues, mode, liveRevisions);
  const state = useMemo(() => ({ ...all, issues: all.issues.filter(isForecastIssue) }), [all]);
  const parts = useMemo(() => [partOf(live), ...(live.otherProcesses ?? [])], [live]);
  const processOfStepMap = useMemo(() => new Map(parts.flatMap((p) => p.steps.map((s) => [s.id, p.process.id] as const))), [parts]);
  const stepNames = useMemo(() => new Map(parts.flatMap((p) => p.steps.map((s) => [s.id, s.name] as const))), [parts]);
  const processNames = useMemo(() => new Map(parts.map((p) => [p.process.id, p.process.name])), [parts]);
  const formOptions = useMemo(
    () =>
      issueFormOptions({
        processes: parts.map((p) => ({ id: p.process.id, name: p.process.name })),
        steps: parts.flatMap((p) => p.steps),
        people: namedForViewer(viewerOf(live), live.people.filter((p) => p.active)),
        sources,
      }),
    [parts, live, sources],
  );

  const span = horizonLabel(months);
  const planned = data?.markers.length ?? 0;

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        eyebrow="Company"
        title="Forecast"
        description={note ?? "Who gets too busy, and when: your live model run forward month by month, with planned hires, leave and the market schedule."}
        actions={<HorizonPicker weeks={horizonWeeks(months)} onChange={pick} />}
      />

      {built.error ? (
        <Card className="px-4 py-3 text-sm" role="alert">
          The company can&apos;t be simulated yet: {built.error}.
        </Card>
      ) : null}

      <section className="flex min-w-0 flex-col gap-3" data-forecast-alerts>
        <div className="flex flex-col gap-0.5">
          <h2 className={cn(SECTION_TITLE, "flex items-center")}>
            Who gets too busy, and when
            <Help
              label="Too busy alerts"
              description="For each role and person, the first month their work passes the “Too busy” line, on average or in a bad month (the worst 10% of the 30 simulated runs). Each is an insight: acknowledge it to track it as an issue."
              example="“PPC specialist gets too busy in February (92% in a bad month)” means hiring or moving work before February avoids it."
            />
          </h2>
          <p className="text-sm text-muted-foreground">
            Over the next {span}. Roles already too busy today are in the Overview&apos;s insights instead.
          </p>
        </div>
        {alerts !== null && alerts.length === 0 && state.issues.length === 0 ? (
          <Card className="px-4 py-3 text-sm text-muted-foreground" data-forecast-empty>
            Nobody crosses the {Math.round(busyLine * 100)}% line in the next {span}, on average or in a bad month.
          </Card>
        ) : (
          <InsightsSection
            state={state}
            detected={alerts}
            processId={live.process.id}
            scenarios={[]}
            formOptions={formOptions}
            currency={live.workspace.settings.currency}
            stepName={(id) => stepNames.get(id) ?? null}
            processName={(id) => {
              const p = processOfStepMap.get(id);
              return p ? (processNames.get(p) ?? null) : null;
            }}
            processOfStep={(id) => processOfStepMap.get(id) ?? null}
            onLight={() => {}}
            registerHref={issuesHref}
            canEdit={mode !== "readonly"}
          />
        )}
      </section>

      <section className="flex min-w-0 flex-col gap-3" data-forecast-timeline-section>
        <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
          <div className="flex min-w-0 flex-col gap-0.5">
            <h2 className={SECTION_TITLE}>Month by month</h2>
            <p className="text-sm text-muted-foreground">How busy each {rows === "roles" ? "role" : "person"} is, with the 10–90% range from 30 runs, and your clients by service.</p>
          </div>
          <div role="group" aria-label="Show" className="inline-flex rounded-lg border border-border bg-muted/40 p-0.5 text-xs">
            {(["roles", "people"] as const).map((r) => (
              <button
                key={r}
                type="button"
                aria-pressed={rows === r}
                onClick={() => setRows(r)}
                className={cn(
                  "rounded-md px-2.5 py-1 font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  rows === r ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
                )}
              >
                {r === "roles" ? "By role" : "By person"}
              </button>
            ))}
          </div>
        </div>
        <Card className="gap-3 px-4 py-4" data-chart="forecast">
          <div className="flex flex-wrap items-center gap-x-1 gap-y-1">
            <TimelineLegend busyLine={busyLine} hasUncovered={data?.roles.some((r) => r.uncovered) ?? false} hasMarkers={planned > 0} hasMarket={(data?.market.length ?? 0) > 0} />
            <Help
              label="The “Too busy” line"
              description="Where a role or person counts as too busy (the “Too busy” cut-off for Bad). Above it there is little room for a bad month or a new client. You can change it in Settings, Analysis rules."
              example="At 85%, someone with 40 hours spends more than 34 of them on work."
            />
          </div>
          {data ? (
            <ForecastTimeline
              data={data}
              rows={rows}
              cutoffs={cutoffs}
              label={`How busy each ${rows === "roles" ? "role" : "person"} is per month over the next ${span}, against the ${Math.round(busyLine * 100)}% too busy line.`}
            />
          ) : sim.status === "error" ? (
            <p className="text-sm text-muted-foreground">The forecast couldn&apos;t be worked out: {sim.error}</p>
          ) : (
            <Skeleton className="h-[320px] w-full" aria-busy="true" />
          )}
          <p className="text-xs text-muted-foreground">
            {planned ? `${planned} planned change${planned === 1 ? "" : "s"}: ` : "No planned hires, end dates or leave in this span. "}
            {data?.markers.map((mk) => `${mk.label} ${mk.kind === "leave" ? `from ${mk.when}` : `on ${mk.when}`}`).join("; ")}
            {planned ? ". " : ""}
            {peopleHref ? (
              <>
                Start dates, end dates and leave are set in{" "}
                <Link href={peopleHref} className="underline">
                  Settings
                </Link>
                , under People.
              </>
            ) : null}{" "}
          </p>
        </Card>
      </section>
    </div>
  );
}
