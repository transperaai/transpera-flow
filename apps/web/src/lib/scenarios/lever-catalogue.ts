// The levers people can switch on or off (Settings -> Levers, issue #123, A58): every input you can change when
// testing, in the prototype's six groups, each with its plain-English description and an example. Wording follows
// the prototype (apps/web/prototype/app-flow.html, LEVERS). A "lever" here is a kind of input ("Time each step
// takes"); the sliders on a process page are generated per step, role or person (levers.ts) and each belongs to one
// kind, so hiding a kind hides all its sliders. Pure: no React, so the wording and the mapping are unit-tested.

import { GROUP_LABELS, type Lever, type LeverGroup } from "./levers";

export const LEVER_GROUP_ORDER: readonly LeverGroup[] = ["demand", "people", "process", "clients", "finances", "market"];

/** Where a lever kind can be changed today. */
export type LeverControl =
  /** A slider on process pages (and so in the Editor, when it shows levers). */
  | "slider"
  /** Not a slider: changed on a Settings page, which the row links to. */
  | "settings"
  /** Changed in the Sandbox (a hire, leave, a role's cost): not a slider; hiding it takes it off the Sandbox's list for new changes. */
  | "sandbox"
  /** No control built yet: the choice is kept and applies when one arrives. */
  | "later";

export interface LeverKind {
  /** Stable id, stored in the workspace's list of hidden levers. */
  id: string;
  group: LeverGroup;
  /** The prototype's name for it. */
  label: string;
  /** Plain English: what it is. */
  description: string;
  /** A concrete example. */
  example: string;
  control: LeverControl;
  /** For `settings`: where it is changed, as a path under the workspace. */
  settingsPath?: string;
  /** For `settings`: what to call that page. */
  settingsLabel?: string;
}

export const LEVER_KINDS: readonly LeverKind[] = [
  // Demand
  {
    id: "demand.enquiries",
    group: "demand",
    label: "Enquiries per week",
    description: "How many new enquiries you get each week, from each source.",
    example: "7 from the website and 5 from referrals each week.",
    control: "slider",
  },
  {
    id: "demand.conversion",
    group: "demand",
    label: "How many enquiries become leads",
    description: "Out of every enquiry, how many are worth following up.",
    example: "6 in 10 partner enquiries, but only 1 in 4 website ones.",
    control: "sandbox",
  },
  {
    id: "demand.seasonal",
    group: "demand",
    label: "Busy and quiet months",
    description: "Some months bring more enquiries than others.",
    example: "December is quiet. January is busy.",
    control: "later",
  },
  {
    id: "demand.growth",
    group: "demand",
    label: "Growth",
    description: "Whether enquiries are slowly going up or down over time.",
    example: "2% more each month.",
    control: "later",
  },
  // People
  {
    id: "people.headcount",
    group: "people",
    label: "People in each role",
    description: "How many people do each kind of job.",
    example: "Add a second strategist to see what changes.",
    control: "slider",
  },
  {
    id: "people.hours",
    group: "people",
    label: "Hours each person works",
    description: "Full time or part time.",
    example: "Arjun goes from 4 days to 5 days a week.",
    control: "slider",
  },
  {
    id: "people.starters",
    group: "people",
    label: "New starters",
    description: "When someone new joins. They take a while to get up to speed.",
    example: "A new strategist starts in February.",
    control: "sandbox",
  },
  {
    id: "people.leave",
    group: "people",
    label: "Time off",
    description: "Holidays and leave.",
    example: "Maya is away for 2 weeks in July.",
    control: "sandbox",
  },
  // Process
  {
    id: "process.time",
    group: "process",
    label: "Time each step takes",
    description: "How long the work itself takes.",
    example: "Writing a proposal takes 2 hours. With a template, 1 hour.",
    control: "slider",
  },
  {
    id: "process.wait",
    group: "process",
    label: "Built-in waiting",
    description: "Waiting that isn't about anyone being busy, like waiting for a client to reply.",
    example: "Clients take about 4 days to send their logins.",
    control: "slider",
  },
  {
    id: "process.rework",
    group: "process",
    label: "Work done twice",
    description: "How often a step has to be redone.",
    example: "15 in 100 proposals are redone. With a checklist, 5.",
    control: "slider",
  },
  {
    id: "process.routing",
    group: "process",
    label: "Where work goes next",
    description: "After a step, what share goes each way.",
    example: "32 in 100 prospects sign. 68 say no.",
    control: "later",
  },
  // Clients and churn
  {
    id: "clients.count",
    group: "clients",
    label: "Clients per service",
    description: "How many clients you have on each service.",
    example: "15 on SEO, 7 on PPC, 4 on both.",
    control: "slider",
  },
  {
    id: "clients.fee",
    group: "clients",
    label: "Average fee",
    description: "What one client pays each month.",
    example: "SEO clients pay A$3,600 a month.",
    control: "settings",
    settingsPath: "/settings#services-heading",
    settingsLabel: "Settings → Services",
  },
  {
    id: "clients.churn",
    group: "clients",
    label: "Normal churn",
    description: "How many clients leave each month when everything is going well.",
    example: "About 1 SEO client every 4 months.",
    control: "slider",
  },
  {
    id: "clients.causes",
    group: "clients",
    label: "Causes of churn",
    description: "How much each cause of leaving matters (Settings → Churn drivers).",
    example: "Late work matters a bit more than normal.",
    control: "settings",
    settingsPath: "/settings#churn-drivers-heading",
    settingsLabel: "Settings → Churn drivers",
  },
  // Finances
  {
    id: "finances.prices",
    group: "finances",
    label: "Prices",
    description: "What you charge for each service.",
    example: "Raise PPC from A$4,300 to A$4,600.",
    control: "slider",
  },
  {
    id: "finances.roleCost",
    group: "finances",
    label: "Cost of each role",
    description: "What an hour of each role costs you.",
    example: "A strategist hour costs A$95.",
    control: "sandbox",
  },
  {
    id: "finances.fixed",
    group: "finances",
    label: "Fixed costs",
    description: "Monthly costs that don't change, like rent and software.",
    example: "A$18,000 a month.",
    control: "later",
  },
  // Market
  {
    id: "market.conditions",
    group: "market",
    label: "Market conditions",
    description: "How good or bad business conditions are (Settings → Market conditions).",
    example: "Switch to a downturn: far fewer enquiries.",
    control: "settings",
    settingsPath: "/settings#market-heading",
    settingsLabel: "Settings → Market conditions",
  },
  {
    id: "market.schedule",
    group: "market",
    label: "Market changes over time",
    description: "When the market is expected to change over the next 2 years.",
    example: "Business slows from month 7.",
    control: "settings",
    settingsPath: "/settings#market-heading",
    settingsLabel: "Settings → Market conditions",
  },
];

