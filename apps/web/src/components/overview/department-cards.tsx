"use client";

// The Overview's department cards (capacity build P6; the prototype's Overview, `pageOverview`): one card per department with its
// headline figures, its busiest people and where its time goes, then the whole business. Figures that come from Set up (clients, per
// employee, DLER) show at once; the ones that need a simulation (who is at their line, room for more clients, busiest people, where the
// time goes) come from the Capacity page's "Today" run, in the same worker and cache (lib/capacity/runs.ts), so opening the Overview after
// Capacity costs nothing. Never run on the server.

import Link from "next/link";
import { useMemo } from "react";
import {
  busyShares,
  DLER_GOAL,
  departmentCeiling,
  departmentTime,
  dler,
  dlerSalariesMissing,
  perEmployee,
  serviceLines,
  todayModel,
  wholeBusiness,
  type CapacitySetup,
  type DlerRow,
} from "@transpera-flow/db";
import type { EngineModel, SimulationResult } from "@transpera-flow/engine";
import { BusyBar, Kpi, Section } from "@/components/capacity/widgets";
import { Skeleton } from "@/components/ui/skeleton";
import { formatNumber, formatPercent, formatWholeCurrency } from "@/lib/format";
import { useCapacityRuns } from "@/lib/sim/use-capacity-runs";

const f0 = (v: number) => formatNumber(v, 0);
const f1 = (v: number) => formatNumber(v, 1);

export interface DepartmentCardsProps {
  setup: CapacitySetup;
  /** The workspace's model as the Capacity page builds it (`capacityBaseModel`); null when it can't be built (`modelError` says why). */
  model: EngineModel | null;
  modelError?: string | null;
  /** Purpose key → the words the workspace uses. */
  purposeNames?: Record<string, string>;
  /** `/w/<slug>`. */
  base: string;
}

export function DepartmentCards({ setup, model, modelError = null, purposeNames = {}, base }: DepartmentCardsProps) {
  const departments = useMemo(() => setup.departments.filter((d) => setup.services.some((s) => s.active && s.department_id === d.id && s.tier_id)), [setup]);
  const today = useMemo(() => (model && departments.length ? todayModel(model) : null), [model, departments.length]);
  const runs = useCapacityRuns(today, null, null);

  if (!departments.length) return <StartChecklist setup={setup} base={base} />;

  const result = runs.today.status === "done" ? runs.today.run.result : null;
  return (
    <section className="flex min-w-0 flex-col gap-4" data-tier="departments" aria-labelledby="tier-departments">
      <div className="flex flex-col gap-0.5">
        <h2 id="tier-departments" className="font-heading text-lg leading-snug font-semibold tracking-tight">
          Capacity by department
        </h2>
        <p className="text-sm text-muted-foreground">The capacity headline for each department. Each card opens the Capacity page with the detail.</p>
      </div>
      {modelError && (
        <div role="alert" data-model-error className="rounded-token border border-crit bg-crit-soft p-3 text-sm">
          Who is at their line and who has room can&apos;t be worked out yet: {modelError}
        </div>
      )}
      {runs.today.status === "error" && (
        <div role="alert" data-run-error className="rounded-token border border-crit bg-crit-soft p-3 text-sm">
          The simulation could not run: {runs.today.error}
        </div>
      )}
      {departments.map((d) => (
        <DepartmentCard key={d.id} setup={setup} departmentId={d.id} name={d.name} base={base} model={model} result={result} failed={!!modelError || runs.today.status === "error"} purposeNames={purposeNames} />
      ))}
      <WholeBusinessRow setup={setup} base={base} />
    </section>
  );
}

// ---------------------------------------------------------------------------------------------------------------------

