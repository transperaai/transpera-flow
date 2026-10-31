import { Info } from "lucide-react";
import { withClientGroups, type EngineModel, type SimulationResult } from "@transpera-flow/engine";
import { PayHidden } from "@/components/pay-hidden";
import { Card } from "@/components/ui/card";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatCurrency, formatDays, formatInitialState, formatNumber, formatPercent, formatRange } from "@/lib/format";

interface KpiStripProps {
  model: EngineModel;
  currency: string;
  result: SimulationResult | null;
  status: "running" | "done" | "error";
  durationMs?: number;
}

interface Tile {
  label: string;
  value: string;
  detail: string;
  /** What the figure means (docs/PRD.md §13), shown in a tooltip. */
  definition?: string;
  tone?: "crit";
  /** The figure needs people's pay, which this viewer may not see: "—" and an (i), not a number. */
  payHidden?: boolean;
}

export function KpiStrip({ model, currency, result, status, durationMs }: KpiStripProps) {
  const k = result?.kpi;
  const whole = (v: number) => formatNumber(v, 0);
  const days = (h: number) => formatDays(h, model.hoursPerWeek);
  const money = (v: number) => formatCurrency(v, currency);
  const bnId = result?.bnRole ?? null;
  const bn = bnId ? k?.roles[bnId] : undefined;
  const weeks = model.horizonWeeks;
  // Clients counted per service become unnamed roster clients in the run (issue #120).
  const hasClients = withClientGroups(model).clients !== undefined;

  const hours = (v: number) => `${formatNumber(v, 0)} h`;
  const cap = model.overtimeCap ?? 0;
  const overtime = k?.overtimeHours;
  const overtimeCost = k?.overtimeCost;
  // Two rows: the flow and the overtime it takes, then the revenue it brings in and the overtime's cost.
  const tiles: Tile[] = [
    { label: `Wins / ${weeks} wks`, value: k ? formatNumber(k.won.mean) : "–", detail: k ? formatRange(k.won, whole) : "" },
    { label: "Lost", value: k ? whole(k.lost.mean) : "–", detail: k ? formatRange(k.lost, whole) : "" },
    {
      label: "Cycle time",
      value: k ? days(k.cycle.mean) : "–",
      detail: k ? `P50 ${days(k.cycle.p50)} · P90 ${days(k.cycle.p90)}` : "",
    },
    {
      label: "Bottleneck",
      value: bnId ? (model.roles[bnId]?.name ?? "–") : "–",
      detail: bn ? `${formatPercent(bn.util.mean)} utilised · ${formatRange(bn.util, formatPercent)}` : "",
      tone: bn && bn.util.mean > 0.85 ? "crit" : undefined,
    },
    {
      label: `Overtime / ${weeks} wks`,
      value: overtime ? hours(overtime.mean) : "–",
      detail: overtime ? (cap > 0 ? formatRange(overtime, hours) : "none allowed (cap 0%)") : "",
      definition:
        "Hours worked beyond people's weeks to keep up with client work, up to the workspace's overtime cap. Beyond the cap, utilisation shows above 100%.",
      tone: overtime && overtime.mean > 0 ? "crit" : undefined,
    },
    {
      label: "New MRR",
      value: k ? money(k.mrrAdded.mean) : "–",
      detail: k ? formatRange(k.mrrAdded, money) : "",
      definition: "Monthly fees of the retainer clients won in the horizon.",
    },
    {
      label: `Billed / ${weeks} wks`,
      value: k ? money(k.billed.mean) : "–",
      detail: k ? formatRange(k.billed, money) : "",
      definition: hasClients
        ? "Revenue billed within the horizon: every client's monthly fee for the weeks it stays (existing clients at their fee, new wins at their service's price), stopping when it churns; one-off projects bill when won."
        : "Revenue billed within the horizon by the clients won in it, net of churn; one-off projects bill when won. Count your clients per service in Settings to include existing clients.",
    },
    {
      label: "LTV added",
      value: k ? money(k.ltvAdded.mean) : "–",
      detail: k ? formatRange(k.ltvAdded, money) : "",
      definition: "For each new win: price × expected tenure (retainers) or the price (one-off).",
    },
    {
      label: "Lost revenue",
      value: k ? money(k.lostRevenue.mean) : "–",
      detail: k ? formatRange(k.lostRevenue, money) : "",
      definition: "For each lost lead: what it would have been worth if won (price × expected tenure for retainers).",
    },
    {
      label: "Overtime cost",
      value: overtimeCost ? money(overtimeCost.mean) : "–",
      detail: overtimeCost ? formatRange(overtimeCost, money) : "",
      payHidden: Boolean(k && model.payHidden),
      definition: "Overtime hours × each person's cost rate (their role's when they have none).",
    },
  ];
  // Retention (docs/PRD.md §6.3.5, §13; issue #19): with a client roster, who is at risk and who leaves.
  if (hasClients) {
    const risk = k?.clientsAtRisk;
    const churned = k?.clientsChurned;
    const touch = k?.touchpoints;
    tiles.push(
      {
        label: "Clients at risk",
        value: risk ? formatNumber(risk.mean) : "–",
        detail: risk ? formatRange(risk, whole) : "",
        definition:
          "Active clients whose simulated health ends the horizon below 50. Health starts from the client groups' starting health (80 if not entered), recovers when servicing tasks are done on time and drops when they are late or missed.",
        tone: risk && risk.mean >= 1 ? "crit" : undefined,
      },
      {
        label: `Churned / ${weeks} wks`,
        value: churned ? formatNumber(churned.mean) : "–",
        detail: touch && touch.onTime.mean + touch.late.mean + touch.missed.mean > 0
          ? `touchpoints: ${whole(touch.late.mean)} late · ${whole(touch.missed.mean)} missed`
          : churned
            ? formatRange(churned, whole)
            : "",
        definition:
          "Clients who leave in the horizon. Monthly churn = the service's base × (1 + sensitivity × (100 − health) / 100), so late and missed servicing raise it.",
      },
    );
  }

  return (
    <div>
      <section
        aria-label="Key results"
        tabIndex={0}
        className={`flex snap-x gap-2 overflow-x-auto pb-1 xl:grid xl:overflow-visible ${tiles.length > 10 ? "xl:grid-cols-6" : "xl:grid-cols-5"}`}
      >
        {tiles.map((t) => (
          <Card key={t.label} className="min-w-40 shrink-0 snap-start gap-0.5 rounded-lg px-3 py-2.5 shadow-token xl:min-w-0">
            <p className="flex items-center justify-between gap-1 font-mono text-2xs uppercase tracking-widest text-muted-foreground">
              <span className="truncate">{t.label}</span>
              {t.definition && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button type="button" aria-label={`What ${t.label} means`} className="shrink-0 rounded-sm text-muted-foreground hover:text-foreground">
                      <Info className="size-3.5" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent className="max-w-64 normal-case tracking-normal">{t.definition}</TooltipContent>
                </Tooltip>
              )}
            </p>
            <p className={`truncate font-display text-xl font-bold tabular-nums ${t.tone === "crit" ? "text-crit" : ""}`}>{t.payHidden ? <PayHidden /> : t.value}</p>
            <p className="text-xs text-muted-foreground tabular-nums">{t.detail}&nbsp;</p>
          </Card>
        ))}
      </section>
      <p role="status" aria-live="polite" className="mt-1.5 text-xs text-muted-foreground">
        {status === "running"
          ? "Simulating…"
          : status === "error"
            ? "Simulation failed"
            : `Average of ${result?.reps} replications; ranges are the 10th–90th percentile · ${formatNumber(durationMs ?? 0, 0)} ms`}
        {status === "done" && result && ` · ${formatInitialState(result.initialState, model.hoursPerWeek)}`}
      </p>
    </div>
  );
}
