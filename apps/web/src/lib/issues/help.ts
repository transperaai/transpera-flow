// The (i) texts of the Issues pages (issue #113, A48): plain English, with an example, for every control. Kept apart from the
// components so the help tests can read them without loading the screens.

/** The (i) texts for the list's controls. */
export const LIST_HELP = {
  show: {
    label: "Open, Resolved and All",
    description: "Open shows issues still to deal with: Open and Testing solutions. Resolved shows the ones you resolved or decided not to fix. The number is how many each holds.",
    example: "Open 3 means three issues still need work. Resolved issues keep their full history.",
  },
  rating: {
    label: "Filter by rating",
    description: "Show only the issues with one rating. The number on each button is how many there are among the issues you are looking at. Click it again, or All, to see everything.",
    example: "Click Operational risk to see only the issues that could break delivery or lose clients.",
  },
  table: {
    label: "Reading the table",
    description: "Each row is one confirmed issue: its number and title, its rating, the steps it touches, who owns it, where it stands and how many solutions have been tested. The most serious come first, then the costliest.",
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
  changes: {
    label: "Changes anchored to this issue",
    description: "Sandbox automations and augmentations that name this issue as the one they fix. Each is run on its own against today: the hours it frees a month, and how many more clients the department could then hold.",
    example: "“Auto-collate reports”: 40 hours freed a month, +3 clients.",
  },
  history: {
    label: "History",
    description: "Everything that happened to this issue, oldest first: when it was logged, each edit, each solution tested, and when it was resolved or reopened. It stays after the issue is resolved.",
    example: "5 Oct · You · Logged. 9 Oct · You · Marked resolved by changing the process directly.",
  },
  target: {
    label: "Target",
    description: "What is measured to know the problem is fixed: where it was, where it is now and the goal. Solutions get an automatic pass or fail against the goal.",
    example: "Wait at Check fit: now 1.4 days, goal under 4 hours.",
  },
  owners: {
    label: "Owners",
    description: "The people responsible for sorting this out. Change them with Edit.",
    example: "Rosa Diaz and Priya Shah.",
  },
  linked: {
    label: "Linked to",
    description: "The process or the steps this issue is about. Steps listed here are outlined on the map above.",
    example: "Step: Audit & proposal.",
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
