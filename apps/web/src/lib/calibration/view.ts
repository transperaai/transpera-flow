// What the Calibration page shows (issue #41): the proposals grouped by what they measure, in plain words, and which
// are ticked to start with. Framework-free so it can be unit tested.

import type { CalibrationKind, CalibrationProposal, CalibrationValueSource } from "@transpera-flow/engine";
import { formatNumber, formatPercent } from "@/lib/format";

export const KIND_ORDER: readonly CalibrationKind[] = ["arrivals", "work", "wait", "rework", "routing"];

export const KIND_LABELS: Record<CalibrationKind, { title: string; description: string; example: string }> = {
  arrivals: {
    title: "Leads a week",
    description:
      "How many new leads each source brings, from when items first appear in the log. Seasonality you have set is taken out, and the share that qualify is kept, so the qualified leads reaching the process match the log.",
    example: "24 items over 12 weeks from Website, with half of Website's leads qualifying, gives 4 leads a week.",
  },
  work: {
    title: "Hands-on time",
    description: "The average hours spent working on each step, from the hours column, and how much they vary from item to item.",
    example: "Proposals logged at 3, 4 and 5 hours give 4 hours, varying by about a quarter either way.",
  },
  wait: {
    title: "Waiting time",
    description:
      "How long items wait at a step nobody works on, such as a client deciding, from when the visit started to when it finished. Calendar time is counted in working hours at your hours per week.",
    example: "Clients taking 3 calendar days to decide is about 17 working hours at 40 hours a week.",
  },
  rework: {
    title: "Done again",
    description: "The share of visits to a step that had to be done again straight away: the same item logged at the same step twice in a row.",
    example: "2 of 16 audits redone gives 13%.",
  },
  routing: {
    title: "Which way items go",
    description: "At a step with more than one way out, the share of items that went each way, from the step each item was logged at next.",
    example: "20 qualified leads going on to a call and 10 lost gives 67% and 33%.",
  },
  // Part 2 (clients file): shown on its own card, never among part 1's step-log groups (KIND_ORDER leaves it out).
  churn: {
    title: "Normal churn",
    description:
      "The share of a service's clients who leave each month when nothing is going wrong. The churn in your file already includes what today's drivers add (late work, slow replies), so that part is taken out: normal churn × today's driver pressure gives the churn in the file.",
    example: "9 of 40 SEO clients left over a year: 2.2% a month. Today the drivers add 25%, so normal churn is 1.8%.",
  },
};

export const SOURCE_LABELS: Record<CalibrationValueSource, string> = { estimated: "Estimated", entered: "Entered", measured: "Measured" };

/** Ticked to start with: a real change to an estimate. Values someone entered or measured are never ticked for them. */
export function initiallySelected(p: CalibrationProposal): boolean {
  return selectable(p) && p.currentSource === "estimated";
}

/** Can be applied: something is proposed and it changes the value. */
export const selectable = (p: CalibrationProposal): boolean => Boolean(p.set) && p.changed;

export function groupProposals(proposals: readonly CalibrationProposal[]): { kind: CalibrationKind; proposals: CalibrationProposal[] }[] {
  return KIND_ORDER.map((kind) => ({ kind, proposals: proposals.filter((p) => p.kind === kind) })).filter((g) => g.proposals.length > 0);
}

const spread = (cv: number | null | undefined) => (cv === null || cv === undefined ? null : `±${formatPercent(cv)}`);

/** A value as the page shows it: "2.5 h ±30%", "13%", "6.5 a week"; routing is shown per branch. */
export function formatValue(kind: CalibrationKind, value: number | null, cv?: number | null): string {
  if (value === null) return "—";
  if (kind === "work" || kind === "wait") return [`${formatNumber(value, 2)} h`, spread(cv)].filter(Boolean).join(" ");
  if (kind === "rework") return formatPercent(value);
  if (kind === "arrivals") return `${formatNumber(value, 2)} a week`;
  return formatPercent(value);
}

export type ApplyStatus = "applied" | "changed" | "not_found" | "already_applied" | "not_proposed" | "switched_off";

const STATUS_WORDS: Record<Exclude<ApplyStatus, "applied">, string> = {
  changed: "changed since the log was read, so left as it is",
  not_found: "no longer in the process",
  already_applied: "already applied",
  not_proposed: "not proposed",
  switched_off: "per-person times are switched off",
};

/** One sentence about what applying did. */
export function applySummary(results: readonly { key: string; status: string }[], subjects: Map<string, string>, draftNumber: number | null): string {
  const applied = results.filter((r) => r.status === "applied");
  const skipped = results.filter((r) => r.status !== "applied");
  // Per-person times (#227) are live and count apart: they never go into the draft.
  const people = applied.filter((r) => r.key.startsWith("factor:")).length;
  const steps = applied.filter((r) => !r.key.startsWith("arrivals:") && !r.key.startsWith("factor:")).length;
  const leads = applied.length - steps - people;
  const parts: string[] = [];
  if (steps) parts.push(`${steps} change${steps === 1 ? "" : "s"} to steps went into the draft${draftNumber ? ` (version ${draftNumber})` : ""}. Publish it to use them`);
  if (leads) parts.push(`${leads} lead source${leads === 1 ? "" : "s"} updated`);
  if (people) parts.push(`${people} per-person time${people === 1 ? "" : "s"} set`);
  if (!applied.length) parts.push("Nothing was applied");
  const notes = skipped.map((r) => `${subjects.get(r.key) ?? r.key}: ${STATUS_WORDS[r.status as Exclude<ApplyStatus, "applied">] ?? r.status}`);
  return `${parts.join(". ")}.${notes.length ? ` ${notes.join("; ")}.` : ""}`;
}

/** "12 weeks, 2 Mar to 25 May 2026". */
export function formatWindow(window: { from: number; to: number; weeks: number } | null): string {
  if (!window) return "no dates";
  const day = (t: number) => new Date(t).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  return `${formatNumber(window.weeks, 1)} weeks, ${day(window.from)} to ${day(window.to)}`;
}
