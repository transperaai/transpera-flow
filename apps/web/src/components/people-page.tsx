"use client";

// The People page (issue #120): the company's client health against its benchmark, the team, and how busy each
// person is. It runs the live process in a worker, as the process page does, and reads the numbers off the run.

import Link from "next/link";
import { useMemo } from "react";
import { ModelError, toEngineModel, type ProcessBundle } from "@transpera-flow/db";
import { RATING_LABELS, clientHealthSummary, type ClientHealthSummary, type Rating } from "@transpera-flow/engine";
import { Help } from "@/components/help";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { benchmarkOf, positionAgainst, type Benchmark } from "@/lib/client-groups";
import { formatNumber, formatPercent } from "@/lib/format";
import { BUSY_LIMIT, personRows, teamSummary, type PersonBusy } from "@/lib/people";
import { useSimulation } from "@/lib/sim/use-simulation";
import { ForecastPanel } from "@/components/forecast/forecast-panel";
import { useRatingSettings } from "@/lib/rules/use-rating-settings";
import type { AnalysisSettings } from "@transpera-flow/engine";

const RATING_CHIP: Record<Rating, string> = {
  risk: "border-crit bg-crit-soft",
  bad: "border-serious bg-crit-soft/60",
  good: "border-warn bg-warn-soft",
  great: "border-line bg-panel-2",
};

const pctWidth = (share: number) => `${Math.max(0, Math.min(100, share * 100))}%`;

function Eyebrow({ children, help }: { children: string; help: { label: string; description: string; example: string } }) {
  return (
    <span className="flex items-center text-2xs font-semibold tracking-wider text-muted-foreground uppercase">
      {children}
      <Help {...help} />
    </span>
  );
}

function BigNumber({ value, unit }: { value: string; unit?: string }) {
  return (
    <span className="text-3xl font-semibold tabular-nums">
      {value}
      {unit && <small className="ml-1.5 text-sm font-normal text-muted-foreground">{unit}</small>}
    </span>
  );
}

export function PeoplePage({
  bundle,
  settingsHref,
  forecast,
}: {
  bundle: ProcessBundle;
  /** Where the benchmark is set; null on the demo, which has no Settings. */
  settingsHref: string | null;
  /**
   * Who gets too busy, and when (issue #35): the Forecast page it links to, the analysis rules (omitted: the demo's,
   * edited in this tab), and on the demo its sample plan and fixed start date.
   */
  forecast?: { href: string; analysisRules?: AnalysisSettings; demo?: boolean; bundle?: ProcessBundle; startDate?: string };
}) {
  const forecastRules = useRatingSettings(forecast?.demo === true, forecast?.analysisRules);
  const model = useMemo(() => {
    try {
      return toEngineModel(bundle);
    } catch (err) {
      if (err instanceof ModelError) return null;
      throw err;
    }
  }, [bundle]);
  const sim = useSimulation(model);
  const run = sim.run;
  const benchmark = benchmarkOf(bundle.workspace.settings);
  const view = useMemo(() => {
    if (!model || !run) return null;
    const fte = new Map(bundle.people.map((p) => [p.id, Number(p.fte)]));
    const rows = personRows(model, run.result, fte);
    return { health: clientHealthSummary(model, run.result), rows, team: teamSummary(rows) };
  }, [model, run, bundle.people]);

  if (!model) {
    return <Card className="p-4 text-sm text-muted-foreground">This workspace&apos;s live process can&apos;t be simulated yet, so there is nothing to show here. Fix it on the map first.</Card>;
  }
  if (!view) {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        {sim.status === "error" ? `The simulation failed: ${sim.error}` : "Running the simulation…"}
      </p>
    );
  }
  const { health, rows, team } = view;
  return (
    <>
      <div className="grid gap-4 md:grid-cols-3" aria-busy={sim.status === "running"}>
        <ClientHealthCard health={health} />
        <BenchmarkCard score={health.score} benchmark={benchmark} settingsHref={settingsHref} />
        <TeamCard team={team} />
      </div>
      {health.groups.length > 0 && <ClientGroupsTable health={health} />}
      <HowBusy rows={rows} />
      {forecast && <ForecastPanel bundle={forecast.bundle ?? bundle} analysisRules={forecastRules} forecastHref={forecast.href} startDate={forecast.startDate} />}
    </>
  );
}

