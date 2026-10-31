"use client";

// The Capacity page (capacity build P5; the prototype's Capacity screen, docs/prototypes/client-capacity-app.PROTOTYPE.html `pageCapacity`).
// Every widget leads with its answer in a sentence, then the picture, with "How this works" folded away. The numbers come from two
// simulations in the worker (Today, then the next 12 months) and the pure figures in @transpera-flow/db (capacity-figures.ts).

import Link from "next/link";
import { useMemo, useState } from "react";
import {
  bottleneck,
  busyShares,
  DLER_GOAL,
  departmentCeiling,
  dler,
  hiringAdvice,
  leaver,
  missingForCapacity,
  serviceLines,
  timeToServe,
  todayModel,
  type CapacitySetup,
  type DepartmentCeiling,
  type MissingItem,
  type PersonBusy,
} from "@transpera-flow/db";
import { capacityProblems, type EngineModel, type SimulationResult } from "@transpera-flow/engine";
import { Skeleton } from "@/components/ui/skeleton";
import { formatNumber, formatPercent, formatWholeCurrency } from "@/lib/format";
import { useCapacityRuns, type PhaseState } from "@/lib/sim/use-capacity-runs";
import { cn } from "@/lib/utils";
import { BusyBar, Chip, Dumbbell, How, Kpi, RoomGauge, Section, StackBar, TierChips, toneOf, TONE_TEXT } from "./widgets";

export interface CapacityViewProps {
  setup: CapacitySetup;
  /** The workspace's model; null when it can't be built (`modelError` says why). */
  model: EngineModel | null;
  modelError?: string | null;
  /** The 12-month run's model (planned hires, end dates and leave) and its months' edges. */
  year: { model: EngineModel; monthStarts: number[] } | null;
  /** `/w/<slug>`. */
  base: string;
  /** Step id → the process it belongs to, for the links to steps (D32). */
  stepProcess: Record<string, string>;
  /** The day the 12-month run starts (ISO date), to name its months. */
  startDate?: string;
}

const f0 = (v: number) => formatNumber(v, 0);
const f1 = (v: number) => formatNumber(v, 1);

/** Where an engine problem or a missing item is fixed. */
function fixHref(base: string, where: string): string {
  if (where.startsWith("people") || where.startsWith("roles")) return `${base}/setup/people`;
  if (where.startsWith("steps") || where.startsWith("changes")) return `${base}/processes`;
  return `${base}/setup/clients`;
}
const missingHref = (base: string, m: MissingItem): string => (m.kind === "tier_deliverable" ? `${base}/setup/clients` : `${base}/setup/people`);

export function CapacityView(props: CapacityViewProps) {
  const { setup, model, year, base } = props;
  const hasTiers = setup.services.some((s) => s.active && s.department_id && s.tier_id);
  const today = useMemo(() => (model && hasTiers ? todayModel(model) : null), [model, hasTiers]);
  const runs = useCapacityRuns(today, hasTiers ? (year?.model ?? null) : null, year?.monthStarts ?? null);
  const problems = useMemo(() => (model ? capacityProblems(model) : []), [model]);
  const missing = useMemo(() => missingForCapacity(setup, { salariesVisible: !setup.payHidden }), [setup]);

  if (!hasTiers) {
    return (
      <div className="flex flex-col gap-4">
        <div data-no-tiers className="rounded-token border border-dashed border-line p-6 text-sm text-muted-foreground">
          <p className="font-medium text-fg">No tiers and services are set up yet.</p>
          <p>Capacity is worked out from each department&apos;s tiers, the clients in them and the people who look after them.</p>
          <p className="mt-3">
            <Link href={`${base}/setup/clients`} className="font-medium text-accent hover:underline">
              Set up tiers and clients →
            </Link>
          </p>
        </div>
      </div>
    );
  }

  const todayRun = runs.today.status === "done" ? runs.today.run.result : null;
  return (
    <div
      className="flex min-w-0 flex-col gap-6"
      data-capacity
      data-today-ms={runs.today.status === "done" ? Math.round(runs.today.run.durationMs) : undefined}
      data-year-ms={runs.year.status === "done" ? Math.round(runs.year.run.durationMs) : undefined}
    >
      {props.modelError && (
        <div data-model-error role="alert" className="rounded-token border border-crit bg-crit-soft p-3 text-sm">
          {props.modelError}
        </div>
      )}
      <Attention base={base} problems={problems} missing={missing.filter((m) => m.kind !== "shared_role_rate" && m.kind !== "shared_role_unit")} />
      <Headline setup={setup} />
      {runs.today.status === "error" && (
        <div role="alert" className="rounded-token border border-crit bg-crit-soft p-3 text-sm" data-run-error>
          The simulation could not run: {runs.today.error}
        </div>
      )}
      {!todayRun || !model ? (
        <RunningCard what="Working out who has room, from a simulation of today's clients…" />
      ) : (
        <TodaySections {...props} model={model} result={todayRun} missing={missing} />
      )}
      <NextTwelve {...props} phase={runs.year} />
    </div>
  );
}