function StartChecklist({ setup, base }: { setup: CapacitySetup; base: string }) {
  const items = [
    { label: "Add roles", href: `${base}/setup/people#roles-heading`, done: setup.roles.length > 0 },
    { label: "Add people", href: `${base}/setup/people#people-heading`, done: setup.people.length > 0 },
    { label: "Add tiers and services", href: `${base}/setup/clients`, done: setup.services.some((s) => s.active && s.tier_id) },
    { label: "Enter how many clients are in each tier", href: `${base}/setup/clients#clients-heading`, done: setup.tiers.some((t) => setup.services.some((s) => s.tier_id === t.id)) && setup.clients.length + setup.portfolio.length > 0 },
  ];
  return (
    <section data-no-tiers data-setup-checklist className="flex flex-col gap-2 rounded-token border border-dashed border-line p-5 text-sm">
      <h2 className="font-heading text-base font-semibold">No tiers and services are set up yet.</h2>
      <p className="text-muted-foreground">Capacity by department is worked out from each department&apos;s tiers, the clients in them and the people who look after them. To start:</p>
      <ol className="flex flex-col gap-1">
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
    </section>
  );
}

/** DLER as a card: the ratio and what it is made of; "Salaries not entered" with a link when pay is missing; "Hidden" when the viewer can't see pay. */
function DlerKpi({ label, row, missing, setup, base, goalNote = true }: { label: string; row: DlerRow; missing: boolean; setup: CapacitySetup; base: string; goalNote?: boolean }) {
  const money = (v: number) => formatWholeCurrency(v, setup.currency);
  if (row.salaries === null) return <Kpi label={label} value="Hidden" sub="Pay is hidden for your role" />;
  if (missing || !(row.salaries > 0)) {
    return (
      <Kpi
        label={label}
        value="—"
        sub={
          <span data-salaries-missing>
            Salaries not entered.{" "}
            <Link href={`${base}/setup/people`} className="whitespace-nowrap font-medium text-accent hover:underline">
              Enter them →
            </Link>
          </span>
        }
      />
    );
  }
  return <Kpi label={label} value={row.ratio === null ? "—" : f1(row.ratio)} sub={`${money(row.retainers)} ÷ ${money(row.salaries)}${goalNote ? ` · goal ${DLER_GOAL}` : ""}`} />;
}

