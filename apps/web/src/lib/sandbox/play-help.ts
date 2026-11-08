// The (i) help for the Sandbox's result cards (D54): what the card shows and how to read the dashed line.

import type { HelpProps } from "@/components/help";

type Entry = Pick<HelpProps, "label" | "description" | "example">;

export const PLAY_HELP = {
  overloaded: {
    label: "Who's overloaded, and when",
    description:
      "Every team, month by month, coloured by how busy it is against its utilisation threshold: green is under, amber is within 10 points, red is at or over. The utilisation threshold is how busy a role can be before it counts as full (85% by default, set per role under Set up → People & roles). The switch flips between this scene and today's path. It covers the next 12 months; the worst of them, the month with the most people over their own threshold, is named above it and outlined.",
    example: "“Worst month: May 2027 · 4 people over their utilisation threshold. Strategists 2, PPC 2 · today's path: 2 in Apr 2027” means the scene makes the worst month worse, and a month later.",
  },
  clients: {
    label: "Clients by department",
    description: "Active clients each month in each department. The solid line is this scene; the dashed line is today's path, in the same colour. Where they match, nothing has changed.",
    example: "If the solid Organic line sits above its dashed one, this scene keeps more of those clients.",
  },
  retainers: {
    label: "MRR",
    description: "MRR (monthly recurring revenue): what clients pay each month. The solid line is this scene; the dashed line is today's path.",
    example: "A solid line ending above the dashed one means a higher monthly income by the end of the months shown. Under the chart, “Added over the 36 months” adds up the extra MRR, month by month.",
  },
  dler: {
    label: "DLER by department",
    description: "MRR divided by salaries, for each department, against the goal line. Higher is better. The solid line is this scene; the dashed line is today's path.",
    example: "A solid line that stays under the goal line means that department's salaries are too heavy for what clients pay.",
  },
  time: {
    label: "Where the time goes",
    description: "The team's working hours in a month, on average over the months shown, split by what the work achieves: a bar each for today's path and this scene, in the same order and colours. Under them are the purposes that moved most, in hours a month.",
    example: "“Fixing −40 h” means the team spends 40 fewer hours a month redoing work than it does today.",
  },
  horizon: {
    label: "How far ahead",
    description: "How many months the clients, MRR and DLER charts and where the time goes cover: 12 to 60. A longer run takes longer to work out after each change. Each chart says how far this scene is ahead of today's path at the end. The heatmap of who's overloaded stays on the next 12 months.",
    example: "Pick 36 to see whether an automation that slows the first months down pays off over three years.",
  },
} satisfies Record<string, Entry>;