function RunningCard({ what }: { what: string }) {
  return (
    <div role="status" aria-busy="true" data-running className="flex flex-col gap-3 rounded-token border border-line bg-panel p-4">
      <p className="text-sm text-muted-foreground">{what}</p>
      <Skeleton className="h-6 w-2/3" />
      <Skeleton className="h-3.5 w-full" />
      <Skeleton className="h-24 w-full" />
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------------

function Attention({ base, problems, missing }: { base: string; problems: ReturnType<typeof capacityProblems>; missing: MissingItem[] }) {
  if (!problems.length && !missing.length) return null;
  return (
    <section data-attention className="flex flex-col gap-2 rounded-token border border-warn bg-warn-soft p-4 text-sm">
      <h2 className="font-heading text-base font-semibold">Some figures below are not worked out yet</h2>
      <p className="text-muted-foreground">Fix these in Set up and the figures fill in. Where a value is missing the page leaves it out rather than guess.</p>
      <ul className="flex list-disc flex-col gap-1 pl-5">
        {problems.map((p, i) => (
          <li key={`p${i}`}>
            {p.message}{" "}
            <Link href={fixHref(base, p.where)} className="whitespace-nowrap font-medium text-accent hover:underline">
              Fix it →
            </Link>
          </li>
        ))}
        {missing.map((m) => (
          <li key={`${m.kind}-${m.id}-${m.field ?? ""}`}>
            {m.label}{" "}
            <Link href={missingHref(base, m)} className="whitespace-nowrap font-medium text-accent hover:underline">
              Enter it →
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Headline({ setup }: { setup: CapacitySetup }) {
  const lines = useMemo(() => serviceLines(setup), [setup]);
  const d = useMemo(() => dler(setup), [setup]);
  const money = (v: number) => formatWholeCurrency(v, setup.currency);
  const dlerKpi = (label: string, row: (typeof d)["whole"]) => (
    <Kpi
      key={label}
      label={label}
      value={row.ratio === null ? "Hidden" : f1(row.ratio)}
      sub={row.salaries === null ? "Pay is hidden for your role" : `${money(row.retainers)} ÷ ${money(row.salaries)} · goal ${DLER_GOAL}`}
    />
  );
  return (
    <div className="grid grid-cols-[repeat(auto-fit,minmax(10.5rem,1fr))] gap-2.5" data-headline>
      {lines.byDepartment.map((dep) => (
        <Kpi key={dep.id} label={`Clients with ${dep.name} services`} value={f0(dep.clients)} sub="named and counted" />
      ))}
      <Kpi label="Clients taking both" value={f0(lines.both)} sub={`${f0(lines.unique)} clients in all`} />
      {d.departments.map((row) => dlerKpi(`DLER ${row.name}`, row))}
      {dlerKpi("DLER whole business", d.whole)}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------------

function TodaySections(props: CapacityViewProps & { model: EngineModel; result: SimulationResult; missing: MissingItem[] }) {
  const { setup, model, result, base } = props;
  const busy = useMemo(() => busyShares(setup, model, result), [setup, model, result]);
  const departments = setup.departments.filter((d) => setup.services.some((s) => s.active && s.department_id === d.id && s.tier_id));
  const ceilings = useMemo(() => Object.fromEntries(departments.map((d) => [d.id, departmentCeiling(setup, model, result, d.id)])), [departments, setup, model, result]);
  return (
    <>
      <div className="grid gap-4 md:grid-cols-2" data-rooms>
        {departments.map((d) => (
          <Room key={d.id} name={d.name} ceiling={ceilings[d.id]!} people={busy.people.filter((p) => p.kind === "client_facing" && p.departmentId === d.id)} />
        ))}
      </div>
      {departments.map((d) => (
        <PeopleTable key={d.id} name={d.name} setup={setup} people={busy.people.filter((p) => p.kind === "client_facing" && p.departmentId === d.id)} showChannels={/performance/i.test(d.name)} />
      ))}
      <SharedTeams setup={setup} model={model} result={result} busy={busy} missing={props.missing} />
      <Bottleneck setup={setup} model={model} result={result} base={base} stepProcess={props.stepProcess} />
      <Leaver setup={setup} model={model} result={result} people={busy.people} />
      <TimeToServe setup={setup} model={model} />
    </>
  );
}

function Room({ name, ceiling, people }: { name: string; ceiling: DepartmentCeiling; people: PersonBusy[] }) {
  const chips = people
    .map((p) => ({ p, room: ceiling.perPerson[p.id]?.canTake ?? 0 }))
    .sort((a, b) => b.room - a.room);
  const full = ceiling.room < 1;
  const who = ceiling.limit === "Client-facing people" ? "its client managers" : `the ${ceiling.limit.toLowerCase()}`;
  return (
    <section className="flex min-w-0 flex-col gap-1 rounded-token border border-line bg-panel p-4" data-room={name}>
      <h2 className="font-heading text-base font-semibold tracking-tight">{name}: room for more clients</h2>
      <p className="text-base leading-snug" data-room-sentence>
        {full ? (
          <>
            <span className="font-semibold text-crit">Full.</span> {name} can&apos;t take another client without someone going over their line.
          </>
        ) : (
          <>
            {name} can take about <b>{ceiling.room} more clients</b>.
          </>
        )}
      </p>
      <p className="mb-3 text-xs text-muted-foreground">
        {f0(ceiling.clients)} clients today. The ceiling is {f0(ceiling.max)}, set by {who}.
      </p>
      <RoomGauge clients={ceiling.clients} limits={ceiling.limits} room={ceiling.room} />
      <h3 className="mt-4 mb-2 text-sm font-semibold">Who can take the next client</h3>
      <div className="flex flex-wrap gap-1.5" data-chips>
        {chips.map(({ p, room }) => (
          <Chip key={p.id} tone={room >= 1 ? "ok" : "bad"}>
            {p.name}{" "}
            <b>{room >= 1 ? `+${Math.floor(room)} more` : Math.abs(room) < 0.5 ? "at the line" : `${Math.ceil(-room)} over`}</b>
          </Chip>
        ))}
        {chips.length === 0 && <span className="text-sm text-muted-foreground">Nobody looks after clients in this department yet.</span>}
      </div>
      <How
        works="Each manager's ceiling is how many clients of their current mix they could hold before reaching their line, from the simulation's busy share. The department ceiling adds those up, then checks each shared team (content, links, tech, implementers): how many clients could it serve at its own line? The lowest figure is the ceiling. The marks on the bar are each of those limits."
        tells="whether the department can take on work, which team stops it, and who should get the next client."
      />
    </section>
  );
}

function PeopleTable({ name, setup, people, showChannels }: { name: string; setup: CapacitySetup; people: PersonBusy[]; showChannels: boolean }) {
  const roleRule = new Map(setup.roles.map((r) => [r.id, r.rule_of_thumb]));
  return (
    <Section title={`${name}: client-facing people`} data-people-table={name}>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[44rem] text-sm">
          <thead>
            <tr className="border-b border-line text-left text-xs text-muted-foreground">
              <th className="py-1.5 pr-3 font-medium">Person</th>
              <th className="py-1.5 pr-3 font-medium">Clients</th>
              <th className="py-1.5 pr-3 text-right font-medium">Can take</th>
              <th className="py-1.5 pr-3 text-right font-medium">Rule</th>
              {showChannels && <th className="py-1.5 pr-3 text-right font-medium">Channels</th>}
              <th className="py-1.5 pr-3 text-right font-medium">Hours needed</th>
              <th className="py-1.5 pr-3 text-right font-medium">Available</th>
              <th className="min-w-[11rem] py-1.5 font-medium">Busy against line</th>
            </tr>
          </thead>
          <tbody>
            {people.map((p) => {
              const max = p.busy > 0 ? (p.clients * p.line) / p.busy : 0;
              const room = max - p.clients;
              const rule = p.roleId ? roleRule.get(p.roleId) : null;
              const available = p.busy > 0 ? p.hours / p.busy : 0;
              const sp = setup.people.find((x) => x.id === p.id);
              return (
                <tr key={p.id} className="border-b border-line/60 align-top last:border-0">
                  <td className="py-2 pr-3">
                    {p.name}
                    <div className="text-xs text-muted-foreground">
                      {p.roleName}
                      {sp && sp.reserved_share > 0 ? ` · ${formatPercent(sp.reserved_share)} team time` : ""}
                    </div>
                  </td>
                  <td className="py-2 pr-3 tabular-nums">
                    {f0(p.clients)} <TierChips byTier={p.clientsByTier} />
                  </td>
                  <td className={cn("py-2 pr-3 text-right tabular-nums", room < -0.5 && "font-semibold text-crit")}>{room >= 1 ? `+${Math.floor(room)}` : Math.abs(room) < 0.5 ? "0" : `${Math.ceil(-room)} over`}</td>
                  <td className={cn("py-2 pr-3 text-right tabular-nums", rule && p.clients > rule ? "font-semibold text-crit" : "text-muted-foreground")}>{rule ?? "—"}</td>
                  {showChannels && <td className="py-2 pr-3 text-right tabular-nums">{f0(channelsOf(setup, p))}</td>}
                  <td className="py-2 pr-3 text-right tabular-nums">{f0(p.hours)} h</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{f0(available)} h</td>
                  <td className="py-2">
                    <BusyBar busy={p.busy} line={p.line} low={p.low} high={p.high} label={p.name} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <How
        works="Hours needed adds up every process step for each of the person's clients, at their tier's frequency, from the simulation (the hands-on hours it measured, a month on average). Available is the hours a month they have for client work after leave and team time. Busy is the simulation's busy share, which includes waiting and rework, with its 10 to 90% range shown as the faint band; the dark tick is their line. Can take is their clients × line ÷ busy, less the clients they have now."
        tells="who is stretched, who has room, and whether a rule of thumb matches what the work actually takes."
      />
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

function SharedTeams({ setup, model, result, busy, missing }: { setup: CapacitySetup; model: EngineModel; result: SimulationResult; busy: ReturnType<typeof busyShares>; missing: MissingItem[] }) {
  const teams = busy.roles.filter((r) => r.kind === "shared" && r.people > 0 && r.departmentId);
  if (!teams.length) return null;
  const noUnit = new Set(missing.filter((m) => m.kind === "shared_role_unit").map((m) => m.id));
  return (
    <Section title="Shared teams" aside={<span className="text-xs text-muted-foreground">They serve every client and own none.</span>} data-shared-teams>
      <div className="grid gap-3 md:grid-cols-3">
        {teams.map((t) => {
          const members = setup.people.filter((p) => p.role_ids.includes(t.id) && p.active);
          const demand = members.reduce((s, p) => s + Object.values(result.personTime?.stepHours[p.id] ?? {}).reduce((a, b) => a + b, 0), 0);
          const atLine = t.busy > 0 ? (demand / t.busy) * t.line : 0;
          const unit = setup.roles.find((r) => r.id === t.id)?.unit?.trim() || null;
          const perHour = model.roles[t.id]?.unit?.perHour;
          const tone = toneOf(t.busy, t.line);
          return (
            <div key={t.id} className="flex min-w-0 flex-col gap-1.5 rounded-token border border-line p-3" data-team={t.name}>
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-sm font-semibold">{t.name}</h3>
                <span className={cn("rounded-full px-2 py-0.5 text-xs font-medium", tone === "bad" ? "bg-crit-soft text-crit" : tone === "warn" ? "bg-warn-soft text-warn" : "bg-good-soft text-good")}>{formatPercent(t.busy)}</span>
              </div>
              <p className="text-xs text-muted-foreground">{members.map((m) => m.name).join(", ")}</p>
              {perHour && unit ? (
                <p className="text-xs">
                  <b className="tabular-nums">{f0(demand * perHour)}</b> of <span className="tabular-nums">{f0(atLine * perHour)}</span> {unit} a month at the line
                </p>
              ) : (
                <p className="text-xs">
                  <b className="tabular-nums">{f0(demand)}</b> of <span className="tabular-nums">{f0(atLine)}</span> hours a month at the line
                  <span className="block text-muted-foreground">
                    {unit ? `Unit: ${unit}. ` : ""}
                    {noUnit.has(t.id) ? "No unit of work entered. " : ""}Rate not entered yet
                  </span>
                </p>
              )}
              <BusyBar busy={t.busy} line={t.line} low={t.low} high={t.high} label={t.name} />
            </div>
          );
        })}
      </div>
      <How works="Each shared team's busy share comes from the simulation: the work its steps put on it, queued for its people. The hours at the line are the team's capacity at its line, which is what it could do before it is stretched." tells="whether a team that serves everyone is close to being the limit. Once a rate is entered the hours turn into the team's own unit." />
    </Section>
  );
}

function Bottleneck({ setup, model, result, base, stepProcess }: { setup: CapacitySetup; model: EngineModel; result: SimulationResult; base: string; stepProcess: Record<string, string> }) {
  const b = useMemo(() => bottleneck(setup, model, result), [setup, model, result]);
  if (!b) return null;
  const p = b.person;
  const tone = toneOf(p.busy, p.line);
  return (
    <Section title="Bottleneck" data-bottleneck>
      <p className="text-base leading-snug" data-bottleneck-sentence>
        <b>{p.name}</b> ({p.roleName}) is the most stretched, at <b className={TONE_TEXT[tone]}>{formatPercent(p.busy)}</b> against a line of {formatPercent(p.line)}.
      </p>
      <h3 className="text-sm font-semibold">What fills their month</h3>
      <StackBar parts={b.steps.map((s) => ({ key: s.stepId, name: s.name, value: s.hours }))} />
      <p className="text-xs">
        These come from process steps assigned to them:{" "}
        {b.steps.map((s, i) => (
          <span key={s.stepId}>
            {i > 0 && ", "}
            {s.stepId !== "hand" && stepProcess[s.stepId] ? (
              <Link href={`${base}/p/${stepProcess[s.stepId]}#step-${s.stepId}`} className="text-accent hover:underline" data-step-link={s.stepId}>
                {s.name}
              </Link>
            ) : (
              s.name
            )}
          </span>
        ))}
        .
      </p>
      {b.next.length > 0 && (
        <p className="text-xs text-muted-foreground">
          Next most stretched: {b.next.map((x) => `${x.name} ${formatPercent(x.busy)}`).join(" · ")}
        </p>
      )}
      <How
        works="Ranks everyone by how far they are over (or under) their own line, using the simulation's busy share, and shows the process steps that take the most of the top person's month. Each step links to its place in the process."
        tells="who to take work from first, and which steps would free the most time if they were quicker."
      />
    </Section>
  );
}

function Leaver({ setup, model, result, people }: { setup: CapacitySetup; model: EngineModel; result: SimulationResult; people: PersonBusy[] }) {
  const sorted = useMemo(() => [...people].sort((a, b) => b.clients - a.clients || a.name.localeCompare(b.name)), [people]);
  const [picked, setPicked] = useState<string | null>(null);
  const id = picked && sorted.some((p) => p.id === picked) ? picked : (sorted[0]?.id ?? null);
  const res = useMemo(() => (id ? leaver(setup, model, result, id) : null), [id, setup, model, result]);
  const who = sorted.find((p) => p.id === id);
  if (!sorted.length) return null;
  const nameOf = (pid: string) => people.find((p) => p.id === pid)?.name ?? pid;
  const received = res ? Object.entries(res.received).sort((a, b) => b[1] - a[1]) : [];
  const ramp = setup.rampDefault.length;
  return (
    <Section
      title="What if someone leaves?"
      aside={
        <label className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">Person</span>
          <select className="rounded-token border border-line bg-panel px-2 py-1 text-sm" value={id ?? ""} onChange={(e) => setPicked(e.target.value)} data-leaver-select aria-label="Person who leaves">
            {sorted.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
      }
      data-leaver
    >
      {who && res && (
        <>
          <p className="text-base leading-snug" data-leaver-sentence>
            {res.kind === "client_facing" ? (
              <>
                If <b>{who.name}</b> leaves, their {f0(res.clients)} clients go to {received.map(([pid, n]) => `${nameOf(pid)} (${n})`).join(", ") || "nobody: no one else serves those tiers"}.
              </>
            ) : (
              <>
                If <b>{who.name}</b> leaves, the {who.roleName.toLowerCase()} shares their work.
              </>
            )}{" "}
            {res.goOver.length ? <span className="font-semibold text-crit">{res.goOver.map(nameOf).join(", ")} {res.goOver.length === 1 ? "goes" : "go"} over their line.</span> : "Nobody new goes over their line."}
            {res.unplaced > 0 && <span className="text-crit"> {res.unplaced} clients have nobody who serves their tier.</span>}
          </p>
          <div className="grid gap-2" data-dumbbells>
            {res.rows.map((r) => (
              <div key={r.id} className="grid grid-cols-[6rem_minmax(0,1fr)] items-center gap-2.5 text-sm md:grid-cols-[7.5rem_minmax(0,1fr)]">
                <span className="truncate">{r.name}</span>
                <Dumbbell before={r.before} after={r.after} line={r.line} />
              </div>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">A replacement takes about {ramp || 3} months to reach full speed.</p>
        </>
      )}
      <How
        works="Takes the person out, then hands each of their clients to whichever colleague is least busy and serves that tier. A client adds the hours its tier needs from a manager (the planned hours, as in time to serve) to the colleague's busy share, which starts from the simulation's. Each row shows a colleague's busy share before (hollow dot) and after (solid dot); the grey line is their line."
        tells="key-person risk: who absorbs the loss, and whether you need a replacement or a rebalance."
      />
    </Section>
  );
}

function TimeToServe({ setup, model }: { setup: CapacitySetup; model: EngineModel }) {
  const t = useMemo(() => timeToServe(setup, model), [setup, model]);
  const money = (v: number) => formatWholeCurrency(v, setup.currency);
  const nameOf = (id: string | null) => setup.people.find((p) => p.id === id)?.name ?? "—";
  return (
    <Section title="Time to serve one client, per month" data-time-to-serve>
      {t.departments.map((d) => (
        <div key={d.id} className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold">{d.name}</h3>
          <div className="grid gap-3 md:grid-cols-3">
            {d.tiers.map((tier) => (
              <div key={tier.serviceId} className="flex flex-col gap-1 rounded-token border border-line p-3" data-tier-card={`${d.name} ${tier.tierKey}`}>
                <div className="flex items-center justify-between gap-2">
                  <h4 className="text-sm font-semibold">{tier.tierName} client</h4>
                  <span className="text-xs text-muted-foreground">{money(tier.fee)} a month</span>
                </div>
                <p className="text-base">
                  <b className="tabular-nums">{f0(tier.hours)} hours</b> a month
                </p>
                <p className="mb-1 text-xs text-muted-foreground">{tier.feePerHour === null ? "No hours planned yet" : `Earns ${money(tier.feePerHour)} per hour of work`}</p>
                {tier.byPurpose.length > 0 && <StackBar parts={tier.byPurpose.map((x) => ({ key: x.name, name: x.name, value: x.hours }))} />}
              </div>
            ))}
          </div>
        </div>
      ))}
      {t.named.length > 0 && (
        <>
          <h3 className="text-sm font-semibold">Named clients</h3>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[30rem] text-sm" data-named-clients>
              <thead>
                <tr className="border-b border-line text-left text-xs text-muted-foreground">
                  <th className="py-1.5 pr-3 font-medium">Client</th>
                  <th className="py-1.5 pr-3 font-medium">Looked after by</th>
                  <th className="py-1.5 pr-3 text-right font-medium">Hours a month</th>
                  <th className="py-1.5 text-right font-medium">Earns per hour</th>
                </tr>
              </thead>
              <tbody>
                {t.named.map((c) => (
                  <tr key={c.id} className="border-b border-line/60 last:border-0">
                    <td className="py-1.5 pr-3">{c.name}</td>
                    <td className="py-1.5 pr-3">{nameOf(c.manager)}</td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">{f1(c.hours)}</td>
                    <td className="py-1.5 text-right tabular-nums">{c.feePerHour === null ? "—" : money(c.feePerHour)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      <How
        works="Adds up every step of the monthly servicing processes for one client of the tier, all roles together, using the tier's meetings, words, links, ad-hoc chance and so on, with the tier multipliers and any changes at their start. This is the planned time, not a simulation: it ignores waiting and rework. Named clients use their own values."
        tells="what takes the time, and which clients earn the most per hour of effort."
      />
    </Section>
  );
}

// ---------------------------------------------------------------------------------------------------------------------

/** "Nov 26": the month `i` months after the one `start` falls in. */
function monthLabel(start: string, i: number): string {
  const d = new Date(`${start.slice(0, 7)}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + i);
  return `${d.toLocaleString("en-GB", { month: "short", timeZone: "UTC" })} ${String(d.getUTCFullYear()).slice(2)}`;
}

function NextTwelve({ setup, year, phase, startDate }: CapacityViewProps & { phase: PhaseState }) {
  const result = phase.status === "done" ? phase.run.result : null;
  const advice = useMemo(() => (result ? hiringAdvice(setup, result) : []), [setup, result]);
  if (!year) return null;
  const monthName = (i: number) => (i === 0 ? "now" : startDate ? monthLabel(startDate, i) : `month ${i + 1}`);
  const over = advice.filter((a) => a.overFrom !== null);
  const under = advice.filter((a) => a.overFrom === null);
  return (
    <Section title="The next 12 months" data-next-twelve>
      {phase.status === "error" ? (
        <p role="alert" className="text-sm text-crit">
          The 12-month run could not finish: {phase.error}
        </p>
      ) : !result ? (
        <div role="status" aria-busy="true" className="flex flex-col gap-2">
          <p className="text-sm text-muted-foreground">Running the next 12 months…</p>
          <Skeleton className="h-5 w-1/2" />
        </div>
      ) : (
        <>
          <p className="text-base leading-snug">{over.length ? "What to do:" : "No team goes over its line in the next 12 months."}</p>
          {over.length > 0 && (
            <ul className="flex list-disc flex-col gap-1 pl-5 text-sm" data-todo>
              {over.map((a) => (
                <li key={a.roleId}>
                  <b>{a.name}:</b> {a.overFrom === 0 ? "over the line now" : <>over the line from <b>{monthName(a.overFrom!)}</b></>}.{" "}
                  {a.hireBy! <= 0 ? <span className="font-semibold text-crit">Start hiring now.</span> : `Start hiring by ${monthName(a.hireBy!)}.`}
                </li>
              ))}
            </ul>
          )}
          {under.length > 0 && over.length > 0 && <p className="text-xs text-muted-foreground">Stay under their line all year: {under.map((a) => a.name).join(", ")}.</p>}
        </>
      )}
      <How
        works="Runs the year month by month: today's clients, expected wins from lead flow, churn, planned hires and leavers, and onboarding work for each new client. A team goes over when its average busy share passes its line. Hiring advice allows 2 months to hire."
        tells="when each team runs out of room, and when to start hiring so the new person arrives in time."
      />
    </Section>
  );
}
