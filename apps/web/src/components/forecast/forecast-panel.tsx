"use client";

// The forecast on the People page (issue #35, B6): who gets too busy, and when, over the next year, person by person,
// with the same alerts and timeline as the Forecast page. Read only: alerts are acknowledged on the Forecast page,
// which it links to.

import Link from "next/link";
import { useMemo } from "react";
import { ArrowRight } from "lucide-react";
import type { ProcessBundle } from "@transpera-flow/db";
import { RATING_LABELS, toRatingConfig, type AnalysisSettings } from "@transpera-flow/engine";
import { buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { DEFAULT_FORECAST_MONTHS, forecastInsights, forecastModel, today } from "@/lib/forecast/forecast";
import { timelineData } from "@/lib/forecast/timeline";
import { horizonLabel } from "@/lib/horizon";
import { useSimulation } from "@/lib/sim/use-simulation";
import { ForecastTimeline, TimelineLegend } from "./forecast-timeline";

const RATING_CHIP = { risk: "border-crit bg-crit-soft", bad: "border-serious bg-crit-soft/60", good: "border-warn bg-warn-soft", great: "border-line bg-panel-2" } as const;

export function ForecastPanel({
  bundle,
  analysisRules,
  forecastHref,
  startDate,
  months = DEFAULT_FORECAST_MONTHS,
}: {
  bundle: ProcessBundle;
  analysisRules: AnalysisSettings;
  /** The Forecast page, where alerts are acknowledged and the horizon picked. */
  forecastHref: string;
  startDate?: string;
  months?: number;
}) {
  const start = useMemo(() => startDate ?? today(), [startDate]);
  const built = useMemo(() => forecastModel(bundle, months, start), [bundle, months, start]);
  const sim = useSimulation(built.model, 30, 1, { monthly: true });
  const result = sim.status === "done" ? sim.run.result : null;
  const busyLine = toRatingConfig(analysisRules, bundle.workspace.settings.hours_per_week).rules.busy.cutoffs[1];
  const alerts = useMemo(() => (built.model && result ? forecastInsights(built.model, result, analysisRules, start) : null), [built.model, result, analysisRules, start]);
  const data = useMemo(() => (built.model && result ? timelineData(built.model, result, bundle, start) : null), [built.model, result, bundle, start]);
  if (!built.model) return null;
  const span = horizonLabel(months);
  return (
    <section className="flex min-w-0 flex-col gap-3" data-people-forecast>
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h2 className="font-heading text-lg leading-snug font-semibold tracking-tight">Who gets too busy, and when</h2>
          <p className="text-sm text-muted-foreground">The next {span}, with planned hires, leave and the market schedule.</p>
        </div>
        <Link href={forecastHref} className={buttonVariants({ variant: "ghost", size: "sm" })}>
          Open the forecast
          <ArrowRight aria-hidden />
        </Link>
      </div>
      <Card className="gap-3 px-4 py-4" data-chart="people-forecast">
        {alerts === null ? (
          <Skeleton className="h-6 w-2/3" aria-busy="true" />
        ) : alerts.length ? (
          <ul className="flex flex-col gap-1.5 text-sm">
            {alerts.map((a) => (
              <li key={a.key} className="flex flex-wrap items-center gap-2">
                <span className={`rounded-full border px-2 py-0.5 text-2xs font-semibold ${RATING_CHIP[a.rating]}`}>{RATING_LABELS[a.rating]}</span>
                {a.title}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">Nobody crosses the {Math.round(busyLine * 100)}% line in the next {span}.</p>
        )}
        <TimelineLegend busyLine={busyLine} hasMarkers={(data?.markers.length ?? 0) > 0} hasMarket={(data?.market.length ?? 0) > 0} />
        {data ? (
          <ForecastTimeline data={data} rows="people" busyLine={busyLine} label={`How busy each person is per month over the next ${span}, against the ${Math.round(busyLine * 100)}% too busy line.`} />
        ) : sim.status === "error" ? (
          <p className="text-sm text-muted-foreground">The forecast couldn&apos;t be worked out: {sim.error}</p>
        ) : (
          <Skeleton className="h-[320px] w-full" aria-busy="true" />
        )}
      </Card>
    </section>
  );
}
