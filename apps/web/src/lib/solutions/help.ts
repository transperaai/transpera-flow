// The (i) texts of the Solutions list and the Solution page (issue #115, A50): plain English, with an example, for every
// control and rule on the screens. Kept apart from the components so the help tests can read them without loading the screens.

/** The list's controls and the parts of a card. */
export const SOLUTIONS_LIST_HELP = {
  newSolution: {
    label: "New solution",
    description: "First pick the open issue it is for, or log a new one. Then the Editor opens on a copy of that issue's process: change the steps, simulate, and save it as a solution. The live map and its draft don't change.",
    example: "Try an AI lead check before the sales call, save it as “AI lead qualifier”, and compare it with live.",
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

/** The Solution page's sections and controls (descoped in Q12 and QA round 2: the header's fixes, and the notes and sources). */
export const SOLUTION_PAGE_HELP = {
  solves: {
    label: "Solves",
    description: "The issues this solution was built to fix. A solution can fix more than one. Open an issue to see how it is getting on.",
    example: "“AI lead qualifier” fixes #15 (wait to first contact) and #17 (leads lost at Check fit).",
  },
  notes: {
    label: "Notes and sources",
    description: "What this solution changes and why, in your own words, and the sources that back it up. Click the notes to edit them, then press Save.",
    example: "Drops the manual enrichment step: the new tool fills in company size and industry before Check fit.",
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