function DepartmentCard({
  setup,
  departmentId,
  name,
  base,
  model,
  result,
  failed,
  purposeNames,
}: {
  setup: CapacitySetup;
  departmentId: string;
  name: string;
  base: string;
  model: EngineModel | null;
  result: SimulationResult | null;
  failed: boolean;
  purposeNames: Record<string, string>;
}) {
  const per = useMemo(() => perEmployee(setup, departmentId), [setup, departmentId]);
  const lines = useMemo(() => serviceLines(setup), [setup]);
  const row = useMemo(() => dler(setup).departments.find((x) => x.departmentId === departmentId)!, [setup, departmentId]);
  const missingSalaries = useMemo(() => dlerSalariesMissing(setup, departmentId), [setup, departmentId]);
  const others = setup.departments.filter((d) => d.id !== departmentId);
  const money = (v: number) => formatWholeCurrency(v, setup.currency);

  const figures = useMemo(() => {
    if (!model || !result) return null;
    const people = busyShares(setup, model, result).people.filter((p) => p.departmentId === departmentId);
    const ordered = [...people].sort((a, b) => b.busy - a.busy);
    return {
      busiest: ordered.slice(0, 6),
      over: ordered.filter((p) => p.over),
      ceiling: departmentCeiling(setup, model, result, departmentId),
      time: departmentTime(setup, model, result, departmentId, purposeNames),
    };
  }, [setup, model, result, departmentId, purposeNames]);

  const pending = (value: string) => (failed ? "—" : <Skeleton className="mt-1 h-6 w-12" aria-busy="true" aria-label={`${value} is being worked out`} />);
  return (
    <Section
      title={name}
      data-department={name}
      aside={
        <Link href={`${base}/capacity`} className="text-xs font-medium text-accent hover:underline" data-capacity-link>
          Capacity →
        </Link>
      }
    >
      <div className="grid grid-cols-[repeat(auto-fit,minmax(10.5rem,1fr))] gap-2.5" data-kpis>
        <Kpi label="Clients" value={f0(per.clients)} sub={`${f0(lines.both)} also take ${others.length === 1 ? others[0]!.name : "another department"}`} />
        <Kpi label="Clients per employee" value={per.clientsPerEmployee === null ? "—" : f1(per.clientsPerEmployee)} sub={`${f0(per.clients)} clients ÷ ${per.employees} people in the department`} />
        <Kpi label="Revenue per employee" value={per.revenuePerEmployee === null ? "—" : money(per.revenuePerEmployee)} sub={`a month, retainers ÷ ${per.employees} people`} />
        <DlerKpi label="DLER" row={row} missing={missingSalaries} setup={setup} base={base} />
        <Kpi
          label="At or over their line"
          value={figures ? f0(figures.over.length) : pending("At or over their line")}
          sub={figures ? `${figures.over.slice(0, 3).map((p) => p.name.split(" ")[0]).join(", ") || "Nobody"}${figures.over.length > 3 ? "…" : ""}` : undefined}
        />
        <Kpi
          label="Room for more clients"
          value={figures ? f0(figures.ceiling.room) : pending("Room for more clients")}
          sub={figures ? `Limit: ${figures.ceiling.limit.toLowerCase()}` : undefined}
        />
      </div>
      {figures ? (
        <div className="grid gap-4 md:grid-cols-2">
          <div data-busiest>
            <h3 className="mb-1.5 text-sm font-semibold">Busiest people</h3>
            {figures.busiest.length ? (
              <table className="w-full text-sm">
                <tbody>
                  {figures.busiest.map((p) => (
                    <tr key={p.id} className="border-b border-line/60 last:border-0">
                      <td className="py-1.5 pr-3">
                        {p.name}
                        <div className="text-xs text-muted-foreground">{p.roleName}</div>
                      </td>
                      <td className="w-1/2 py-1.5">
                        <BusyBar busy={p.busy} line={p.line} label={p.name} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="text-sm text-muted-foreground">Nobody works in this department yet.</p>
            )}
          </div>
          <div data-time>
            <h3 className="mb-1.5 text-sm font-semibold">
              Where the time goes <span className="text-xs font-normal text-muted-foreground tabular-nums">{f0(figures.time.total)} h a month</span>
            </h3>
            {figures.time.parts.length ? (
              <table className="w-full text-sm">
                <tbody>
                  {figures.time.parts.map((t) => (
                    <tr key={t.name} className="border-b border-line/60 last:border-0" data-purpose={t.name}>
                      <td className="py-1.5 pr-3">{t.name}</td>
                      <td className="w-[30%] py-1.5 pr-3">
                        <div className="h-2 rounded-full bg-panel-2" role="presentation">
                          <i className="block h-full rounded-full bg-accent" style={{ width: `${(t.hours * 100) / figures.time.parts[0]!.hours}%` }} />
                        </div>
                      </td>
                      <td className="whitespace-nowrap py-1.5 pr-3 text-right tabular-nums">{f0(t.hours)} h</td>
                      <td className="whitespace-nowrap py-1.5 text-right tabular-nums text-muted-foreground">{formatPercent(t.share)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="text-sm text-muted-foreground">No hours in the run.</p>
            )}
          </div>
        </div>
      ) : failed ? null : (
        <div role="status" aria-busy="true" data-running className="flex flex-col gap-2">
          <p className="text-sm text-muted-foreground">Working out who is busiest and where the time goes, from a simulation of today&apos;s clients…</p>
          <Skeleton className="h-24 w-full" />
        </div>
      )}
    </Section>
  );
}

function WholeBusinessRow({ setup, base }: { setup: CapacitySetup; base: string }) {
  const w = useMemo(() => wholeBusiness(setup), [setup]);
  const missing = useMemo(() => dlerSalariesMissing(setup, null), [setup]);
  const money = (v: number) => formatWholeCurrency(v, setup.currency);
  return (
    <Section title="Whole business" data-whole-business>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(10.5rem,1fr))] gap-2.5">
        <Kpi label="Clients" value={f0(w.unique)} sub={`${w.byDepartment.map((d) => `${f0(d.clients)} ${d.name}`).join(" + ")} − ${f0(w.both)} taking both`} />
        <Kpi label="Revenue per employee" value={w.revenuePerEmployee === null ? "—" : money(w.revenuePerEmployee)} sub={`a month, ${w.employees} people`} />
        <DlerKpi label="DLER" row={w.dler} missing={missing} setup={setup} base={base} />
      </div>
    </Section>
  );
}
