"use client";

// The Capacity page (capacity build P5; the prototype's Capacity screen, docs/prototypes/client-capacity-app.PROTOTYPE.html `pageCapacity`).
// Every widget leads with its answer in a sentence, then the picture, with "How this works" folded away. The numbers come from
// a simulation of Today in the worker and the pure figures in @transpera-flow/db (capacity-figures.ts).

import Link from "next/link";
import { useMemo, useState } from "react";
import {
  AT_RISK_MARGIN,
  atRisk,
  busyShares,
  departmentCeiling,
  DLER_GOAL,
  dler,
  leavers,
  limitedBy,
  missingForCapacity,
  personMax,
  roomPulse,
  serviceLines,
  timeToServe,
  todayModel,
  type CapacitySetup,
  type DepartmentCeiling,
  type MissingItem,
  type PersonBusy,
  type PurposeCategory,
} from "@transpera-flow/db";
import { capacityProblems, type EngineModel, type SimulationResult } from "@transpera-flow/engine";
import { namedPurposeParts, purposeColours, type PurposePart } from "@/lib/capacity/purposes";
import { MetaLine, PageHeader } from "@/components/page-kit";
import { buttonVariants } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { formatNumber, formatPercent, formatWholeCurrency } from "@/lib/format";
import { useCapacityRuns } from "@/lib/sim/use-capacity-runs";
import { cn } from "@/lib/utils";
import { PeoplePicker, type PickerGroup } from "./people-picker";
import { PanelHow } from "@/components/overview/panel-how";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ColourLegend, Dumbbell, KpiStrip, KpiTile, RoomBar, Section, StackBar, ThresholdBar, TONE_TEXT, type KpiStatus, type Tone } from "./widgets";

export interface CapacityViewProps {
  setup: CapacitySetup;
  /** The workspace's model; null when it can't be built (`modelError` says why). */
  model: EngineModel | null;
  modelError?: string | null;
  /** `/w/<slug>`. */
  base: string;
  /** Step id → the process it belongs to, for the links to steps (D32). */
  stepProcess: Record<string, string>;
  /** The workspace's purpose categories, to name the "time to serve" bars' segments; the default list when absent. */
  purposes?: readonly PurposeCategory[];
}

const f0 = (v: number) => formatNumber(v, 0);
const f1 = (v: number) => formatNumber(v, 1);

/** Where an engine problem or a missing item is fixed. */
function fixHref(base: string, where: string): string {
  if (where.startsWith("people") || where.startsWith("roles")) return `${base}/settings#people-roles`;
  if (where.startsWith("steps") || where.startsWith("changes")) return `${base}/processes`;
  return `${base}/settings#tiers-clients`;
}
const missingHref = (base: string, m: MissingItem): string => (m.kind === "tier_deliverable" || m.kind === "tier_total_over" || m.kind === "tier_total_unassigned" ? `${base}/settings#tiers-clients` : `${base}/settings#people-roles`);

export const CAPACITY_DESCRIPTION = 'Are we at capacity, who has room, and how many more clients fit. "Today" is the current book of clients with nobody arriving or leaving.';

/** The Capacity page's header: the title, one sentence saying what the page answers, and the way on to the Sandbox. */
export function CapacityHeader({ base }: { base?: string }) {
  return (
    <PageHeader
      label="Capacity"
      eyebrow={<span className="text-2xs font-semibold tracking-wider text-muted-foreground uppercase">Company</span>}
      title="Capacity"
      meta={
        <MetaLine>
          <span>{CAPACITY_DESCRIPTION}</span>
        </MetaLine>
      }
      actionsLabel="Capacity actions"
      actions={
        base ? (
          <Link href={`${base}/sandbox`} className={buttonVariants({ variant: "outline", size: "sm" })} data-sandbox-link>
            Try changes in the Sandbox
          </Link>
        ) : undefined
      }
    />
  );
}

