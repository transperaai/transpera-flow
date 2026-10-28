// The (i) texts of the Solutions list and the Solution page (issue #115, A50): plain English, with an example, for every
// control and rule on the screens. Kept apart from the components so the help tests can read them without loading the screens.

/** The list's controls and the parts of a card. */
export const SOLUTIONS_LIST_HELP = {
  newSolution: {
    label: "New solution",
    description: "Opens the Editor on a copy of a process. Change the steps, simulate, and save it as a solution. The live map and its draft don't change, and you can link the solution to issues afterwards.",
    example: "Try an AI lead check before the sales call, save it as “AI lead qualifier”, and compare it with live.",
  },
  type: {
    label: "Solution type",
    description: "How the solution was made. “By hand” means someone built it in the Editor. “AI block” means it was built from a block the AI suggested.",
    example: "“AI lead qualifier” is an AI block. “Fast track for partner leads” was built by hand.",
  },
  changes: {
    label: "What it changes",
    description: "The process the solution is a copy of, and the steps it adds or changes. The live process stays as it is.",
    example: "Changes Sales · Check fit, Enrich lead.",
  },
  solves: {
    label: "Solves",
    description: "The issues this solution was built to fix, with one verdict each. The verdict is yours if you gave one, otherwise the automatic pass or fail from the simulation against that issue's target.",
    example: "“#15 Website leads wait too long · Pass” means the simulated wait met the goal of under 4 hours.",
  },
  open: {
    label: "Open",
    description: "Opens the solution's page: the issues it solves with their verdicts, your notes, and (soon) the maps side by side.",
    example: "Open “AI lead qualifier” to give your own verdict on issue #15.",
  },
} as const;

