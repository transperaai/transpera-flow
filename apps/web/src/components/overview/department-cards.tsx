"use client";

// The Overview's money answer and the figures behind its people widgets (capacity build P6; redesigned to the Overview options WB1 and DS1).
// Figures that come from Set up (clients, MRR, MRR ÷ people, DLER) show at once; the ones that need a simulation (who is over their
// utilisation threshold, room for more clients, busiest people, where the time goes) come from the Capacity page's "Today" run, in the
// same worker and cache (lib/capacity/runs.ts), so opening the Overview after Capacity costs nothing. Never run on the server.
//
// - `useDepartmentFigures`: the one Today run and every department's figures, for the Money and People sections alike.
// - `WholeBusinessHero` (WB1): three hero numbers, only DLER coloured, against its goal.
// - `DepartmentTiles` (DS1): the departments side by side in one section, a figure for each, its status on a coloured edge.

import Link from "next/link";
import { useMemo, type ReactNode } from "react";
import {
  busyShares,
  departmentCeiling,
  departmentRetainers,
  departmentTime,
  dler,
  DLER_GOAL,
  limitedBy,
  modelProcessOfStep,
  perEmployee,
  roomPulse,
  serviceLines,
  todayModel,
  wholeBusiness,
  type CapacitySetup,
  type DepartmentCeiling,
  type DepartmentTimePart,
  type DlerRow,
  type PerEmployee,
  type PersonBusy,
  type RoomPulse,
} from "@transpera-flow/db";
import type { EngineModel } from "@transpera-flow/engine";
import { HeroKpi, Section, type KpiStatus } from "@/components/capacity/widgets";
import { SectionCard } from "@/components/page-kit";
import { Skeleton } from "@/components/ui/skeleton";
import { formatNumber, formatWholeCurrency } from "@/lib/format";
import { useCapacityRuns } from "@/lib/sim/use-capacity-runs";
import { cn } from "@/lib/utils";
import { PanelActions } from "./panel-how";

const f0 = (v: number) => formatNumber(v, 0);
const f1 = (v: number) => formatNumber(v, 1);

/** What the busy line is: "Busy above 85%", or the range when roles differ: "Busy above 80–85% (each role's utilisation threshold)". Undefined with nobody in the department. */
export function busyLineNote(lines: readonly number[]): string | undefined {
  if (!lines.length) return undefined;
  const pct = (v: number) => Math.round(v * 100);
  const low = pct(Math.min(...lines));
  const high = pct(Math.max(...lines));
  return low === high ? `Busy above ${low}%` : `Busy above ${low}–${high}% (each role's utilisation threshold)`;
}

/** The Capacity page's DLER rule: at or above the goal is good, below it is a warning. Null when there is no ratio to judge (hidden or no salaries). */
export function dlerStatus(row: Pick<DlerRow, "ratio" | "hidden">): KpiStatus | null {
  if (row.hidden || row.ratio === null) return null;
  return row.ratio >= DLER_GOAL ? { tone: "good", words: `At or above the ${f1(DLER_GOAL)} goal` } : { tone: "warn", words: `Below the ${f1(DLER_GOAL)} goal` };
}

// ---------------------------------------------------------------------------------------------------------------------
// The figures
// ---------------------------------------------------------------------------------------------------------------------

/** A person from the Today run, with the name of their department (null for someone outside any). */
export type BusyPerson = PersonBusy & { departmentName: string | null };

export interface DepartmentTimeSplit {
  total: number;
  parts: DepartmentTimePart[];
}

export interface DepartmentFigure {
  id: string;
  name: string;
  per: PerEmployee;
  dler: DlerRow;
  /** Clients who also take another department's services, and what that department is called. */
  alsoTake: { count: number; other: string };
  /** From the Today run; null until it is in (or when it can't run). */
  run: {
    people: BusyPerson[];
    over: number;
    lineNote: string | undefined;
    ceiling: DepartmentCeiling;
    pulse: RoomPulse;
    time: { process: DepartmentTimeSplit; purpose: DepartmentTimeSplit };
  } | null;
}

