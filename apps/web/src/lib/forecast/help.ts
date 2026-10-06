// The (i) help for the plan bar, the marker dialog and the compare view (B7, issue #36): plain English, with an example.

import type { HelpProps } from "@/components/help";

type Entry = Pick<HelpProps, "label" | "description" | "example">;

export const PLAN_HELP = {
  plan: {
    label: "Plan",
    description:
      "A plan is a set of changes you're thinking about: people you might hire, leave someone might take, solutions you might put live. The forecast runs with them so you can see what they do. Plans don't change your live model.",
    example: "“Hire in March” adds a PPC specialist from 1 March and shows who is still too busy before then.",
  },
  add: {
    label: "Add to the plan",
    description: "Put a hire, someone's leave, or a solution going live on the plan. Each shows as a marker on the “Your plan” row, which you can drag along the months. The forecast re-runs when you drop it.",
    example: "Add a hire, then drag it from March to January to see if that is early enough.",
  },
  save: {
    label: "Saving a plan",
    description: "Saving keeps the plan and its markers under its name, for you and anyone else who edits this workspace. Only the markers are saved: the numbers are worked out again each time.",
    example: "Save “Hire in March”, come back next week and it runs again with whatever the model is by then.",
  },
  compare: {
    label: "Compare plans",
    description: "Put two saved plans side by side: recurring revenue, clients at risk and how busy each role gets, month by month. “No changes” is your live model.",
    example: "Compare “Hire in January” with “Hire in March” to see what two extra months of waiting costs.",
  },
  planA: {
    label: "Plan A",
    description: "The first plan to compare. Pick “No changes” to compare against your live model.",
    example: "“No changes” against “Hire in March” shows what the hire adds.",
  },
  planB: {
    label: "Plan B",
    description: "The second plan to compare. Differences are always plan B minus plan A.",
    example: "With A as “Hire in January” and B as “Hire in March”, a −£1.2K means March brings in £1.2K less that month.",
  },
  revenue: {
    label: "Monthly recurring revenue",
    description: "What your clients pay each month, from the active clients' fees, month by month. The band is the middle 80% of the 30 simulated runs.",
    example: "£48.2K (£46.9K–£49.5K) means most runs land between those two.",
  },
  atRisk: {
    label: "Clients at risk",
    description: "How many clients in each group have health below 50 in that month, on average across the runs. Unhappy clients are more likely to leave.",
    example: "PPC 3.4 means about three or four PPC clients are unhappy that month.",
  },
  busy: {
    label: "How busy each role gets",
    description: "Work as a share of the hours the role has that month, with overtime. Above the dashed line the role is too busy.",
    example: "92% means 37 of 40 hours are taken.",
  },
  difference: {
    label: "Difference",
    description:
      "Plan B's average minus plan A's. Both plans use the same random runs, so a difference comes from the plans, not from chance. Each plan's own range is beside it.",
    example: "+£1.2K means plan B brings in £1.2K more that month on average.",
  },
  // The marker dialog.
  hireRole: {
    label: "Role",
    description: "The role the new person works in. They take that role's share of the work from the month they start.",
    example: "A PPC specialist starting in March takes on PPC work from 1 March.",
  },
  hireStarts: {
    label: "Starts in",
    description: "The month they start. They count from the 1st of that month.",
    example: "January means from 1 January.",
  },
  hireFte: {
    label: "FTE",
    description: "How much of a full working week they work. 1 is full time, 0.5 is half time.",
    example: "0.6 is three days a week.",
  },
  hireName: {
    label: "Name",
    description: "What to call them on the plan. Leave it empty and the plan says “New” and the role.",
    example: "“Jade” shows as Jade; empty shows as New PPC specialist.",
  },
  leavePerson: {
    label: "Person",
    description: "Who is away. Their work goes to the others in their role while they're gone.",
    example: "If Leah is away, Dan picks up her clients' account work.",
  },
  leaveFrom: {
    label: "From",
    description: "The Monday the leave starts. A date in the middle of a week moves back to that week's Monday.",
    example: "From 14 December for 3 weeks is back on 4 January.",
  },
  leaveFor: {
    label: "For",
    description: "How many whole weeks the leave lasts, from 1 to 52.",
    example: "From 14 December for 3 weeks is back on 4 January.",
  },
  solutionPick: {
    label: "Solution",
    description: "A solution you've built and saved. From the month it goes live, the forecast uses the solution's map instead of the live one.",
    example: "“Faster PPC campaign setup” from April: April onwards runs with the faster setup.",
  },
  solutionFrom: {
    label: "Live from",
    description:
      "From this month on, the forecast follows a run with the solution in place. Busy levels change from that month; client numbers and revenue carry on from where they were and change from there.",
    example: "Live from April: January to March are the same as without it.",
  },
} as const satisfies Record<string, Entry>;
