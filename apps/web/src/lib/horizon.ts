// The time horizon people pick (issue #123, A58): 1, 3, 6, 12 or 24 months. The engine runs in weeks, so a
// choice of months becomes weeks at 52 a year; 3 months is 13 weeks, the workspace default. Pure: no React.

/** The options the picker offers, shortest first. 24 is the length of a market schedule (A57). */
export const HORIZON_MONTHS = [1, 3, 6, 12, 24] as const;
export type HorizonMonths = (typeof HORIZON_MONTHS)[number];

/** The horizon of a run for a number of months (4, 13, 26, 52, 104 weeks): one source, in the Sandbox runner's months module. */
export { horizonWeeks } from "@transpera-flow/db/sandbox";
import { horizonWeeks } from "@transpera-flow/db/sandbox";

export const isHorizonMonths = (n: number): n is HorizonMonths => (HORIZON_MONTHS as readonly number[]).includes(n);

/** The option whose length is `weeks`, or null when it isn't one of them (a workspace set to, say, 20 weeks). */
export function monthsForWeeks(weeks: number): HorizonMonths | null {
  return HORIZON_MONTHS.find((m) => horizonWeeks(m) === weeks) ?? null;
}

/** "24 months", "1 month". */
export const horizonLabel = (months: number): string => `${months} month${months === 1 ? "" : "s"}`;