export interface DepartmentFigures {
  /** The departments with at least one active tier service; none means Set up isn't far enough along (the start checklist). */
  rows: DepartmentFigure[];
  /** Everyone in the Today run, busiest first; null until it is in. */
  people: BusyPerson[] | null;
  /** The run is under way. */
  running: boolean;
  /** Why the run's figures can't be shown (the model can't be built, or the run failed); null when they can. */
  failure: { kind: "model" | "run"; message: string } | null;
}

/**
 * The Today run (the Capacity page's, through its cache) and every department's figures from it. `setup` null (no Set up data, as on the
 * demo): nothing runs and there are no rows.
 */
export function useDepartmentFigures({
  setup,
  model,
  modelError = null,
  purposeNames = {},
  processOfStep,
}: {
  setup: CapacitySetup | null;
  /** The workspace's model as the Capacity page builds it (`capacityBaseModel`); null when it can't be built (`modelError` says why). */
  model: EngineModel | null;
  modelError?: string | null;
  /** Purpose key → the words the workspace uses. */
  purposeNames?: Record<string, string>;
  /** Step id → the name of the process it is in, for the time by process. Left out: worked out from the model. */
  processOfStep?: ReadonlyMap<string, string>;
}): DepartmentFigures {
  const departments = useMemo(() => (setup ? setup.departments.filter((d) => setup.services.some((s) => s.active && s.department_id === d.id && s.tier_id)) : []), [setup]);
  const today = useMemo(() => (model && departments.length ? todayModel(model) : null), [model, departments.length]);
  const runs = useCapacityRuns(today, null, null);
  const result = runs.today.status === "done" ? runs.today.run.result : null;

  const base = useMemo(() => {
    if (!setup) return [];
    const lines = serviceLines(setup);
    const ratios = dler(setup).departments;
    return departments.map((d) => {
      const others = setup.departments.filter((x) => x.id !== d.id);
      return {
        id: d.id,
        name: d.name,
        per: perEmployee(setup, d.id),
        dler: ratios.find((x) => x.departmentId === d.id)!,
        alsoTake: { count: lines.both, other: others.length === 1 ? others[0]!.name : "another department" },
      };
    });
  }, [setup, departments]);

  const fromRun = useMemo(() => {
    if (!setup || !model || !result) return null;
    const nameOf = new Map(setup.departments.map((d) => [d.id, d.name]));
    const people: BusyPerson[] = busyShares(setup, model, result)
      .people.map((p) => ({ ...p, departmentName: p.departmentId ? (nameOf.get(p.departmentId) ?? null) : null }))
      .sort((a, b) => b.busy - a.busy);
    const steps = processOfStep ?? modelProcessOfStep(model);
    const byDepartment = new Map(
      departments.map((d) => {
        const mine = people.filter((p) => p.departmentId === d.id);
        const ceiling = departmentCeiling(setup, model, result, d.id);
        return [
          d.id,
          {
            people: mine,
            over: mine.filter((p) => p.over).length,
            lineNote: busyLineNote(mine.map((p) => p.line)),
            ceiling,
            pulse: roomPulse(ceiling.room, ceiling.clients),
            time: {
              process: departmentTime(setup, model, result, d.id, purposeNames, { processOfStep: steps }),
              purpose: departmentTime(setup, model, result, d.id, purposeNames),
            },
          },
        ] as const;
      }),
    );
    return { people, byDepartment };
  }, [setup, model, result, departments, purposeNames, processOfStep]);

  const failure: DepartmentFigures["failure"] = modelError ? { kind: "model", message: modelError } : runs.today.status === "error" ? { kind: "run", message: runs.today.error } : null;
  return {
    rows: base.map((b) => ({ ...b, run: fromRun?.byDepartment.get(b.id) ?? null })),
    people: fromRun?.people ?? null,
    running: !failure && !fromRun && departments.length > 0,
    failure,
  };
}