export function CapacityView(props: CapacityViewProps) {
  const { setup, model, base } = props;
  const hasTiers = setup.services.some((s) => s.active && s.department_id && s.tier_id);
  const today = useMemo(() => (model && hasTiers ? todayModel(model) : null), [model, hasTiers]);
  const runs = useCapacityRuns(today, null, null);
  const problems = useMemo(() => (model ? capacityProblems(model) : []), [model]);
  const missing = useMemo(() => missingForCapacity(setup, { salariesVisible: !setup.payHidden }), [setup]);

  if (!hasTiers) {
    return (
      <div className="flex min-w-0 flex-col gap-6">
        <CapacityHeader base={base} />
        <Section title="No tiers and services are set up yet." data-no-tiers description="Capacity is worked out from each department's tiers, the clients in them and the people who look after them.">
          <div>
            <Link href={`${base}/settings#tiers-clients`} className={buttonVariants({ variant: "outline", size: "sm" })}>
              Set up tiers and clients in Settings →
            </Link>
          </div>
        </Section>
      </div>
    );
  }

  const todayRun = runs.today.status === "done" ? runs.today.run.result : null;
  return (
    <div
      className="flex min-w-0 flex-col gap-6"
      data-capacity
      data-today-ms={runs.today.status === "done" ? Math.round(runs.today.run.durationMs) : undefined}
    >
      <CapacityHeader base={base} />
      {props.modelError && (
        <div data-model-error role="alert" className="rounded-md border border-crit bg-crit-soft p-3 text-sm">
          {props.modelError}
        </div>
      )}
      {/* A shared role's rate and unit only turned its hours into its own unit; nothing on this page uses them, so they are not asked for here. */}
      <Attention base={base} problems={problems} missing={missing.filter((m) => m.kind !== "shared_role_rate" && m.kind !== "shared_role_unit")} />
      <Headline setup={setup} />
      {runs.today.status === "error" && (
        <div role="alert" className="rounded-md border border-crit bg-crit-soft p-3 text-sm" data-run-error>
          The simulation could not run: {runs.today.error}
        </div>
      )}
      {!todayRun || !model ? <RunningCard what="Working out who has room, from a simulation of today's clients…" /> : <TodaySections {...props} model={model} result={todayRun} />}
    </div>
  );
}

