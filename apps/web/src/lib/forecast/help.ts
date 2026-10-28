// The (i) help for the Sandbox: the scenario bar, the change dialog and the compare view (plain English, with an example).

import type { HelpProps } from "@/components/help";

type Entry = Pick<HelpProps, "label" | "description" | "example">;

export const SANDBOX_HELP = {
  scenario: {
    label: "Scenario",
    description:
      "A scenario is a set of changes you're thinking about: a hire, a price change, a solution going live. The Sandbox runs your live model with them so you can see what they do. Scenarios never change your live model.",
    example: "“Hire in March” adds a PPC specialist from 1 March and shows who is still too busy before then.",
  },
  changes: {
    label: "Changes",
    description: "Each change is one lever with a value. It applies to the whole run, or from a month you pick. A scenario that builds on another starts with the other's changes (shown in grey) and adds its own.",
    example: "“Fees ×1.08 from July” raises what new clients pay from July.",
  },
  save: {
    label: "Saving a scenario",
    description: "Saving keeps the scenario and its changes under its name, for you and anyone else who edits this workspace. Only the changes are saved: the numbers are worked out again each time, against your live model of the day.",
    example: "Save “Hire in March”, come back next week and it runs again with whatever the model is by then.",
  },
  buildOn: {
    label: "Build on",
    description: "A new scenario that starts from this one. It keeps a link, so changing the first changes the second too.",
    example: "“Plan B” = “Plan A” plus a price rise: change Plan A's hire and Plan B follows.",
  },
  compare: {
    label: "Compare",
    description: "Put up to three saved scenarios side by side with “No changes” (your live model): recurring revenue, clients, clients at risk and how busy each role gets, month by month.",
    example: "Compare “Hire in January” with “Hire in March” to see what two extra months of waiting costs.",
  },
  difference: {
    label: "Difference",
    description:
      "Each scenario's average minus “No changes”. Every column uses the same random runs, so a difference comes from the changes, not from chance. Each column's own range is beside it.",
    example: "+£1.2K means that scenario brings in £1.2K more that month on average.",
  },
  revenue: {
    label: "Monthly recurring revenue",
    description: "What your clients pay each month, from the active clients' fees, month by month. The band is the middle 80% of the 30 simulated runs.",
    example: "£48.2K (£46.9K–£49.5K) means most runs land between those two.",
  },
  clients: {
    label: "Active clients",
    description: "How many clients you have each month, by type of service, on average across the runs.",
    example: "SEO 18.4 means about eighteen SEO clients that month.",
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
  hidden: {
    label: "Hidden in Settings, Levers",
    description: "This kind of change is switched off for new changes in Settings, Levers. Saved changes of that kind still apply, so hiding a lever never quietly changes a scenario.",
    example: "A saved price change keeps working after “Prices” is hidden.",
  },
  viewers: {
    label: "Numbers for Viewers",
    description: "A Viewer's numbers can differ slightly from an Agency admin's: a Viewer's view carries no per-person times, so everyone works at the standard speed.",
    example: "If an admin has set Dan to work 20% faster, only the admin's run knows it.",
  },
  // The change dialog.
  lever: {
    label: "What to change",
    description: "The lever to move. Levers that wouldn't move the result in this model are greyed, with the reason.",
    example: "“Base churn” is greyed when your clients are counted per service: change them in Settings, Clients.",
  },
  target: {
    label: "On",
    description: "What the change points at: a role, a person, a step, a service or a solution. “The busiest role” and “the heaviest step” are worked out against the model each time.",
    example: "“The heaviest step” follows whichever step takes the most hands-on hours.",
  },
  how: {
    label: "How",
    description: "Set a value, multiply what is there, or add to it. Multiplying keeps its meaning when the model is measured again.",
    example: "×0.6 on a step is 40% less hands-on time, whatever it is today.",
  },
  when: {
    label: "When",
    description: "The whole run, or from the 1st of a month. Leave starts on a Monday. A change from a month runs the model once more from then on.",
    example: "From July: January to June are the same as without it.",
  },
  hireRole: {
    label: "Role",
    description: "The role the new person works in. They take that role's share of the work from the month they start.",
    example: "A PPC specialist starting in March takes on PPC work from 1 March.",
  },
  hireFte: {
    label: "FTE",
    description: "How much of a full working week they work. 1 is full time, 0.5 is half time.",
    example: "0.6 is three days a week.",
  },
  hireName: {
    label: "Name",
    description: "What to call them. Leave it empty and the scenario says “New” and the role.",
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
    description: "A solution you've built and saved. From the month it goes live, the run uses the solution's map instead of the live one.",
    example: "“Faster PPC campaign setup” from April: April onwards runs with the faster setup.",
  },
} as const satisfies Record<string, Entry>;