/** Why the simulated figures are missing, said once at the top of the Money section. */
export function DepartmentAlerts({ failure }: { failure: DepartmentFigures["failure"] }) {
  if (!failure) return null;
  return failure.kind === "model" ? (
    <div role="alert" data-model-error className="rounded-token border border-crit bg-crit-soft p-3 text-sm">
      Who is at their utilisation threshold and who has room can&apos;t be worked out yet: {failure.message}
    </div>
  ) : (
    <div role="alert" data-run-error className="rounded-token border border-crit bg-crit-soft p-3 text-sm">
      The simulation could not run: {failure.message}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Start checklist (no tier services yet)
// ---------------------------------------------------------------------------------------------------------------------

export function StartChecklist({ setup, base }: { setup: CapacitySetup; base: string }) {
  const items = [
    { label: "Add roles", href: `${base}/settings#roles-heading`, done: setup.roles.length > 0 },
    { label: "Add people", href: `${base}/settings#people-heading`, done: setup.people.length > 0 },
    { label: "Add tiers and services", href: `${base}/settings#tiers-clients`, done: setup.services.some((s) => s.active && s.tier_id) },
    {
      label: "Enter how many clients are in each tier",
      href: `${base}/settings#clients-heading`,
      done: setup.tiers.some((t) => setup.services.some((s) => s.tier_id === t.id)) && setup.clients.length + setup.portfolio.length > 0,
    },
  ];
  return (
    <Section
      title="No tiers and services are set up yet."
      data-no-tiers
      data-setup-checklist
      description="Clients, MRR and DLER by department are worked out from each department's tiers, the clients in them and the people who look after them. To start:"
    >
      <ol className="flex flex-col gap-1 text-sm">
        {items.map((i) => (
          <li key={i.label} className="flex items-center gap-2" data-done={i.done}>
            <span aria-hidden className={i.done ? "text-good" : "text-muted-foreground"}>
              {i.done ? "✓" : "○"}
            </span>
            <Link href={i.href} className="font-medium text-accent hover:underline">
              {i.label} →
            </Link>
            {i.done && <span className="sr-only">(done)</span>}
          </li>
        ))}
      </ol>
    </Section>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// WB1: the whole business
// ---------------------------------------------------------------------------------------------------------------------

/** DLER on a scale from 0, the bar in the status colour and a tick at the goal. */
export function DlerScale({ ratio }: { ratio: number }) {
  const W = 220;
  const top = Math.max(6, ratio * 1.15, DLER_GOAL * 1.25);
  const x = (v: number) => 4 + (Math.max(0, Math.min(v, top)) / top) * (W - 8);
  const good = ratio >= DLER_GOAL;
  const label = `DLER ${f1(ratio)} against a goal of ${f1(DLER_GOAL)}`;
  return (
    <svg viewBox={`0 0 ${W} 30`} className="mt-1 block h-auto w-full max-w-[220px]" role="img" aria-label={label} data-dler-scale>
      <title>{label}</title>
      <rect x={4} y={8} width={W - 8} height={8} rx={4} className="fill-panel-2" />
      <rect x={4} y={8} width={Math.max(0, x(ratio) - 4)} height={8} rx={4} className={good ? "fill-good" : "fill-warn"} />
      <line x1={x(DLER_GOAL)} x2={x(DLER_GOAL)} y1={3} y2={21} className="stroke-fg" strokeWidth={2} />
      <text x={x(DLER_GOAL)} y={29} textAnchor="middle" className="fill-fg-2 text-[9px]">
        goal {f1(DLER_GOAL)}
      </text>
    </svg>
  );
}

function SalariesMissing({ base }: { base: string }) {
  return (
    <span data-salaries-missing>
      Salaries not entered.{" "}
      <Link href={`${base}/settings#people-roles`} className="whitespace-nowrap font-medium text-accent hover:underline">
        Enter them →
      </Link>
    </span>
  );
}

/**
 * WB1: clients, MRR ÷ N people and DLER as three hero numbers. Only DLER has a goal, so only DLER is coloured. `extra`: more tiles in the
 * same row (the Overview's people over their threshold and open issues), so the row is one strip of equal tiles.
 */
export function WholeBusinessHero({ setup, base, extra }: { setup: CapacitySetup; base: string; extra?: ReactNode }) {
  const w = useMemo(() => wholeBusiness(setup), [setup]);
  const mrr = useMemo(() => setup.departments.reduce((a, d) => a + departmentRetainers(setup, d.id), 0), [setup]);
  const money = (v: number) => formatWholeCurrency(v, setup.currency);
  const status = dlerStatus(w.dler);
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-[repeat(auto-fit,minmax(10rem,1fr))]" data-whole-business>
      <HeroKpi label="Clients" value={f0(w.unique)} sub={`${w.byDepartment.map((d) => `${f0(d.clients)} ${d.name}`).join(" + ")} − ${f0(w.both)} taking both`} />
      <HeroKpi label={`MRR ÷ ${w.employees} people`} value={w.revenuePerEmployee === null ? "—" : money(w.revenuePerEmployee)} sub={`a month, from ${money(mrr)} MRR`} />
      <HeroKpi
        label="DLER"
        value={w.dler.hidden ? "Hidden" : w.dler.ratio === null ? "—" : f1(w.dler.ratio)}
        status={status ?? undefined}
        sub={
          w.dler.hidden ? (
            "Pay is hidden for your role"
          ) : w.dler.ratio === null ? (
            <SalariesMissing base={base} />
          ) : (
            <>
              <DlerScale ratio={w.dler.ratio} />
              <span className="block">
                MRR ÷ salaries, the average of {w.dler.people} {w.dler.people === 1 ? "person's" : "people's"} DLER
              </span>
            </>
          )
        }
      />
      {extra}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// DS1: the departments side by side
// ---------------------------------------------------------------------------------------------------------------------

type TileTone = "good" | "warn" | "bad" | null;
const TILE_EDGE: Record<Exclude<TileTone, null>, string> = { good: "border-l-good", warn: "border-l-warn", bad: "border-l-crit" };

/** One figure of a department: a plain label and number, its status on the left edge (the words in `sub` carry it, not the colour). */
function Tile({ label, value, sub, tone = null, className }: { label: string; value: ReactNode; sub?: ReactNode; tone?: TileTone; className?: string }) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-0.5 border-l-2 py-0.5 pl-3", tone ? TILE_EDGE[tone] : "border-l-line", className)} data-kpi data-tone={tone ?? "none"}>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-lg font-semibold tabular-nums">{value}</div>
      {sub && <div className="text-xs text-muted-foreground">{sub}</div>}
    </div>
  );
}

/** The first sentence of the department tiles: who is below the DLER goal, and how many people are over their utilisation threshold. */
export function departmentsAnswer(rows: readonly Pick<DepartmentFigure, "name" | "dler" | "run">[]): string {
  const judged = rows.filter((r) => dlerStatus(r.dler));
  const below = judged.filter((r) => dlerStatus(r.dler)!.tone === "warn").map((r) => r.name);
  const goal = f1(DLER_GOAL);
  const money = !judged.length
    ? ""
    : below.length === 0
      ? `${judged.length === 1 ? judged[0]!.name + " is" : "Every department is"} at or above the ${goal} DLER goal.`
      : below.length === judged.length && judged.length > 1
        ? `Every department is below the ${goal} DLER goal.`
        : `${below.join(" and ")} ${below.length === 1 ? "is" : "are"} below the ${goal} DLER goal.`;
  if (rows.some((r) => !r.run)) return money || "The departments' figures.";
  const over = rows.reduce((a, r) => a + r.run!.over, 0);
  const people = over === 0 ? "Nobody is over their utilisation threshold." : `${over} ${over === 1 ? "person is" : "people are"} over their utilisation threshold.`;
  return [money, people].filter(Boolean).join(" ");
}

const DEPARTMENTS_HOW = {
  works: (
    <>
      Clients and MRR come from Set up; MRR ÷ people divides each department&apos;s MRR by everyone in it (contractors and leadership out). DLER is MRR ÷
      salaries, the average of each client-facing person&apos;s, against a goal of {f1(DLER_GOAL)}. Who is over their utilisation threshold and the room
      for more clients come from a simulation of today&apos;s clients; the room is a rough guide from the simulation, not a promise, and names what fills
      first.
    </>
  ),
  tells: "Which department needs you first: a DLER below the goal, people over their utilisation threshold, or little room for more clients.",
};

export function DepartmentTiles({ figures, base, currency, className }: { figures: DepartmentFigures; base: string; currency: string; className?: string }) {
  const money = (v: number) => formatWholeCurrency(v, currency);
  const pending = (what: string) => (figures.failure ? "—" : <Skeleton className="mt-1 h-6 w-14" aria-busy="true" aria-label={`${what} is being worked out`} />);
  return (
    <SectionCard
      id="departments"
      section="departments"
      level={2}
      title="Departments"
      className={className}
      description={departmentsAnswer(figures.rows)}
      action={
        <PanelActions how={DEPARTMENTS_HOW}>
          <Link href={`${base}/capacity`} className="text-xs font-medium text-accent hover:underline" data-capacity-link>
            Capacity →
          </Link>
        </PanelActions>
      }
    >
      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(20rem,100%),1fr))] gap-x-10 gap-y-6" data-tier="departments">
        {figures.rows.map((d) => {
          const status = dlerStatus(d.dler);
          const run = d.run;
          return (
            <div key={d.id} className="flex min-w-0 flex-col gap-2" data-department={d.name}>
              <h4 className="border-b border-line pb-1.5 text-sm font-semibold">{d.name}</h4>
              <div className="grid grid-cols-2 gap-x-4 gap-y-3">
                <Tile label="Clients" value={f0(d.per.clients)} sub={`${f0(d.alsoTake.count)} also take ${d.alsoTake.other}`} />
                <Tile label={`MRR ÷ ${d.per.employees} people`} value={d.per.revenuePerEmployee === null ? "—" : money(d.per.revenuePerEmployee)} sub="a month" />
                <Tile
                  label="DLER"
                  tone={status ? (status.tone === "good" ? "good" : "warn") : null}
                  value={d.dler.hidden ? "Hidden" : d.dler.ratio === null ? "—" : f1(d.dler.ratio)}
                  sub={d.dler.hidden ? "Pay is hidden for your role" : d.dler.ratio === null ? <SalariesMissing base={base} /> : status!.words}
                />
                <Tile
                  label="Over their utilisation threshold"
                  tone={run ? (run.over > 0 ? "bad" : "good") : null}
                  value={run ? `${f0(run.over)} of ${f0(run.people.length)}` : pending("Over their utilisation threshold")}
                  sub={run?.lineNote}
                />
                <Tile
                  className="col-span-2"
                  label="Room for more clients"
                  tone={run ? (run.pulse.tone === "ok" ? "good" : run.pulse.tone) : null}
                  value={
                    run ? (
                      <span className="text-lg" data-room-status>
                        {run.pulse.status}
                      </span>
                    ) : (
                      pending("Room for more clients")
                    )
                  }
                  sub={run ? [run.pulse.words, `fills first: ${limitedBy(run.ceiling.limit)}`].filter(Boolean).join(" · ") : undefined}
                />
              </div>
            </div>
          );
        })}
      </div>
    </SectionCard>
  );
}
