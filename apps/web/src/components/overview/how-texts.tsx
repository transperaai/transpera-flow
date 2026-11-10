// The "How this works" words of the Overview's charts that load on their own (trend-charts.tsx, time-achieves.tsx), kept apart so
// the page can show them in each panel's header without pulling those charts into its first bundle.

import { CLIENT_JOB_PURPOSE, UPKEEP_PURPOSE, type PurposeCategory } from "@transpera-flow/db";

/** The purposes that count as client work. */
const CLIENT_WORK: readonly string[] = [CLIENT_JOB_PURPOSE, UPKEEP_PURPOSE];

/** "How this works" for the open issues: in its panel's header on the Overview. */
export const OPEN_ISSUES_HOW = {
  works:
    "Every issue that is open or being tested, from the Issues list: insights someone acknowledged and issues logged by hand. The bar counts them by rating, worst first; the processes with the most open issues are named, each linked to its page.",
  tells: "How many problems are open, how bad they are, and where to look first.",
};

/** "How this works" for the time split by process: in its panel's header on the Overview. */
export const TIME_SPLIT_HOW = {
  works:
    "For each process, the time a piece of work spends in it from the simulation, split three ways: someone working on it (hands-on), waiting for one of our people who is busy elsewhere, and waiting on the client or others (a fixed wait). The share at the right is the hands-on part. Slowest first.",
  tells: "Where work stands still, and whether the fix is our people's time or the wait on the client.",
};

/** "How this works" for what the time achieves: in its panel's header on the Overview. */
export function timeAchievesHow(span: string, categories: readonly PurposeCategory[]) {
  const names = CLIENT_WORK.map((k) => categories.find((c) => c.key === k)?.name ?? k);
  return {
    works: (
      <>
        The team&apos;s working time in the simulation over the next {span}, by what each step achieves, as a share of the hours available. Client work is
        &ldquo;{names[0]}&rdquo; plus &ldquo;{names[1]}&rdquo;; the line shows its share month by month. Hover a part of the bar for its hours.
      </>
    ),
    tells: "Whether the team's time goes on the work clients pay for, or on everything around it.",
  };
}