/** The Solution page's sections and controls. */
export const SOLUTION_PAGE_HELP = {
  built: {
    label: "Built by",
    description: "Who saved the solution, when, and which process it changes. It is a separate copy: the live version of that process is not touched.",
    example: "Built by You · 5 Oct · changes Sales.",
  },
  solves: {
    label: "Solves",
    description: "A solution can solve more than one issue. Each issue is judged against its own target, with an automatic verdict from the simulation and your own verdict, which is the final call.",
    example: "“AI lead qualifier” solves #15 (wait to first contact) and #17 (leads lost at Check fit).",
  },
  status: {
    label: "Issue status",
    description: "Where the issue stands now: Open, Testing solutions, Resolved or Won't fix. Linking a solution moves an Open issue to Testing solutions.",
    example: "Testing solutions means at least one solution is being tried against it.",
  },
  target: {
    label: "Target",
    description: "What is measured to know the issue is fixed, and the goal it must reach. The automatic verdict checks the simulation against this goal.",
    example: "Time to first contact, goal under 4 hours.",
  },
  automatic: {
    label: "Automatic verdict",
    description: "Pass or fail from simulating this solution 30 times against the issue's goal. “Not checked” means the goal is written in a way the simulation can't measure, so only your verdict counts.",
    example: "Pass: the simulated wait at Check fit averaged 3.1 hours against under 4 hours.",
  },
  holds: {
    label: "Holds in",
    description: "The share of the simulated runs that meet the goal. A pass that holds in 95% of runs is far safer than one that holds in 55%.",
    example: "Holds in 92% means 28 of 30 runs met the goal.",
  },
  yours: {
    label: "Your verdict",
    description: "Your own pass or fail, which is the final call. It is saved and written to the issue's history. Click the same button again to clear it.",
    example: "The simulation says pass, but you know Sales won't follow the new step: mark it Fail.",
  },
  issueNote: {
    label: "Your note on this issue",
    description: "A line about why you gave this verdict. It is saved with the verdict, and the history records that you changed it.",
    example: "Fine in a normal month, but nobody checks the new queue on Fridays.",
  },
  link: {
    label: "Link an issue",
    description: "Test this solution against another issue about the same process. It gets its own automatic verdict, and the issue moves to Testing solutions.",
    example: "Link “AI lead qualifier” to “Too many leads go cold” to see whether it helps there too.",
  },
  notes: {
    label: "Notes",
    description: "Anything worth knowing about the solution as a whole: what you tried, what to watch, who agreed. They are saved when you leave the box.",
    example: "Needs the enrichment tool trial extended to 30 days.",
  },
  never: {
    label: "Solutions never change the live map",
    description: "A solution is its own copy. To make one real, open the process in the Editor, build the new version and publish it. Then resolve the issue with this solution.",
    example: "Publishing Sales version 9 with the AI lead step, then marking issue #15 resolved by this solution.",
  },
  compare: {
    label: "Live vs this solution",
    description: "The two maps open and close together. Steps that are new or changed in the solution are marked on its map, and steps it removed show struck through. “Live” is the version of the process this solution was copied from, not whatever is live today, so the maps show exactly what the solution changed and match its automatic verdict. If the process has been published since, a note says so.",
    example: "Open Check fit on one side and the same group opens on the other; the new AI step is marked on the right.",
  },
  compareSide: {
    label: "Which map is which",
    description: "Left is the process as it was when this solution was copied from it. Right is the same process with the solution's changes. Click a group's arrow on either map to open or close it on both.",
    example: "Close Sales on the left and it closes on the right too.",
  },
  measures: {
    label: "Measures",
    description: "The same simulation run for live and for the solution, 30 times each, side by side. The last column says whether the solution is better or worse; a result inside the normal run-to-run spread is “About the same”.",
    example: "Cycle time 12 days live, 9 days with the solution: better.",
  },
  measuresChange: {
    label: "Better or worse",
    description: "Better when the solution is clearly ahead of live across the runs, Worse when clearly behind, and About the same when the difference could be chance. A cost with no right answer (labour) is not rated.",
    example: "Wins +1.2 is Better. New MRR −£300 is Worse.",
  },
  mrr: {
    label: "MRR over time",
    description: "Monthly recurring revenue month by month over the horizon you chose: live as a line with its 10 to 90% range, and with this solution as a dashed line. Each point comes from simulating that far ahead.",
    example: "After 12 months the solution is £4k a month ahead of live.",
  },
  stress: {
    label: "Market stress test",
    description: "Does the solution still work if the market changes? It is run again under each market condition on its own (Stable, Soft, Downturn, Boom and any of your own from Settings), and each linked issue's goal is checked the same way as the automatic verdict. Pass means every issue it could check still meets its goal. Each named market replaces your market schedule for the whole run, so Stable is a flat market, not your schedule; the “Your schedule” row, when you have one, is the schedule month by month, which is what the automatic verdict under Solves was checked against.",
    example: "Passes in Stable and Boom, fails in Downturn because first contact slips to 5 hours.",
  },
  stressResult: {
    label: "Result under a market",
    description: "Pass or fail for the issues this solution solves, with the market applied for the whole run. “Not checked” means no linked issue has a goal the simulation can measure.",
    example: "Downturn: Fail. Stable: Pass.",
  },
  stressNumber: {
    label: "Key number",
    description: "The number each result rests on, checked against the issue's goal, then monthly recurring revenue at the end of the horizon for the solution against live in that market.",
    example: "Wait at Check fit: 5.2 h on average, against under 4 hours. MRR £41k, live £38k.",
  },
} as const;

/** The pick in the Resolve dialog. */
export const RESOLVE_SOLUTION_HELP = {
  label: "Which solution?",
  description: "Pick the solution that fixed the issue. The issue's history and its resolved bar will say which one. Only solutions linked to this issue are listed, each with its verdict.",
  example: "“AI lead qualifier · PASS”, built into Sales version 8.",
} as const;

/**
 * The (i) on "✎ New solution on <process>", the button on a card and on the page. It starts a new solution from the live version of the
 * process: it does not open this solution's own changes (they are not carried over yet).
 */
export const newOnProcessHelp = (process: string) =>
  ({
    label: `New solution on ${process}`,
    description: `Starts a new solution from the live version of ${process}. This solution's changes are not carried over yet; that comes later.`,
    example: "Start again from live and try keeping the manual check for large leads.",
  }) as const;
