"use client";

// The People page (issue #120): the company's client health against its benchmark, the team, and how busy each
// person is. It runs the live process in a worker, as the process page does, and reads the numbers off the run.

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Fragment, useMemo, useState } from "react";
import type { ProcessBundle, Viewer } from "@transpera-flow/db";
import { ABSENCE_MAX_PEOPLE, RATING_LABELS, clientHealthSummary, resolveMoney, toRatingConfig, type ClientHealthSummary, type Rating } from "@transpera-flow/engine";
import { ANALYSIS_DEFAULTS } from "@/lib/analysis/defaults";
import { Help } from "@/components/help";
import { HorizonPicker } from "@/components/horizon-picker";
import { useEngineModel } from "@/components/process-view";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { benchmarkOf, positionAgainst, type Benchmark } from "@/lib/client-groups";
import { formatDateRange, formatNumber, formatPercent } from "@/lib/format";
import { horizonWeeks, isHorizonMonths } from "@/lib/horizon";
import {
  BUSY_LIMIT,
  absenceRows,
  capacityFactorsShown,
  personDetail,
  personRows,
  teamSummary,
  untestedSoleHolders,
  type AbsenceRow,
  type PersonBusy,
  type PersonDetail,
} from "@/lib/people";
import { useAbsenceTest } from "@/lib/sim/absence";
import { useSimulation } from "@/lib/sim/use-simulation";
import { ownRowsOnly, viewerOf } from "@/lib/viewer";
import { ForecastPanel } from "@/components/forecast/forecast-panel";

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
  forecast?: { href: string; demo?: boolean; bundle?: ProcessBundle; startDate?: string };
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  // The horizon: the workspace's own length until one is picked (or ?horizon= says), as on the Overview.
  const horizonParam = Number(searchParams.get("horizon"));
  const [picked, setPicked] = useState<number | null>(isHorizonMonths(horizonParam) ? horizonParam : null);
  const pickHorizon = (months: number) => {
    setPicked(months);
    const next = new URLSearchParams(searchParams.toString());
    next.set("horizon", String(months));
    router.replace(`${pathname}?${next.toString()}`, { scroll: false });
  };
  const weeks = picked === null ? null : horizonWeeks(picked);
  const { model } = useEngineModel(bundle, weeks);
  // The absence test is over the workspace's own length, not the picked horizon (B2 Q2): ratings match the Issues register.
  const { model: baseModel } = useEngineModel(bundle, null);
  const sim = useSimulation(model);
  const run = sim.run;
  const benchmark = benchmarkOf(bundle.workspace.settings);
  const viewer = viewerOf(bundle);
  const [today] = useState(() => new Date().toISOString().slice(0, 10));
  // As on the Issues page, the absence test waits for the first run to finish so it never slows it.
  const [baselineDone, setBaselineDone] = useState(false);
  if (sim.status === "done" && !baselineDone) setBaselineDone(true);
  // Someone who sees everyone tests everyone; a member or viewer tests only their own person, and an unlinked one tests no one (B2 Q3).
  const testWho = viewer.seesEveryone ? undefined : viewer.ownPersonId ? [viewer.ownPersonId] : null;
  const absenceWeeks = resolveMoney(ANALYSIS_DEFAULTS).absenceWeeks;
  const absence = useAbsenceTest(baseModel && baselineDone && testWho !== null ? baseModel : null, run?.result.seed ?? 1, absenceWeeks, testWho ?? undefined);
  // While a newer run goes, the numbers on screen are the previous run's, so they are read with the model that run was made from
  // (a longer horizon would otherwise count more leave against the old utilisation).
  const ranModel = sim.model;
  const view = useMemo(() => {
    if (!ranModel || !run) return null;
    const fte = new Map(bundle.people.map((p) => [p.id, Number(p.fte)]));
    const rows = personRows(ranModel, run.result, fte);
    // The team card counts the whole team; a member sees only their own row in the table (B1 2b).
    return { health: clientHealthSummary(ranModel, run.result), rows: ownRowsOnly(viewer, rows, (r) => r.id), team: teamSummary(rows) };
  }, [ranModel, run, bundle.people, viewer]);
  const detailOf = useMemo(() => (id: string) => (ranModel && run ? personDetail(ranModel, run.result, bundle, id, today) : null), [ranModel, run, bundle, today]);
  const away = useMemo(() => {
    if (!baseModel || !absence) return null;
    const config = toRatingConfig(ANALYSIS_DEFAULTS, baseModel.hoursPerWeek);
    // A member sees only their own result, and no count of who else wasn't tested.
    return {
      rows: ownRowsOnly(viewer, absenceRows(baseModel, absence, config), (r) => r.id),
      untested: viewer.seesEveryone ? untestedSoleHolders(baseModel, absence).length : 0,
    };
  }, [baseModel, absence, viewer]);

  const picker = (
    <div className="flex justify-end">
      <HorizonPicker weeks={model?.horizonWeeks ?? bundle.workspace.settings.horizon_weeks} onChange={pickHorizon} />
    </div>
  );
  if (!model) {
    return <Card className="p-4 text-sm text-muted-foreground">This workspace&apos;s live process can&apos;t be simulated yet, so there is nothing to show here. Fix it on the map first.</Card>;
  }
  if (!view) {
    return (
      <>
        {picker}
        <p role="status" className="text-sm text-muted-foreground">
          {sim.status === "error" ? `The simulation failed: ${sim.error}` : "Running the simulation…"}
        </p>
      </>
    );
  }
  const { health, rows, team } = view;
  const notInRun = !viewer.seesEveryone && viewer.ownPersonId !== null && rows.length === 0 && bundle.people.some((p) => p.id === viewer.ownPersonId);
  return (
    <>
      {picker}
      <div className="grid gap-4 md:grid-cols-3" aria-busy={sim.status === "running"}>
        <ClientHealthCard health={health} />
        <BenchmarkCard score={health.score} benchmark={benchmark} settingsHref={settingsHref} />
        <TeamCard team={team} />
      </div>
      {health.groups.length > 0 && <ClientGroupsTable health={health} />}
      <HowBusy busy={sim.status === "running"} rows={rows} viewer={viewer} notInRun={notInRun} detailOf={detailOf} bundle={bundle} settingsHref={settingsHref} />
      <IfSomeoneIsAway away={away} viewer={viewer} runWeeks={baseModel?.horizonWeeks ?? 0} weeksAway={absenceWeeks} />
      {forecast && <ForecastPanel bundle={forecast.bundle ?? bundle} forecastHref={forecast.href} startDate={forecast.startDate} />}
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
    <Card data-team-card>
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

/** "—" for none, else "N days" (one decimal place, no trailing .0). */
const formatLeave = (days: number) => {
  if (days <= 0) return "—";
  const n = formatNumber(days, 1);
  return `${n} ${n === "1" ? "day" : "days"}`;
};

function HowBusy({
  busy,
  rows,
  viewer,
  notInRun,
  detailOf,
  bundle,
  settingsHref,
}: {
  /** A newer run is going: the numbers shown are the previous run's. */
  busy: boolean;
  rows: PersonBusy[];
  viewer: Viewer;
  notInRun: boolean;
  detailOf: (id: string) => PersonDetail | null;
  bundle: ProcessBundle;
  settingsHref: string | null;
}) {
  const onlyOwn = !viewer.seesEveryone;
  // One person's detail is open at a time.
  const [openId, setOpenId] = useState<string | null>(null);
  return (
    <Card className="gap-0 py-0" data-how-busy aria-busy={busy}>
      <div className="flex items-center px-4 pt-4 pb-2">
        <h2 className="font-heading text-base font-medium">How busy</h2>
        <Help
          label="How busy"
          description="The share of each person's working week that the simulation fills, on average. P90 is a bad month: it is that busy or worse one month in ten. Above 85% is too busy."
          example="Maya at 82% average and 97% P90 is fine most months but cannot cope with a bad one."
        />
      </div>
      {onlyOwn && rows.length === 0 && notInRun && (
        <p className="px-4 pb-4 text-sm text-muted-foreground" data-not-in-run>
          You aren&apos;t in this simulation: your record is inactive or starts later. Owners and editors can change that in Settings → People.
        </p>
      )}
      {onlyOwn && rows.length === 0 && !notInRun && (
        <p className="px-4 pb-4 text-sm text-muted-foreground" data-no-own-row>
          Your sign-in isn&apos;t linked to a person, so there&apos;s no row of yours to show. Ask an owner to link you on Settings → Access.
        </p>
      )}
      {(!onlyOwn || rows.length > 0) && (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Role</TableHead>
                <TableHead className="text-right">FTE</TableHead>
                <TableHead className="hidden md:table-cell">
                  <span className="flex items-center">
                    Client work
                    <Help
                      label="Client work, sales work and overtime"
                      description="Client work is time on existing clients: their servicing tasks and ongoing account work. Sales work is time on the sales pipeline. Overtime is extra time beyond the person's week, up to the workspace's overtime cap. All three are shares of their normal week."
                      example="Client work 55%, sales work 20%, overtime 4%: a full week with a little overtime."
                    />
                  </span>
                </TableHead>
                <TableHead className="hidden md:table-cell">Sales work</TableHead>
                <TableHead className="hidden md:table-cell">Overtime</TableHead>
                <TableHead className="hidden sm:table-cell">How busy</TableHead>
                <TableHead className="text-right">Average</TableHead>
                <TableHead className="hidden text-right md:table-cell">Leave</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((p) => {
                const detail = detailOf(p.id);
                const open = openId === p.id && detail !== null;
                return (
                  <Fragment key={p.id}>
                    <TableRow>
                      <TableCell className="font-medium">
                        {detail ? (
                          <button
                            type="button"
                            aria-expanded={open}
                            aria-controls={`person-detail-${p.id}`}
                            onClick={() => setOpenId(open ? null : p.id)}
                            className="rounded-sm text-left underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                          >
                            {p.name}
                          </button>
                        ) : (
                          p.name
                        )}
                      </TableCell>
                      <TableCell className="text-sm">{p.role}</TableCell>
                      <TableCell className="text-right tabular-nums">{p.fte === null ? "–" : formatNumber(p.fte, 1)}</TableCell>
                      <TableCell className="hidden tabular-nums md:table-cell">{formatPercent(p.clientWork)}</TableCell>
                      <TableCell className="hidden tabular-nums md:table-cell">{formatPercent(p.salesWork)}</TableCell>
                      <TableCell className="hidden tabular-nums md:table-cell">{formatPercent(p.overtime)}</TableCell>
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
                      <TableCell className="hidden text-right whitespace-nowrap tabular-nums md:table-cell">{formatLeave(p.leaveDays)}</TableCell>
                    </TableRow>
                    {open && (
                      <TableRow data-person-detail id={`person-detail-${p.id}`} className="bg-panel-2/40 hover:bg-panel-2/40">
                        <TableCell colSpan={9} className="whitespace-normal">
                          <PersonDetailBlock person={p} detail={detail} bundle={bundle} editHref={viewer.seesEveryone && settingsHref ? `${settingsHref}#people-heading` : null} />
                        </TableCell>
                      </TableRow>
                    )}
                  </Fragment>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </Card>
  );
}

/** What one person's row opens to: their record, the steps they can do and their leave. Capacity factors only if the gate lets any through, which it never does today (C6, #198). */
function PersonDetailBlock({ person, detail, bundle, editHref }: { person: PersonBusy; detail: PersonDetail; bundle: ProcessBundle; editHref: string | null }) {
  const factors = capacityFactorsShown(bundle.workspace.settings, []);
  const dates = [detail.startDate ? `Started ${formatDateRange(detail.startDate, detail.startDate)}` : null, detail.endDate ? `Leaves ${formatDateRange(detail.endDate, detail.endDate)}` : null].filter(Boolean);
  return (
    <div className="flex flex-col gap-3 py-2 text-sm">
      <p>
        <span className="font-medium">{detail.roles.join(", ") || "No role"}</span>
        <span className="text-muted-foreground">
          {" · "}
          {formatNumber(detail.hoursPerWeek, 1)} hours a week{detail.fte !== null ? ` (${formatNumber(detail.fte, 2)} FTE)` : ""}
          {dates.length ? ` · ${dates.join(" · ")}` : ""}
        </span>
      </p>
      <div>
        <span className="flex items-center text-xs font-medium text-fg-2">
          Can do
          <Help
            label="Can do"
            description="The steps this person is set up to do. With none listed, they can do every step of their roles."
            example="Freya does social setup and the social calendar, not the other social steps."
          />
        </span>
        <p>{detail.skills === null ? "Every step of their roles" : detail.skills.length === 0 ? "None of the live process's steps" : detail.skills.join(", ")}</p>
      </div>
      <p className="text-muted-foreground md:hidden">
        Client work {formatPercent(person.clientWork)} · Sales work {formatPercent(person.salesWork)} · Overtime {formatPercent(person.overtime)} · Leave {formatLeave(person.leaveDays)}
      </p>
      <div>
        <span className="text-xs font-medium text-fg-2">Leave</span>
        {detail.leave.length === 0 ? (
          <p>No leave booked</p>
        ) : (
          <ul>
            {detail.leave.map((l) => (
              <li key={`${l.start}-${l.end}`}>{formatDateRange(l.start, l.end)}</li>
            ))}
          </ul>
        )}
      </div>
      {factors.length > 0 && <div data-capacity-factors />}
      {editHref && (
        <Link href={editHref} className="w-fit underline underline-offset-2">
          Change in Settings
        </Link>
      )}
    </div>
  );
}

const weeksLabel = (r: AbsenceRow) =>
  !r.recovered ? `Not within ${formatNumber(r.weeksWatched, 0)} weeks` : r.weeks <= 0 ? "Under 1 week" : r.weeks === 1 ? "1 week" : `${formatNumber(r.weeks, 0)} weeks`;

/** Rule 8's results: how much work is lost, and for how long, when each person who is the only one for a step is away. Members see only their own. */
function IfSomeoneIsAway({
  away,
  viewer,
  runWeeks,
  weeksAway,
}: {
  away: { rows: AbsenceRow[]; untested: number } | null;
  viewer: Viewer;
  runWeeks: number;
  weeksAway: number;
}) {
  // A member linked to no one is tested on no one: their How busy table already says why.
  const unlinked = !viewer.seesEveryone && viewer.ownPersonId === null;
  return (
    <Card className="gap-0 py-0" data-absence>
      <div className="flex items-center px-4 pt-4 pb-1">
        <h2 className="font-heading text-base font-medium">If someone is away</h2>
        <Help
          label="If someone is away"
          description="For each person who is the only one able to do a step, the simulation runs again with them away for 2 weeks and compares. Work lost is the share of the work from then to the end of the period that doesn't get done. Weeks to catch up is how long their queues take to get back to normal once they're back. Great: under 5% lost and back within a week. Bad, not urgent: 5–20% lost, or 1–4 weeks. Operational risk: over 20% lost, not back within 4 weeks, or a client deadline missed."
          example="Maya away for 2 weeks: 12% of work lost and 3 weeks to catch up, so Bad, not urgent."
        />
      </div>
      <p className="px-4 pb-3 text-xs text-muted-foreground">
        Tested over the workspace&apos;s own {runWeeks}-week run, with each person away for {formatNumber(weeksAway, 0)} {weeksAway === 1 ? "week" : "weeks"}.
      </p>
      {unlinked ? (
        <p className="px-4 pb-4 text-sm text-muted-foreground">Nothing to show for you here.</p>
      ) : away === null ? (
        <p role="status" className="px-4 pb-4 text-sm text-muted-foreground">
          Testing what happens when each person is away…
        </p>
      ) : away.rows.length === 0 ? (
        <p className="px-4 pb-4 text-sm text-muted-foreground">
          {viewer.seesEveryone ? "Nobody is the only one who can do a step, so nobody is tested." : "You aren't the only one who can do any step, so you weren't tested."}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Role</TableHead>
                <TableHead className="hidden md:table-cell">Only they can do</TableHead>
                <TableHead className="text-right">Work lost</TableHead>
                <TableHead>Weeks to catch up</TableHead>
                <TableHead>Rating</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {away.rows.map((r) => (
                <TableRow key={r.id} title={`Only they can do: ${r.steps.join(", ")}`}>
                  <TableCell className="font-medium">{r.name}</TableCell>
                  <TableCell className="text-sm">{r.role}</TableCell>
                  <TableCell className="hidden text-sm md:table-cell">{r.steps.join(", ")}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatPercent(r.workLost)}</TableCell>
                  <TableCell className="whitespace-nowrap">{weeksLabel(r)}</TableCell>
                  <TableCell>
                    {r.rating && <RatingChip rating={r.rating} />}
                    {r.clientDeadlineMissed && <p className="mt-1 text-xs text-muted-foreground">A client deadline is missed.</p>}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      {viewer.seesEveryone && away !== null && away.untested > 0 && (
        <p className="px-4 pb-4 text-xs text-muted-foreground">
          Only the {ABSENCE_MAX_PEOPLE} people who are the only one for the most steps are tested; {away.untested} more aren&apos;t.
        </p>
      )}
    </Card>
  );
}
