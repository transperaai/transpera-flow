// The (i) texts of the Issues pages (issue #113, A48): plain English, with an example, for every control. Kept apart from the
// components so the help tests can read them without loading the screens.

/** The (i) texts for the list's controls. */
export const LIST_HELP = {
  show: {
    label: "Filter by status",
    description: "Tick the statuses to show. Open and Testing solutions are issues still to deal with; Resolved and Won't fix are closed. The number is how many issues each would show with your other filters.",
    example: "Tick Resolved as well to see the ones you have already closed alongside the open ones.",
  },
  owner: {
    label: "Filter by owner",
    description: "Show only the issues one or more people own. Unassigned finds the issues nobody owns yet.",
    example: "Tick Rosa and Unassigned to see her issues and the ones still to be given out.",
  },
  rating: {
    label: "Filter by rating",
    description: "Show only the issues with the ratings you tick. The number beside each is how many there are with your other filters. Untick them all to see every rating.",
    example: "Tick Operational risk to see only the issues that could break delivery or lose clients.",
  },
  process: {
    label: "Filter by process",
    description: "Show only the issues about the processes you tick, whether they sit on a step or on the whole process.",
    example: "Tick Monthly reporting to see its issues only.",
  },
  table: {
    label: "Reading the table",
    description: "Each row is one confirmed issue: its number and title, its rating, the step it is about, who owns it, where it stands and how many solutions have been tested. The most serious come first, then the costliest.",
    example: "“#2 Only Maya can do Audit & proposal · Bad · Audit & proposal · Rosa · Testing solutions · 1 tested”.",
  },
  solutions: {
    label: "Solutions tested",
    description: "How many solutions have been built and tested against this issue, with a tick when one passed. “None yet” means nobody has tried a fix.",
    example: "“2 tested ✓” means two solutions were tried and one passed.",
  },
  newIssue: {
    label: "New issue",
    description: "Add a problem you found yourself, such as one from an interview. You say what is wrong, how bad it is, what it touches and who owns it.",
    example: "“Clients wait too long to hear back”, touching the whole Sales process.",
  },
} as const;

/** The (i) texts for the Issue page's controls and sections. */
export const ISSUE_PAGE_HELP = {
  edit: {
    label: "Edit",
    description: "Change the title, rating, what it touches, owners, target or sources. Every change is added to the history.",
    example: "Add Priya as a second owner once she takes over the follow-up.",
  },
  resolve: {
    label: "Mark resolved",
    description: "Close the issue and say how it was resolved. It leaves the map and the open list, but keeps its history. You can reopen it later.",
    example: "Mark “Proposals wait too long” resolved after you changed the review step in the Editor.",
  },
  reopen: {
    label: "Reopen",
    description: "Set a resolved issue back to Open because the problem is back. The history keeps both the resolution and the reopening.",
    example: "Reopen “Leads wait too long” when the wait creeps back up after a busy month.",
  },
  build: {
    label: "Build solution",
    description: "Opens the Editor on a copy of the process with this issue's steps outlined, so you can try a fix without touching the live process.",
    example: "Copy Sales, add a lead-scoring step, and see whether the wait drops under the goal.",
  },
  where: {
    label: "Where this issue sits",
    description: "The process map with the steps this issue touches outlined and the rest dimmed. Groups holding those steps are opened for you. Other open issues still show as badges.",
    example: "An issue on Check fit outlines that step inside its group.",
  },
  wrong: {
    label: "What's wrong",
    description: "What you saw or heard, and where, so others can trust the issue. If it came from an insight, that insight's evidence is here.",
    example: "Audit interview, 12 Sep: 5 to 8 hours per proposal, and 15% go back for rework.",
  },
  solutions: {
    label: "Solutions tested",
    description: "Every solution built for this issue, with an automatic pass or fail against its target, how often that holds across the simulated runs, and your own verdict. You make the final call.",
    example: "“Lead scoring”: automatic pass, holds in 92% of runs, your verdict pass.",
  },
  owners: {
    label: "Owners",
    description: "The people responsible for sorting this out. Change them with Edit.",
    example: "Rosa Diaz and Priya Shah.",
  },
  sources: {
    label: "Sources",
    description: "Interviews, notes and documents that back the issue up. Link another one with + Link.",
    example: "Interview with Maya Collins: “I review every report before it goes out.”",
  },
  link: {
    label: "Link a source",
    description: "Attach an interview, note or document from your sources to this issue, so others can check it. The link is added to the history.",
    example: "Link Maya's interview to “Proposals wait too long”.",
  },
} as const;

/** The (i) texts for the Resolve dialog: what each control does, in plain words, with an example. */
export const RESOLVE_HELP = {
  how: {
    label: "How was it resolved?",
    description: "Say what fixed the problem, so the history tells the story later. The issue leaves the map and the open list either way, and keeps its history.",
    example: "“We changed the process directly” when someone fixed it in the Editor without building a separate solution.",
  },
  solution: {
    label: "A solution fixed it",
    description: "Pick this when one of the solutions you tested is the fix, and you have built it into the live process. Then choose which solution it was: the issue and its history will name it.",
    example: "“Lead scoring” passed its test, and you built it into the live process.",
  },
  process: {
    label: "We changed the process directly",
    description: "Pick this when you edited the live process yourself and did not use a separate solution.",
    example: "You removed the manual review step in the Editor.",
  },
  gone: {
    label: "No longer a problem",
    description: "Pick this when something else changed, or it was a one-off, so there is nothing left to fix.",
    example: "The client who caused the delays left, and the wait is back to normal.",
  },
  note: {
    label: "Note",
    description: "A line for whoever reads the history later: what changed, and where. It is optional.",
    example: "Built into Sales version 8.",
  },
} as const;