function RunningCard({ what }: { what: string }) {
  return (
    <div role="status" aria-busy="true" data-running>
      <Section title="Working it out" description={what}>
        <Skeleton className="h-6 w-2/3" />
        <Skeleton className="h-3.5 w-full" />
        <Skeleton className="h-24 w-full" />
      </Section>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------------

function Attention({ base, problems, missing }: { base: string; problems: ReturnType<typeof capacityProblems>; missing: MissingItem[] }) {
  // A tier whose typed total the portfolios don't match: "over" is a warning in the list, "unassigned" only a note beneath it (Q13).
  const notes = missing.filter((m) => m.severity === "note");
  const needs = missing.filter((m) => m.severity !== "note");
  if (!problems.length && !needs.length && !notes.length) return null;
  const noteList = notes.length > 0 && (
    <ul className="flex list-disc flex-col gap-1 pl-5 text-sm text-fg-2" data-attention-notes>
      {notes.map((m) => (
        <li key={`${m.kind}-${m.id}`}>
          Note: {m.label}{" "}
          <Link href={missingHref(base, m)} className="whitespace-nowrap font-medium text-accent hover:underline">
            Tiers &amp; clients →
          </Link>
        </li>
      ))}
    </ul>
  );
  if (!problems.length && !needs.length) {
    return (
      <Section title="Notes on the client counts" data-attention-note-only description="For information. The figures below use the counts as they are.">
        {noteList}
      </Section>
    );
  }
  return (
    <section aria-labelledby="capacity-attention" className="flex min-w-0 flex-col gap-2 rounded-xl border border-warn bg-warn-soft p-4" data-attention>
      <div className="flex flex-col gap-0.5">
        <h2 id="capacity-attention" className="text-base font-semibold">
          Some figures below are not worked out yet
        </h2>
        <p className="max-w-prose text-sm text-fg-2">Fix these in Settings (Tiers &amp; clients, People &amp; roles) and the figures fill in. Where a value is missing the page leaves it out rather than guess.</p>
      </div>
      <ul className="flex list-disc flex-col gap-1 pl-5 text-sm">
        {problems.map((p, i) => (
          <li key={`p${i}`}>
            {p.message}{" "}
            <Link href={fixHref(base, p.where)} className="whitespace-nowrap font-medium text-accent hover:underline">
              Fix it →
            </Link>
          </li>
        ))}
        {needs.map((m) => (
          <li key={`${m.kind}-${m.id}-${m.field ?? ""}`}>
            {m.label}{" "}
            <Link href={missingHref(base, m)} className="whitespace-nowrap font-medium text-accent hover:underline">
              {m.severity === "warning" ? "Check it →" : "Enter it →"}
            </Link>
          </li>
        ))}
      </ul>
      {noteList}
    </section>
  );
}

function Headline({ setup }: { setup: CapacitySetup }) {
  const lines = useMemo(() => serviceLines(setup), [setup]);
  const d = useMemo(() => dler(setup), [setup]);
  const dlerKpi = (label: string, row: (typeof d)["whole"]) => {
    const shown = !row.hidden && row.ratio !== null;
    const status: KpiStatus | undefined = shown ? (row.ratio! >= DLER_GOAL ? { tone: "good", words: `At or above the ${f1(DLER_GOAL)} goal` } : { tone: "warn", words: `Below the ${f1(DLER_GOAL)} goal` }) : undefined;
    return (
      <KpiTile
        key={label}
        label={label}
        value={row.hidden ? "Hidden" : row.ratio === null ? "—" : f1(row.ratio)}
        status={status}
        sub={row.hidden ? "Pay is hidden for your role" : row.ratio === null ? "No salaries entered" : `Average of ${row.people} ${row.people === 1 ? "person's" : "people's"} DLER`}
      />
    );
  };
  const group = "text-2xs font-semibold tracking-wider text-muted-foreground uppercase";
  // Two flat strips of figures, side by side on a wide screen: who we serve, then what the people serving them cost against what they earn.
  return (
    <section aria-label="Clients and DLER" className="grid min-w-0 gap-4 2xl:grid-cols-2" data-headline-section data-headline>
      <div className="flex min-w-0 flex-col gap-2">
        <h2 className={group}>Clients</h2>
        <KpiStrip>
          {lines.byDepartment.map((dep) => (
            <KpiTile key={dep.id} label={`Clients with ${dep.name} services`} value={f0(dep.clients)} sub="named and counted" />
          ))}
          <KpiTile label="Clients taking both" value={f0(lines.both)} sub={`${f0(lines.unique)} clients in all`} />
        </KpiStrip>
      </div>
      <div className="flex min-w-0 flex-col gap-2">
        <h2 className={group}>DLER, fees against salaries (the goal is {f1(DLER_GOAL)})</h2>
        <KpiStrip>
          {d.departments.map((row) => dlerKpi(`DLER ${row.name}`, row))}
          {dlerKpi("DLER whole business", d.whole)}
        </KpiStrip>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------------------------------------------------

function TodaySections(props: CapacityViewProps & { model: EngineModel; result: SimulationResult }) {
  const { setup, model, result, purposes } = props;
  const busy = useMemo(() => busyShares(setup, model, result), [setup, model, result]);
  const departments = setup.departments.filter((d) => setup.services.some((s) => s.active && s.department_id === d.id && s.tier_id));
  const ceilings = useMemo(() => Object.fromEntries(departments.map((d) => [d.id, departmentCeiling(setup, model, result, d.id)])), [departments, setup, model, result]);
  const risk = useMemo(() => atRisk(setup, model, result), [setup, model, result]);
  const t = useMemo(() => timeToServe(setup, model), [setup, model]);
  // One colour per purpose across the page: the bottleneck's bars and the time-to-serve bars share them.
  const riskParts = useMemo(() => new Map(risk.people.map((r) => [r.person.id, namedPurposeParts(r.byPurpose, purposes)] as const)), [risk, purposes]);
  const tierParts = useMemo(() => new Map(t.departments.flatMap((d) => d.tiers.map((tier) => [tier.serviceId, namedPurposeParts(tier.byPurpose, purposes)] as const))), [t, purposes]);
  const colours = useMemo(() => purposeColours([...tierParts.values(), ...riskParts.values()], purposes), [tierParts, riskParts, purposes]);
  const cf = (deptId: string) => busy.people.filter((p) => p.kind === "client_facing" && p.departmentId === deptId);
  return (
    // The dashboard's panels (docs/plans/ui-cleanup.md, DashboardPage): two across from xl, three from 2xl; time to serve, with its table, runs the full width.
    <div className="grid min-w-0 gap-4 xl:grid-cols-2 2xl:grid-cols-3" data-capacity-panels>
      {departments.map((d) => (
        <Room key={d.id} name={d.name} ceiling={ceilings[d.id]!} people={cf(d.id)} />
      ))}
      {departments.map((d) => (
        <ClientFacingPeople key={d.id} name={d.name} setup={setup} ceiling={ceilings[d.id]!} people={cf(d.id)} showChannels={/performance/i.test(d.name)} />
      ))}
      <Bottleneck setup={setup} risk={risk} parts={riskParts} colours={colours} base={props.base} stepProcess={props.stepProcess} />
      <Leaver setup={setup} model={model} result={result} people={busy.people} />
      <TimeToServe setup={setup} model={model} purposes={purposes} colours={colours} className="xl:col-span-2 2xl:col-span-3" />
    </div>
  );
}

/** "Ann", "Ann and Bo", "Ann, Bo and Cy". */
function joinAnd(items: string[], last = "and"): string {
  return items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} ${last} ${items[items.length - 1]}`;
}

/** Room left for one person, in whole clients: "+3", or "full" when there is none (the detail says how far over). */
const roomWords = (canTake: number) => (canTake >= 1 ? `+${Math.floor(canTake)}` : "full");

function Room({ name, ceiling, people }: { name: string; ceiling: DepartmentCeiling; people: PersonBusy[] }) {
  const pulse = roomPulse(ceiling.room, ceiling.clients);
  const most = Math.floor(ceiling.max + 1e-9);
  const spare = ceiling.max - ceiling.clients;
  // Room for N more (good, or warn when tight); full when less than one client of room is left (warn); over by N (crit).
  const state: { words: string; tone: Tone } =
    spare >= 1 ? { words: `Room for ${f0(Math.floor(spare))} more`, tone: pulse.tone === "warn" ? "warn" : "ok" } : spare > -1 ? { words: "Full", tone: "warn" } : { words: `Over by ${f0(Math.floor(-spare))}`, tone: "bad" };
  const next = people
    .map((p) => ({ p, room: ceiling.perPerson[p.id]?.canTake ?? 0 }))
    .filter((x) => x.room >= 1)
    .sort((a, b) => b.room - a.room || a.p.name.localeCompare(b.p.name))
    .slice(0, 3)
    .map((x) => x.p.name);
  const teams = limitedBy(ceiling.limit);
  return (
    <Section title={`${name}: room for more clients`} data-room={name}
      aside={
        <PanelHow
          works={
            <>
              Each manager&apos;s ceiling is how many clients of their current mix they could hold before reaching their utilisation threshold (how busy a role can be before it counts as full, set per role under Set up → People &amp; roles), from the simulation&apos;s busy share. The department&apos;s ceiling adds those up, then checks each shared team: how many clients could it serve at its own utilisation threshold? The lowest is the most that fit. The next client goes to the people with the most room. A rough guide from the simulation, not a promise. Each team&apos;s ceiling:{" "}
              <span data-room-limits>
                {ceiling.limits.map((l, i) => (
                  <span key={l.name}>
                    {i > 0 && " · "}
                    <span className={cn(i === 0 && "font-semibold text-fg")}>
                      {l.kind === "people" ? "Client managers" : l.name} {f0(l.max)}
                    </span>
                  </span>
                ))}
              </span>
              .
            </>
          }
          tells="whether the department can take on work, which team stops it, and who should get the next client."
        />
      }
    >
      <p className="flex flex-wrap items-baseline gap-x-2 leading-none" data-room-clients>
        <span className="text-2xl font-semibold tracking-tight tabular-nums">{f0(ceiling.clients)}</span>
        <span className="text-base font-medium">clients today</span>
      </p>
      <div className="flex max-w-[40rem] flex-col gap-1.5">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 text-sm">
          <span className={cn("font-semibold", TONE_TEXT[state.tone])} data-room-status>
            {state.words}
          </span>
          <span className="text-xs text-muted-foreground tabular-nums">
            {f0(ceiling.clients)} of {f0(most)} clients
          </span>
        </div>
        <RoomBar clients={ceiling.clients} max={ceiling.max} tone={state.tone} label={`${f0(ceiling.clients)} clients today of ${f0(most)} that fit. ${state.words}.`} />
        <p className="text-xs text-muted-foreground" data-room-sentence>
          Up to {f0(most)} before {teams} reach their utilisation threshold.
        </p>
      </div>
      <p className="text-sm" data-room-next>
        <b className="font-semibold">Next client goes to:</b> {next.length ? joinAnd(next, "or") : "nobody has room for another client without going over their utilisation threshold."}
      </p>
    </Section>
  );
}

function ClientFacingPeople({ name, setup, ceiling, people, showChannels }: { name: string; setup: CapacitySetup; ceiling: DepartmentCeiling; people: PersonBusy[]; showChannels: boolean }) {
  const roleRule = new Map(setup.roles.map((r) => [r.id, r.rule_of_thumb]));
  const rows = [...people].sort((a, b) => b.busy - a.busy || a.name.localeCompare(b.name));
  return (
    <Section title={`${name}: client-facing people`} data-people-table={name}
      aside={
        <PanelHow
          works="Busy is the simulation's busy share, which includes waiting and rework; the black tick is the person's utilisation threshold (how busy their role can be before it counts as full). Green is under it, amber within 10 points of it, red at or over it. +N is their clients × utilisation threshold ÷ busy, less the clients they have now. Hours needed adds up every process step for each of their clients at their tier's frequency, from the simulation; available is the hours a month they have for client work after leave and team time."
          tells="who is stretched, who has room, and whether a rule of thumb matches what the work actually takes."
        />
      }
    >
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nobody looks after clients in this department yet.</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {rows.map((p) => {
            const canTake = ceiling.perPerson[p.id]?.canTake ?? personMax(p.clients, p.line, p.busy).canTake;
            const rule = p.roleId ? roleRule.get(p.roleId) : null;
            const available = p.busy > 0 ? p.hours / p.busy : 0;
            const sp = setup.people.find((x) => x.id === p.id);
            const tiers = Object.entries(p.clientsByTier)
              .filter(([, n]) => n > 0.05)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([tier, n]) => `${tier} ${f0(n)}`)
              .join(", ");
            const detail = [
              `${p.name}, ${p.roleName}${sp && sp.reserved_share > 0 ? ` (${formatPercent(sp.reserved_share)} team time)` : ""}`,
              `${formatPercent(p.busy)} busy against a utilisation threshold of ${formatPercent(p.line)} (range ${formatPercent(p.low)} to ${formatPercent(p.high)})`,
              `${f0(p.clients)} clients${tiers ? ` (${tiers})` : ""}`,
              canTake >= 1 ? `can take ${Math.floor(canTake)} more` : Math.abs(canTake) < 0.5 ? "at their utilisation threshold" : `${Math.ceil(-canTake)} clients over`,
              `hours needed ${f0(p.hours)} h a month, ${f0(available)} h available`,
              ...(showChannels ? [`${f0(channelsOf(setup, p))} channels`] : []),
              `rule of thumb ${rule ?? "not set"}${rule && p.clients > rule ? " (over it)" : ""}`,
            ].join(". ");
            return (
              <li key={p.id}>
                <div
                  tabIndex={0}
                  role="group"
                  title={`${detail}.`}
                  aria-label={`${detail}.`}
                  className="grid grid-cols-[6.5rem_minmax(0,1fr)_2.75rem] items-center gap-2.5 rounded-sm text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring md:grid-cols-[8rem_minmax(0,40rem)_3rem]"
                  data-person-row={p.name}
                >
                  <span className="truncate">{p.name}</span>
                  <div className="flex items-center gap-2">
                    <div className="flex-1">
                      <ThresholdBar busy={p.busy} line={p.line} />
                    </div>
                    <span className="w-9 text-right text-xs text-muted-foreground tabular-nums">{formatPercent(p.busy)}</span>
                  </div>
                  <span className={cn("text-right font-semibold tabular-nums", canTake >= 1 ? "text-good" : "text-muted-foreground")} data-can-take>
                    {roomWords(canTake)}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <p className="text-xs text-muted-foreground">The black tick is each person&apos;s own utilisation threshold. +N is how many more clients they can take. Hover or focus a row for their hours, tiers and rule of thumb.</p>
    </Section>
  );
}

/** Channels a person looks after: the sum of their clients' channels, from the tier's and each named client's own value. */
function channelsOf(setup: CapacitySetup, p: PersonBusy): number {
  let total = 0;
  const portfolio = setup.portfolio.filter((r) => r.person_id === p.id);
  for (const r of portfolio) total += r.client_count * (setup.services.find((s) => s.id === r.service_id)?.channels ?? 0);
  for (const c of setup.clients) {
    if (!c.active || !Object.values(c.assignments).includes(p.id)) continue;
    total += c.channels ?? c.service_ids.reduce((s, id) => s + (setup.services.find((x) => x.id === id)?.channels ?? 0), 0);
  }
  return total;
}

const MARGIN_POINTS = Math.round(AT_RISK_MARGIN * 100);

function Bottleneck({
  setup,
  risk,
  parts,
  colours,
  base,
  stepProcess,
}: {
  setup: CapacitySetup;
  risk: ReturnType<typeof atRisk>;
  parts: Map<string, PurposePart[]>;
  colours: Map<string, string>;
  base: string;
  stepProcess: Record<string, string>;
}) {
  const deptName = (p: PersonBusy) => setup.departments.find((d) => d.id === p.departmentId)?.name ?? p.roleName;
  const used = new Map([...colours].filter(([n]) => risk.people.some((r) => parts.get(r.person.id)?.some((x) => x.name === n))));
  return (
    <Section title="Bottleneck: who is at risk" data-bottleneck
      aside={
        <PanelHow
          works={
            <>
              At risk is anyone, client-facing or in a shared team, whose busy share from the simulation is at or over their own utilisation threshold (over), or within {MARGIN_POINTS} percentage points under it (near). Each bar is the hours the simulation gave them in a month, by the purpose of the process steps; hover a segment for its hours.
              {risk.people.length > 0 && (
                <>
                  {" "}
                  The steps that take the most of each month, linked to their place in the process:{" "}
                  {risk.people.map(({ person: p, steps }, i) => (
                    <span key={p.id}>
                      {i > 0 && "; "}
                      {p.name}:{" "}
                      {steps.map((s, j) => (
                        <span key={s.stepId}>
                          {j > 0 && ", "}
                          {s.stepId !== "hand" && stepProcess[s.stepId] ? (
                            <Link href={`${base}/p/${stepProcess[s.stepId]}?step=${s.stepId}`} className="text-accent hover:underline" data-step-link={s.stepId}>
                              {s.name}
                            </Link>
                          ) : (
                            s.name
                          )}{" "}
                          ({f1(s.hours)} h)
                        </span>
                      ))}
                    </span>
                  ))}
                  .
                </>
              )}
            </>
          }
          tells="who to take work from first, and what kind of work fills their month."
        />
      }
    >
      <p className="text-base leading-snug" data-bottleneck-sentence>
        {risk.people.length === 0 ? (
          <>Nobody is over or within {MARGIN_POINTS} points of their utilisation threshold.</>
        ) : (
          <>
            {risk.over > 0 && <b className="text-crit">{risk.over} over</b>}
            {risk.over > 0 && risk.near > 0 && " and "}
            {risk.near > 0 && (
              <b className="text-warn">
                {risk.near} within {MARGIN_POINTS} points
              </b>
            )}{" "}
            of their utilisation threshold.
          </>
        )}
      </p>
      {risk.people.length > 0 && (
        <>
          <ul className="flex max-w-[40rem] flex-col gap-3">
            {risk.people.map(({ person: p, status }) => {
              const bar = (parts.get(p.id) ?? []).map((x) => ({ ...x, color: colours.get(x.name) }));
              return (
                <li key={p.id} className="flex flex-col gap-1" data-at-risk={status}>
                  <div className="flex items-baseline justify-between gap-3 text-sm">
                    <span className="min-w-0 truncate">
                      <b className="font-semibold">{p.name}</b> <span className="text-xs text-muted-foreground">{deptName(p)}</span>
                    </span>
                    <span className={cn("shrink-0 font-semibold tabular-nums", status === "over" ? "text-crit" : "text-warn")} title={`Utilisation threshold ${formatPercent(p.line)}`}>
                      {formatPercent(p.busy)}
                    </span>
                  </div>
                  {bar.length > 0 ? <StackBar parts={bar} legend={false} label={`What fills ${p.name}'s month`} /> : <p className="text-xs text-muted-foreground">No step hours in the simulation.</p>}
                </li>
              );
            })}
          </ul>
          {used.size > 0 && <ColourLegend colours={used} />}
        </>
      )}
    </Section>
  );
}