const KIND_BY_ID = new Map(LEVER_KINDS.map((k) => [k.id, k]));

export const leverKind = (id: string): LeverKind | undefined => KIND_BY_ID.get(id);

/** The kinds of one group, in order. */
export const kindsOf = (group: LeverGroup): LeverKind[] => LEVER_KINDS.filter((k) => k.group === group);

export { GROUP_LABELS };

/** The kind a generated lever (a slider on a process page) belongs to, by its patch path. */
export function leverKindId(lever: Pick<Lever, "path">): string | null {
  const p = lever.path;
  if (p === "demand.leads_per_week") return "demand.enquiries";
  if (p === "demand.active_clients") return "clients.count";
  if (p === "demand.churn_monthly") return "clients.churn";
  if (p === "finances.retainer" || /^services\.[^.]+\.price$/.test(p)) return "finances.prices";
  if (/^roles\.[^.]+\.headcount$/.test(p)) return "people.headcount";
  if (/^people\.[^.]+\.fte$/.test(p)) return "people.hours";
  if (/^steps\.[^.]+\.work_hours$/.test(p)) return "process.time";
  if (/^steps\.[^.]+\.wait_hours$/.test(p)) return "process.wait";
  if (/^steps\.[^.]+\.rework_rate$/.test(p)) return "process.rework";
  return null;
}

/** Is this lever showing, given the kinds a workspace has hidden? A lever with no kind always shows. */
export function isLeverShown(lever: Pick<Lever, "path">, hidden: readonly string[]): boolean {
  const id = leverKindId(lever);
  return id === null || !hidden.includes(id);
}

/** The levers to show: those whose kind isn't hidden. The Editor uses this too when it lists levers. */
export function visibleLevers<L extends Pick<Lever, "path">>(levers: readonly L[], hidden: readonly string[]): L[] {
  return hidden.length ? levers.filter((l) => isLeverShown(l, hidden)) : [...levers];
}

/** Keep only ids that are real lever kinds (what a hand-made request or an old save might hold), in catalogue order, no repeats. */
export function cleanHidden(ids: readonly unknown[]): string[] {
  const set = new Set(ids.filter((x): x is string => typeof x === "string" && KIND_BY_ID.has(x)));
  return LEVER_KINDS.map((k) => k.id).filter((id) => set.has(id));
}
