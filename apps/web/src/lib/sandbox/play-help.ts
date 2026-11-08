// The (i) help for the Sandbox's result cards (D54): what the card shows and how to read the dashed line.

import type { HelpProps } from "@/components/help";

type Entry = Pick<HelpProps, "label" | "description" | "example">;

export const PLAY_HELP = {
  overloaded: {
    label: "Who's overloaded, and when",
    description:
      "Every team, month by month, coloured by how busy it is against its utilisation threshold: green is under, amber is within 10 points, red is at or over. The utilisation threshold is how busy a role can be before it counts as full (85% by default, set per role under Set up → People & roles). The switch flips between this scene and today's path. The bars under it count the people over their own threshold each month: today is grey, this scene is coloured.",
    example: "A red square for Design in March means the team is at or over its utilisation threshold that month. The grey bar for March is 2 people today; if the coloured one is 4, the scene adds two.",
  },
  clients: {
    label: "Clients by department",
    description: "Active clients each month in each department. The solid line is this scene; the dashed line is today's path, in the same colour. Where they match, nothing has changed.",
    example: "If the solid Organic line sits above its dashed one, this scene keeps more of those clients.",
  },
  retainers: {
    label: "MRR",
    description: "MRR (monthly recurring revenue): what clients pay each month. The solid line is this scene; the dashed line is today's path.",
    example: "A solid line ending above the dashed one means a higher monthly income by the end of the year.",
  },
  dler: {
    label: "DLER by department",
    description: "MRR divided by salaries, for each department, against the goal line. Higher is better. The solid line is this scene; the dashed line is today's path.",
    example: "A solid line that stays under the goal line means that department's salaries are too heavy for what clients pay.",
  },
  time: {
    label: "Where the time goes",
    description: "The team's working hours in a month, split by what the work achieves, for today's path and for this scene. Next to them are the purposes that moved most, in hours a month.",
    example: "“Fixing −40 h” means the team spends 40 fewer hours a month redoing work than it does today.",
  },
} satisfies Record<string, Entry>;