function Leaver({ setup, model, result, people }: { setup: CapacitySetup; model: EngineModel; result: SimulationResult; people: PersonBusy[] }) {
  const sorted = useMemo(() => [...people].sort((a, b) => b.clients - a.clients || a.name.localeCompare(b.name)), [people]);
  const groups = useMemo<PickerGroup[]>(() => {
    const byGroup = new Map<string, PickerGroup>();
    for (const p of sorted) {
      const g = p.departmentId ? (setup.departments.find((d) => d.id === p.departmentId)?.name ?? "Other") : "Shared teams";
      if (!byGroup.has(g)) byGroup.set(g, { name: g, people: [] });
      byGroup.get(g)!.people.push({ id: p.id, name: p.name, note: p.kind === "client_facing" ? `${f0(p.clients)} clients` : p.roleName });
    }
    return [...byGroup.values()];
  }, [sorted, setup.departments]);
  const [picked, setPicked] = useState<string[] | null>(null);
  // Nobody chosen yet: the person with the most clients, so the section opens with an answer.
  const ids = useMemo(() => (picked ?? (sorted[0] ? [sorted[0].id] : [])).filter((id) => sorted.some((p) => p.id === id)), [picked, sorted]);
  const res = useMemo(() => (ids.length ? leavers(setup, model, result, ids) : null), [ids, setup, model, result]);
  if (!sorted.length) return null;
  const nameOf = (pid: string) => people.find((p) => p.id === pid)?.name ?? pid;
  const roleName = (rid: string) => setup.roles.find((r) => r.id === rid)?.name ?? rid;
  const received = res ? Object.entries(res.received).sort((a, b) => b[1] - a[1] || nameOf(a[0]).localeCompare(nameOf(b[0]))) : [];
  const leaving = ids.map((id) => people.find((p) => p.id === id)!);
  const anyClientFacing = leaving.some((p) => p.kind === "client_facing");
  const ramp = setup.rampDefault.length;
  const parts: string[] = [];
  if (res && anyClientFacing) {
    parts.push(
      res.clients === 0
        ? "they have no clients to hand over"
        : `their ${f0(res.clients)} ${res.clients === 1 ? "client goes" : "clients go"} to ${received.length ? joinAnd(received.map(([pid, n]) => `${nameOf(pid)} (${n})`)) : "nobody: no one else serves those tiers"}`,
    );
  }
  if (res?.sharedTeams.length) parts.push(`the rest of the ${joinAnd(res.sharedTeams.map((r) => roleName(r).toLowerCase()))} ${res.sharedTeams.length === 1 ? "shares" : "share"} their work`);
  if (res?.emptyTeams.length) parts.push(`nobody is left in the ${joinAnd(res.emptyTeams.map((r) => roleName(r).toLowerCase()))} to do their work`);
  return (
    <Section title="What if someone leaves?" data-leaver
      aside={
        <PanelHow
          works="Takes everyone you choose out together, then hands each of their clients, one at a time, to whichever colleague in the same department is least busy and serves that tier (nobody who is leaving gets a client). A client adds the hours its tier needs from a manager (the planned hours, as in time to serve) to the colleague's busy share, which starts from the simulation's. Someone in a shared team has no clients: the rest of their team shares their hours. Each row shows a colleague's busy share before (hollow dot) and after (filled dot) against their utilisation threshold (the black tick)."
          tells="key-person risk: who absorbs the loss, and whether you need a replacement or a rebalance."
        />
      }
    >
      <PeoplePicker label="Who leaves (choose one or more)" groups={groups} value={ids} onChange={setPicked} />
      {res ? (
        <>
          <p className="text-lg leading-snug font-semibold" data-leaver-sentence>
            If {joinAnd(leaving.map((p) => p.name))} {leaving.length === 1 ? "leaves" : "leave"}, {joinAnd(parts)}.{" "}
            {res.goOver.length ? (
              <span className="text-crit">
                {joinAnd(res.goOver.map(nameOf))} {res.goOver.length === 1 ? "goes" : "go"} over their utilisation threshold.
              </span>
            ) : (
              <span className="font-normal">Nobody new goes over their utilisation threshold.</span>
            )}
            {res.unplaced > 0 && (
              <span className="text-crit">
                {" "}
                {f0(res.unplaced)} {res.unplaced === 1 ? "client has" : "clients have"} nobody who serves their tier.
              </span>
            )}
          </p>
          {res.rows.length > 0 && (
            <div className="grid gap-2" data-dumbbells>
              {res.rows.map((r) => (
                <div key={r.id} className="grid grid-cols-[6rem_minmax(0,1fr)] items-center gap-2.5 text-sm md:grid-cols-[8rem_minmax(0,40rem)]">
                  <span className="truncate">{r.name}</span>
                  <Dumbbell before={r.before} after={r.after} line={r.line} />
                </div>
              ))}
            </div>
          )}
          <p className="text-xs text-muted-foreground">Hollow dot: busy today. Filled dot: busy after. The black tick is their utilisation threshold. A replacement takes about {ramp || 3} months to reach full speed.</p>
        </>
      ) : (
        <p className="text-base text-muted-foreground" data-leaver-sentence>
          Choose one or more people to see who takes their work.
        </p>
      )}
    </Section>
  );
}

