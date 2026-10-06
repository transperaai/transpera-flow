// What the "Clients and servicing work" card shows (issue #41, part 2): the churn proposals and the three checks in plain
// words, and which proposals are ticked to start with. Framework-free so it can be unit tested.

import type { CalibrationProposal, ServicingCheckId } from "@transpera-flow/engine";
import { formatNumber } from "@/lib/format";

export const CHECK_ORDER: readonly ServicingCheckId[] = ["late", "resp", "onb"];

export const CHECK_LABELS: Record<ServicingCheckId, { title: string; unit: string; description: string; example: string }> = {
  late: {
    title: "Late or missed work",
    unit: "tasks",
    description:
      "The share of servicing tasks, among those due by the counted-up-to date, that were done after their due date or not done at all. A check only: it shows how the simulation compares with what happened, and never changes the model.",
    example: "38 of 250 tasks done after their due date or not at all: 15%. The simulation says 12% now.",
  },
  resp: {
    title: "Response time to ad-hoc requests",
    unit: "requests",
    description:
      "The average working hours from an ad-hoc request coming in to it being done. Without a requested column, a request counts as coming in one SLA before it was due, as in the simulation. A check only: it never changes the model.",
    example: "40 requests answered in 6.5 working hours on average. The simulation says 5 now.",
  },
  onb: {
    title: "Onboarding speed",
    unit: "new clients",
    description:
      "The average working days from a new client starting to their first delivery. Needs the clients file as well as the servicing log. A check only: it never changes the model.",
    example: "12 new clients got their first delivery after 8 working days on average. The simulation says 6 now.",
  },
};

export const CHURN_HELP = {
  normal: {
    title: "Normal churn",
    description:
      "The share of a service's clients who leave each month when nothing is going wrong. The churn in your file already includes what today's drivers add (late work, slow replies), so that part is taken out: normal churn × today's driver pressure gives the churn in the file.",
    example: "9 of 40 SEO clients left over a year: 2.2% a month. Today the drivers add 25%, so normal churn is 1.8%.",
  },
  drivers: {
    title: "Today's drivers",
    description: "How much today's switched-on drivers multiply churn in the simulation, without the market and any planned price rise.",
    example: "×1.25 means late work and slow replies add a quarter to normal churn.",
  },
  countedUpTo: {
    title: "Counted up to",
    description: "The date the clients file is true on. Clients with no end date are counted as clients up to it.",
    example: "Exported from your CRM on 30 September: pick 30 September.",
  },
} as const;

const day = (t: number) => new Date(t).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
export const formatAsOf = day;

/** "2.1% a month". */
export const formatChurn = (value: number | null | undefined): string => (value == null ? "—" : `${formatNumber(value * 100, 1)}% a month`);

/** "×1.25". */
export const formatMultiplier = (value: number | null | undefined): string => (value == null ? "—" : `×${formatNumber(value, 2)}`);

/** A check's value in its own unit: "15%", "6.5 working hours", "8 working days". */
export function formatCheckValue(id: ServicingCheckId, value: number | null): string {
  if (value === null) return "—";
  if (id === "late") return `${formatNumber(value * 100, 0)}%`;
  if (id === "resp") return `${formatNumber(value, 1)} working hours`;
  return `${formatNumber(value, 1)} working days`;
}

/** What the Churn drivers section adds to a driver's "now" line: " · history: 15% (250 tasks, to 30 Sep 2026)", or "". */
export function historyNote(id: string, history: { asOf: number; checks: readonly { id: string; n: number; value: number | null; enough: boolean }[] } | null | undefined): string {
  if (id !== "late" && id !== "resp" && id !== "onb") return "";
  const check = history?.checks.find((c) => c.id === id);
  if (!history || !check || !check.enough || check.value === null) return "";
  return ` · history: ${formatCheckValue(id, check.value)} (${formatNumber(check.n, 0)} ${CHECK_LABELS[id].unit}, to ${day(history.asOf)})`;
}

/** Can be applied: something is proposed and it changes the value. */
export const selectable = (p: CalibrationProposal): boolean => Boolean(p.set) && p.changed;

/** Ticked to start with: a real change to an estimate. A value someone entered or measured is never ticked for them. */
export const initiallySelected = (p: CalibrationProposal): boolean => selectable(p) && p.currentSource === "estimated";

const STATUS_WORDS: Record<string, string> = {
  changed: "changed since the file was read, so left as it is",
  not_found: "no longer in the workspace",
  already_applied: "already applied",
  not_proposed: "not proposed",
  invalid: "can't be applied",
};

/** One sentence about what applying did. */
export function applySummary(results: readonly { key: string; status: string }[], subjects: ReadonlyMap<string, string>): string {
  const applied = results.filter((r) => r.status === "applied").length;
  const skipped = results.filter((r) => r.status !== "applied");
  const head = applied ? `Normal churn updated for ${applied} service${applied === 1 ? "" : "s"}.` : "Nothing was applied.";
  const notes = skipped.map((r) => `${subjects.get(r.key) ?? r.key}: ${STATUS_WORDS[r.status] ?? r.status}`);
  return `${head}${notes.length ? ` ${notes.join("; ")}.` : ""}`;
}