function ClientHealthCard({ health }: { health: ClientHealthSummary }) {
  return (
    <Card>
      <CardContent className="flex flex-col gap-2">
        <Eyebrow
          help={{
            label: "Client health",
            description: "How happy your clients are on average, from 0 to 100, at the end of the simulated period. Late or missed servicing work lowers it, and unhappy clients leave sooner.",
            example: "72 means most clients are fine, but some are slipping.",
          }}
        >
          Client health · company
        </Eyebrow>
        {health.score === null ? (
          <p className="text-sm text-muted-foreground">No clients are counted yet. Count them per service in Settings, under Services and client groups.</p>
        ) : (
          <>
            <BigNumber value={String(Math.round(health.score))} unit="/ 100" />
            <div
              role="img"
              aria-label={`${formatPercent(health.healthy)} healthy, ${formatPercent(health.watch)} watch, ${formatPercent(health.atRisk)} at risk`}
              className="flex h-3 overflow-hidden rounded-full bg-panel-2"
            >
              <i className="bg-good" style={{ width: pctWidth(health.healthy) }} />
              <i className="bg-warn" style={{ width: pctWidth(health.watch) }} />
              <i className="bg-crit" style={{ width: pctWidth(health.atRisk) }} />
            </div>
            <p className="text-xs text-muted-foreground">
              {formatPercent(health.healthy)} healthy · {formatPercent(health.watch)} watch · {formatPercent(health.atRisk)} at risk
              {health.groups.length > 0 ? ", across all client groups" : ""}
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function BenchmarkCard({ score, benchmark, settingsHref }: { score: number | null; benchmark: Benchmark | null; settingsHref: string | null }) {
  return (
    <Card>
      <CardContent className="flex flex-col gap-2">
        <Eyebrow
          help={{
            label: "Benchmark",
            description: "The range of client health that is normal for a business like yours, which you enter in Settings. It tells you whether your own number is good or bad.",
            example: "70 to 80 is typical for a small SEO and PPC agency.",
          }}
        >
          Benchmark
        </Eyebrow>
        {benchmark ? (
          <>
            <BigNumber value={`${formatNumber(benchmark.low, 0)}–${formatNumber(benchmark.high, 0)}`} />
            <p className="text-xs text-muted-foreground">
              Your entered benchmark.
              {score !== null && ` Your clients are ${positionAgainst(score, benchmark) === "in range" ? "in range" : `${positionAgainst(score, benchmark)} it`} at ${Math.round(score)}.`}
            </p>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">
            No benchmark entered.{" "}
            {settingsHref ? (
              <>
                Add one in{" "}
                <Link href={`${settingsHref}#client-groups-heading`} className="underline underline-offset-2">
                  Settings
                </Link>{" "}
                to see how your client health compares.
              </>
            ) : (
              "Add one in Settings to see how your client health compares."
            )}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function TeamCard({ team }: { team: ReturnType<typeof teamSummary> }) {
  return (
    <Card>
      <CardContent className="flex flex-col gap-2">
        <Eyebrow
          help={{
            label: "Team",
            description: "How many people work in the business and how much of a full-time job that adds up to.",
            example: "11 people at 10.4 FTE: a couple work part time.",
          }}
        >
          Team
        </Eyebrow>
        <BigNumber value={String(team.people)} unit={`${team.people === 1 ? "person" : "people"}${team.fte !== null ? ` · ${formatNumber(team.fte, 1)} FTE` : ""}`} />
        <p className="text-xs text-muted-foreground">
          {team.busyInBadMonth === 0
            ? `Nobody is above ${formatPercent(BUSY_LIMIT)} busy in a bad month`
            : `${team.busyInBadMonth} ${team.busyInBadMonth === 1 ? "person" : "people"} above ${formatPercent(BUSY_LIMIT)} busy in a bad month`}
        </p>
      </CardContent>
    </Card>
  );
}

function RatingChip({ rating }: { rating: Rating }) {
  return <span className={`rounded-full border px-2 py-px text-xs whitespace-nowrap ${RATING_CHIP[rating]}`}>{RATING_LABELS[rating]}</span>;
}

function ClientGroupsTable({ health }: { health: ClientHealthSummary }) {
  return (
    <Card className="gap-0 py-0">
      <div className="flex items-center px-4 pt-4 pb-2">
        <h2 className="font-heading text-base font-medium">Client groups</h2>
        <Help
          label="Client groups"
          description="Each service's clients, rated on how healthy they are at the end of the simulated period. Great is 75 or more, Good 65 to 75, Bad 50 to 65 and Operational risk under 50."
          example="PPC clients start at 71 and slip to 62: Bad, not urgent."
        />
      </div>
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Service</TableHead>
              <TableHead className="text-right">Clients</TableHead>
              <TableHead className="hidden text-right sm:table-cell">Starting health</TableHead>
              <TableHead className="text-right">Health</TableHead>
              <TableHead>Rating</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {health.groups.map((g) => (
              <TableRow key={g.service}>
                <TableCell className="font-medium">{g.name}</TableCell>
                <TableCell className="text-right tabular-nums">{formatNumber(g.clients, 0)}</TableCell>
                <TableCell className="hidden text-right tabular-nums sm:table-cell">{Math.round(g.startHealth)}</TableCell>
                <TableCell className="text-right tabular-nums">{Math.round(g.health)}</TableCell>
                <TableCell>
                  <RatingChip rating={g.rating} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </Card>
  );
}

function HowBusy({ rows }: { rows: PersonBusy[] }) {
  return (
    <Card className="gap-0 py-0">
      <div className="flex items-center px-4 pt-4 pb-2">
        <h2 className="font-heading text-base font-medium">How busy</h2>
        <Help
          label="How busy"
          description="The share of each person's working week that the simulation fills, on average. P90 is a bad month: it is that busy or worse one month in ten. Above 85% is too busy."
          example="Maya at 82% average and 97% P90 is fine most months but cannot cope with a bad one."
        />
      </div>
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Role</TableHead>
              <TableHead className="text-right">FTE</TableHead>
              <TableHead className="hidden sm:table-cell">How busy</TableHead>
              <TableHead className="text-right">Average</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((p) => (
              <TableRow key={p.id}>
                <TableCell className="font-medium">{p.name}</TableCell>
                <TableCell className="text-sm">{p.role}</TableCell>
                <TableCell className="text-right tabular-nums">{p.fte === null ? "–" : formatNumber(p.fte, 1)}</TableCell>
                <TableCell className="hidden min-w-40 sm:table-cell">
                  <span className="block h-2 overflow-hidden rounded-full bg-panel-2" role="img" aria-label={`${formatPercent(p.average)} busy on average, ${formatPercent(p.p90)} in a bad month`}>
                    <i
                      className={`block h-full ${p.average >= BUSY_LIMIT ? "bg-crit" : p.average >= 0.75 ? "bg-warn" : "bg-accent"}`}
                      style={{ width: pctWidth(p.average) }}
                    />
                  </span>
                </TableCell>
                <TableCell className="text-right whitespace-nowrap tabular-nums">
                  {formatPercent(p.average)} <span className="text-muted-foreground">P90 {formatPercent(p.p90)}</span>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </Card>
  );
}