export function TimeToServe({ setup, model, purposes, colours: shared, className }: { setup: CapacitySetup; model: EngineModel; purposes?: readonly PurposeCategory[]; colours?: Map<string, string>; className?: string }) {
  const t = useMemo(() => timeToServe(setup, model), [setup, model]);
  const money = (v: number) => formatWholeCurrency(v, setup.currency);
  const nameOf = (id: string | null) => setup.people.find((p) => p.id === id)?.name ?? "—";
  // Each tier's bar, named by the workspace's purposes, and one colour per purpose across the whole section.
  const parts = useMemo(() => new Map(t.departments.flatMap((d) => d.tiers.map((tier) => [tier.serviceId, namedPurposeParts(tier.byPurpose, purposes)] as const))), [t, purposes]);
  // The page passes its colours so a purpose matches the bottleneck's bars; on its own it picks them from these bars.
  const colours = useMemo(() => shared ?? purposeColours([...parts.values()], purposes), [shared, parts, purposes]);
  return (
    <>
    <Section title="Avg time to serve one client, by tier, per month" className={className} data-time-to-serve
      aside={
        <PanelHow
          works="Adds up every step of the monthly servicing processes for one client of the tier, all roles together, using the tier's meetings, words, links, ad-hoc chance and so on, with the tier multipliers and any changes at their start. This is the planned time, not a simulation: it ignores waiting and rework. Named clients use their own values."
          tells="what takes the time, and which clients earn the most per hour of effort."
        />
      }
    >
      {/* One framed block per department, its name in a header band, so Organic and Performance can't run into each other. */}
      <div className="flex flex-col gap-4">
        {t.departments.map((d) => (
          <section key={d.id} className="overflow-hidden rounded-lg border border-line" aria-labelledby={`tts-${d.id}`} data-tts-department={d.name}>
            <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-line bg-panel-2 px-4 py-2">
              <h3 id={`tts-${d.id}`} className="text-sm font-semibold">
                {d.name}
              </h3>
              <span className="text-xs text-muted-foreground">
                {d.tiers.length} {d.tiers.length === 1 ? "tier" : "tiers"}
                {d.tiers.length > 0 && ` · ${money(Math.min(...d.tiers.map((x) => x.fee)))}–${money(Math.max(...d.tiers.map((x) => x.fee)))} a month`}
              </span>
            </header>
            {/* The tiers side by side, divided by hairlines: plain sections inside the department's frame. */}
            <div className="grid divide-line max-md:divide-y md:grid-cols-[repeat(auto-fit,minmax(16rem,1fr))] md:divide-x">
              {d.tiers.map((tier) => (
                <div key={tier.serviceId} className="flex min-w-0 flex-col gap-1 px-4 py-3" data-tier-card={`${d.name} ${tier.tierKey}`}>
                  <div className="flex items-center justify-between gap-2">
                    <h4 className="text-sm font-semibold">{tier.tierName} client</h4>
                    <span className="text-xs text-muted-foreground" data-tier-fee>
                      Avg {money(tier.fee)} a month
                    </span>
                  </div>
                  <p className="text-base">
                    <b className="tabular-nums">{f0(tier.hours)} hours</b> a month
                  </p>
                  <p className="mb-1 text-xs text-muted-foreground">{tier.feePerHour === null ? "No hours planned yet" : `Earns ${money(tier.feePerHour)} per hour of work`}</p>
                  {tier.byPurpose.length > 0 && <StackBar parts={(parts.get(tier.serviceId) ?? []).map((p) => ({ ...p, color: colours.get(p.name) }))} />}
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>
    </Section>
    {t.named.length > 0 && (
      <Section title="Named clients: time and earnings" className={className} data-named-clients-section>
        <Table className="min-w-[30rem]" data-named-clients>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Client</TableHead>
              <TableHead>Looked after by</TableHead>
              <TableHead className="text-right">Hours a month</TableHead>
              <TableHead className="text-right">Earns per hour</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {t.named.map((c) => (
              <TableRow key={c.id}>
                <TableCell>{c.name}</TableCell>
                <TableCell>{nameOf(c.manager)}</TableCell>
                <TableCell className="text-right tabular-nums">{f1(c.hours)}</TableCell>
                <TableCell className="text-right tabular-nums">{c.feePerHour === null ? "—" : money(c.feePerHour)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Section>
    )}
    </>
  );
}
