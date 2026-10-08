// Larkspur Creative, the second golden agency (docs/PRD.md §6.9 layer 3;
// issue #22), as plain data shared by the engine's larkspurModel() and the
// database seed fixture. No imports, so the seed scripts can load it directly
// with Node's type stripping (package export "./larkspur-data").
//
// Where Northbeam is tidy, Larkspur is messy on purpose, so the golden tests
// exercise the parts of the engine Northbeam leaves alone:
// - overload: the design pool carries the content calendar's assets, ad-hoc
//   requests and the pipeline's concepts, more than its week;
// - overtime: Imogen, the only copywriter, has more content-retainer work
//   (fallback load) than her week, so she works up to the 15% cap and her
//   pipeline share falls to the floor;
// - a named roster of 18 clients, some already unhappy and one with no health
//   entered, on two retainers with servicing, a retainer on fallback load and
//   one-off website builds with a care plan;
// - health-driven churn: late and missed calendars and ad-hoc requests wear
//   health down, and churn follows it (sensitivities 3 and 4);
// - and the odd corners: a 37.5-hour week, a founder in two roles pinned to
//   pitch calls, a part-timer, a contractor with their own hours and rate, a
//   specialist limited by skills, leave, triangular and constant
//   distributions, heavy rework, two lost ends, step SLAs, work in progress
//   instead of a warm-up, seasonality with growth, and Poisson requests.
// Times are in working hours.

/** The run the golden baselines and the seed fixture's check use start on this Monday. */
export const LARKSPUR_START = "2026-10-05";

export const LARKSPUR_SETTINGS = {
  hoursPerWeek: 37.5,
  horizonWeeks: 26,
  currency: "GBP",
  /** Interim values: unused while the workspace has lead sources and a roster. */
  leadsPerWeek: 5,
  activeClients: 18,
  churnMonthly: 0.04,
  retainer: 2600,
  overtimeCap: 0.15,
  availabilityFloor: 0.1,
  /** Health rules: a missed task costs more than the estimated default; clients with no health entered start at 75. */
  healthMissedPenalty: 15,
  healthInitial: 75,
} as const;

/** Distribution of a step's work or wait; omitted is the engine's default lognormal. */
export type LarkspurDist = { kind: "lognormal"; cv: number } | { kind: "constant" } | { kind: "triangular"; min: number; mode: number; max: number };

/** Role keys, in the order their database ids sort. */
export const LARKSPUR_ROLES: [key: string, name: string, cost: number, color: string][] = [
  ["strat", "Strategy lead", 75, "#eb6834"],
  ["am", "Account manager", 50, "#1baf7a"],
  ["design", "Designer", 48, "#8b5cf6"],
  ["copy", "Copywriter", 45, "#2a78d6"],
  ["social", "Social executive", 38, "#d4a106"],
  ["dev", "Developer", 60, "#0ea5a4"],
  ["ops", "Ops & finance", 40, "#64748b"],
];

/** One of Larkspur's people (fictional). */
export interface LarkspurPerson {
  key: string;
  name: string;
  /** Role keys. */
  roles: string[];
  fte: number;
  /** Contracted hours a week, when not FTE × the workspace week. */
  hours?: number;
  /** Cost per hour, when not the mean of their roles'. */
  cost?: number;
  /** Step keys they are limited to. */
  skills?: string[];
  /** Leave as dates (inclusive) and as simulation hours from LARKSPUR_START (7.5 working hours a day). */
  leave?: { start: string; end: string; hours: [number, number] }[];
}

/** People in the order their database ids sort. */
export const LARKSPUR_TEAM: LarkspurPerson[] = [
  { key: "hana", name: "Hana Whitfield", roles: ["strat", "am"], fte: 1 },
  { key: "jess", name: "Jess Monroe", roles: ["am"], fte: 1 },
  { key: "callum", name: "Callum Hart", roles: ["am"], fte: 0.6 },
  { key: "ruby", name: "Ruby Adeyemi", roles: ["design"], fte: 1, leave: [{ start: "2026-10-19", end: "2026-10-30", hours: [75, 150] }] },
  { key: "theo", name: "Theo Grant", roles: ["design"], fte: 1, hours: 30, cost: 65 },
  { key: "imogen", name: "Imogen Reyes", roles: ["copy"], fte: 1 },
  { key: "kai", name: "Kai Robinson", roles: ["social"], fte: 1, leave: [{ start: "2026-12-21", end: "2027-01-01", hours: [412.5, 487.5] }] },
  { key: "freya", name: "Freya Walsh", roles: ["social"], fte: 1, skills: ["social_setup", "cal_social"] },
  { key: "marek", name: "Marek Nowak", roles: ["dev"], fte: 1 },
  { key: "priti", name: "Priti Desai", roles: ["ops"], fte: 0.5 },
];

/** A step of one of Larkspur's processes: working steps first, in the order their database ids sort, then the start and the ends. */
export interface LarkspurStep {
  key: string;
  name: string;
  kind: "task" | "decision" | "start" | "end";
  /** End steps' outcome. */
  outcome?: "won" | "lost" | "done";
  role: string | null;
  /** Pinned person's key. */
  person?: string;
  work: number;
  wait: number;
  rework: number;
  workDist?: LarkspurDist;
  waitDist?: LarkspurDist;
  currentWip?: number;
  sla?: number;
  tool: string | null;
  x: number;
  y: number;
}

/** [from, to, probability, condition tag], in the order their database ids sort. */
export type LarkspurEdge = [from: string, to: string, p: number, tag: string | null];

/**
 * The pipeline, "Enquiry to launch": pitches are Hana's alone; concepts go
 * back for client revisions a quarter of the time; a brand workshop routes
 * each service to its own set-up. Work is already sitting at the client
 * decision and the website build, so the run starts from it.
 */
export const LARKSPUR_PIPELINE: { steps: LarkspurStep[]; edges: LarkspurEdge[] } = {
  steps: [
    { key: "triage", name: "Triage enquiry", kind: "task", role: "am", work: 0.5, wait: 8, rework: 0, tool: "Instagram, HubSpot", x: 60, y: 50 },
    {
      key: "pitch",
      name: "Pitch call",
      kind: "task",
      role: "strat",
      person: "hana",
      work: 1.5,
      wait: 16,
      rework: 0,
      workDist: { kind: "triangular", min: 1, mode: 1.25, max: 2.25 },
      tool: "Google Meet",
      x: 290,
      y: 50,
    },
    {
      key: "concepts",
      name: "Creative concepts",
      kind: "task",
      role: "design",
      work: 5,
      wait: 0,
      rework: 0.25,
      workDist: { kind: "lognormal", cv: 0.6 },
      sla: 80,
      tool: "Figma",
      x: 520,
      y: 50,
    },
    {
      key: "decision",
      name: "Client decision",
      kind: "decision",
      role: null,
      work: 0,
      wait: 60,
      rework: 0,
      waitDist: { kind: "triangular", min: 15, mode: 45, max: 120 },
      currentWip: 6,
      tool: "Email",
      x: 750,
      y: 50,
    },
    {
      key: "onboard",
      name: "Contract & onboarding",
      kind: "task",
      role: "ops",
      work: 2,
      wait: 24,
      rework: 0,
      waitDist: { kind: "constant" },
      tool: "PandaDoc, Xero",
      x: 60,
      y: 290,
    },
    { key: "workshop", name: "Brand workshop", kind: "task", role: "strat", work: 4, wait: 8, rework: 0, tool: "Miro", x: 290, y: 290 },
    { key: "social_setup", name: "Social set-up & first calendar", kind: "task", role: "social", work: 6, wait: 8, rework: 0.1, tool: "Later, Canva", x: 520, y: 180 },
    { key: "content_plan", name: "Content plan & first articles", kind: "task", role: "copy", work: 12, wait: 16, rework: 0.2, tool: "Google Docs", x: 520, y: 310 },
    {
      key: "web_design",
      name: "Website design",
      kind: "task",
      role: "design",
      work: 30,
      wait: 24,
      rework: 0.3,
      workDist: { kind: "lognormal", cv: 0.5 },
      tool: "Figma",
      x: 520,
      y: 440,
    },
    {
      key: "web_build",
      name: "Website build",
      kind: "task",
      role: "dev",
      work: 45,
      wait: 40,
      rework: 0.15,
      currentWip: 2,
      sla: 200,
      tool: "Webflow",
      x: 750,
      y: 400,
    },
    { key: "launch", name: "Launch & handover", kind: "task", role: "am", work: 2, wait: 0, rework: 0, tool: "Loom", x: 750, y: 290 },
    { key: "start", name: "Enquiry arrives", kind: "start", role: null, work: 0, wait: 0, rework: 0, tool: null, x: -150, y: 50 },
    { key: "won", name: "Won", kind: "end", outcome: "won", role: null, work: 0, wait: 0, rework: 0, tool: null, x: 980, y: 290 },
    { key: "lost_fit", name: "Lost: not a fit", kind: "end", outcome: "lost", role: null, work: 0, wait: 0, rework: 0, tool: null, x: 290, y: -80 },
    { key: "lost_price", name: "Lost: price or timing", kind: "end", outcome: "lost", role: null, work: 0, wait: 0, rework: 0, tool: null, x: 980, y: 50 },
  ],
  edges: [
    ["start", "triage", 1, null],
    ["triage", "pitch", 0.6, null],
    ["triage", "lost_fit", 0.4, null],
    ["pitch", "concepts", 0.75, null],
    ["pitch", "lost_fit", 0.25, null],
    ["concepts", "decision", 1, null],
    ["decision", "onboard", 0.4, null],
    ["decision", "lost_price", 0.6, null],
    ["onboard", "workshop", 1, null],
    ["workshop", "social_setup", 0.5, "social"],
    ["workshop", "content_plan", 0.3, "content"],
    ["workshop", "web_design", 0.2, "web"],
    ["social_setup", "launch", 1, null],
    ["content_plan", "launch", 1, null],
    ["web_design", "web_build", 1, null],
    ["web_build", "launch", 1, null],
    ["launch", "won", 1, null],
  ],
};

/** A servicing process Larkspur's social clients run. */
export interface LarkspurServicingProcess {
  key: string;
  name: string;
  entityName: string;
  description: string;
  steps: LarkspurStep[];
  edges: LarkspurEdge[];
}

/** Servicing processes, in the order their database ids sort. */
export const LARKSPUR_SERVICING: LarkspurServicingProcess[] = [
  {
    key: "calendar",
    name: "Content calendar",
    entityName: "calendar",
    description: "Next month's posts: planned, written, designed and approved by the client.",
    steps: [
      { key: "cal_plan", name: "Plan the month", kind: "task", role: "am", work: 1.5, wait: 0, rework: 0, tool: "Notion", x: 60, y: 50 },
      { key: "cal_social", name: "Write the posts", kind: "task", role: "social", work: 10, wait: 0, rework: 0, tool: "Later", x: 290, y: 50 },
      { key: "cal_design", name: "Design the assets", kind: "task", role: "design", work: 5, wait: 0, rework: 0.2, tool: "Figma, Canva", x: 520, y: 50 },
      { key: "cal_approve", name: "Client approval", kind: "task", role: "am", work: 1, wait: 16, rework: 0, tool: "Email", x: 750, y: 50 },
      { key: "cal_start", name: "Month due", kind: "start", role: null, work: 0, wait: 0, rework: 0, tool: null, x: -150, y: 50 },
      { key: "cal_done", name: "Calendar approved", kind: "end", outcome: "done", role: null, work: 0, wait: 0, rework: 0, tool: null, x: 980, y: 50 },
    ],
    edges: [
      ["cal_start", "cal_plan", 1, null],
      ["cal_plan", "cal_social", 1, null],
      ["cal_social", "cal_design", 1, null],
      ["cal_design", "cal_approve", 1, null],
      ["cal_approve", "cal_done", 1, null],
    ],
  },
  {
    key: "adhoc",
    name: "Ad-hoc request",
    entityName: "request",
    description: "A last-minute graphic or post the client asks for.",
    steps: [
      {
        key: "adhoc_design",
        name: "Turn the request round",
        kind: "task",
        role: "design",
        work: 2,
        wait: 0,
        rework: 0,
        workDist: { kind: "triangular", min: 0.5, mode: 1.5, max: 4 },
        tool: "Canva",
        x: 290,
        y: 50,
      },
      { key: "adhoc_start", name: "Request in", kind: "start", role: null, work: 0, wait: 0, rework: 0, tool: null, x: 60, y: 50 },
      { key: "adhoc_done", name: "Sent", kind: "end", outcome: "done", role: null, work: 0, wait: 0, rework: 0, tool: null, x: 520, y: 50 },
    ],
    edges: [
      ["adhoc_start", "adhoc_design", 1, null],
      ["adhoc_design", "adhoc_done", 1, null],
    ],
  },
];

/** How often a service's clients run a servicing process: every week/month, or Poisson requests a month. */
export type LarkspurRecurrence = { every: "week" | "month"; times: number } | { poissonPerMonth: number };

/** Something Larkspur sells. */
export interface LarkspurService {
  key: string;
  name: string;
  pricingModel: "retainer" | "one_off";
  price: number;
  margin: number;
  tenureMonths: number;
  churnMonthly: number;
  churnSensitivity: number;
  mixShare: number;
  /** Hours a month per client by role key, used while the service has no servicing. */
  fallback: Record<string, number>;
  /** Servicing links: [process key, recurrence, SLA hours], in the order their database ids sort. */
  servicing: [process: string, recurrence: LarkspurRecurrence, sla: number][];
}

/**
 * Services, in the order their database ids sort (which is also their keys'
 * alphabetical order). Social runs servicing processes; the content retainer
 * is still on fallback load; a website is a one-off whose clients keep a care
 * plan (the developer's fallback hours).
 */
export const LARKSPUR_SERVICES: LarkspurService[] = [
  {
    key: "content",
    name: "Content retainer",
    pricingModel: "retainer",
    price: 3100,
    margin: 0.4,
    tenureMonths: 14,
    churnMonthly: 0.035,
    churnSensitivity: 3,
    mixShare: 0.3,
    fallback: { am: 4, design: 3, copy: 24, ops: 1 },
    servicing: [],
  },
  {
    key: "social",
    name: "Social media retainer",
    pricingModel: "retainer",
    price: 2400,
    margin: 0.35,
    tenureMonths: 10,
    churnMonthly: 0.04,
    churnSensitivity: 3.5,
    mixShare: 0.5,
    fallback: { am: 4, social: 12, design: 10, ops: 1 },
    servicing: [
      ["calendar", { every: "month", times: 1 }, 60],
      ["adhoc", { poissonPerMonth: 1.5 }, 16],
    ],
  },
  {
    key: "web",
    name: "Website build",
    pricingModel: "one_off",
    price: 9500,
    margin: 0.3,
    tenureMonths: 0,
    churnMonthly: 0,
    churnSensitivity: 0,
    mixShare: 0.2,
    fallback: { am: 1, dev: 4 },
    servicing: [],
  },
];

/** A client on Larkspur's roster, with who looks after it. */
export interface LarkspurClient {
  name: string;
  services: ("content" | "social" | "web")[];
  start: string;
  mrr: number;
  /** Null: not entered (the workspace's initial health applies). */
  health: number | null;
  /** Person key by role key; a role left out is shared by its people. */
  team: Record<string, string>;
  notes?: string;
}

/** Larkspur's 18 active clients (fictional), in the order their database ids sort. */
export const LARKSPUR_ROSTER: LarkspurClient[] = [
  { name: "Maple & Moss Florists", services: ["social"], start: "2024-03-04", mrr: 2400, health: 82, team: { am: "jess", social: "kai", design: "ruby" } },
  { name: "Brew Theory Coffee", services: ["social", "content"], start: "2024-05-13", mrr: 5500, health: 71, team: { am: "jess", social: "kai", copy: "imogen" } },
  { name: "Pellow Yoga Studio", services: ["social"], start: "2024-06-03", mrr: 2200, health: 44, team: { am: "callum", social: "freya" }, notes: "Posts went out late twice in August; asked for a call." },
  { name: "Northern Rail Heritage Trust", services: ["content"], start: "2024-07-01", mrr: 3100, health: 88, team: { am: "hana", copy: "imogen" } },
  { name: "Cobble Lane Bikes", services: ["social", "web"], start: "2024-09-09", mrr: 2650, health: 76, team: { am: "jess", social: "kai", dev: "marek" } },
  { name: "Saltmarsh Distillery", services: ["social"], start: "2024-10-14", mrr: 2600, health: 58, team: { am: "callum", social: "freya", design: "theo" } },
  { name: "Juniper Legal", services: ["content"], start: "2024-11-04", mrr: 3300, health: 91, team: { am: "hana", copy: "imogen" } },
  { name: "Halden Architecture", services: ["web"], start: "2025-01-06", mrr: 250, health: 85, team: { am: "jess", dev: "marek" } },
  { name: "Orla's Kitchen", services: ["social"], start: "2025-02-03", mrr: 2400, health: 36, team: { am: "callum", social: "kai" }, notes: "Unhappy with engagement; renewal in November." },
  { name: "Tern Outdoor Gear", services: ["social", "content"], start: "2025-03-10", mrr: 5200, health: 67, team: { am: "jess", social: "freya", copy: "imogen", design: "ruby" } },
  { name: "Greenhouse Dental", services: ["content"], start: "2025-04-07", mrr: 2900, health: 79, team: { am: "callum", copy: "imogen" } },
  { name: "Quarry Hill Climbing", services: ["social"], start: "2025-05-12", mrr: 2300, health: 73, team: { am: "jess", social: "kai" } },
  { name: "Fable Kids Books", services: ["social", "web"], start: "2025-06-02", mrr: 2650, health: null, team: { am: "callum", social: "freya", dev: "marek" } },
  { name: "Copper Kettle Tea Rooms", services: ["social"], start: "2025-07-07", mrr: 2100, health: 48, team: { am: "jess", social: "kai" } },
  { name: "Wren Financial Planning", services: ["content"], start: "2025-08-04", mrr: 3400, health: 84, team: { am: "hana", copy: "imogen" } },
  { name: "Lowther Estates", services: ["web"], start: "2025-11-03", mrr: 300, health: 90, team: { am: "jess", dev: "marek" } },
  { name: "Hive Coworking", services: ["social", "content"], start: "2026-02-02", mrr: 5300, health: 62, team: { am: "callum", social: "freya", copy: "imogen" } },
  { name: "Seren Skincare", services: ["social"], start: "2026-06-01", mrr: 2500, health: 80, team: { am: "jess", social: "kai", design: "theo" } },
];

/** Client ids of the roster in the engine model, in roster order ("l01" …). */
export const larkspurClientKey = (i: number) => `l${String(i + 1).padStart(2, "0")}`;

/**
 * Lead sources, in the order their database ids sort: 10 × 20% + 2 × 100% +
 * 6 × 25% = 5.5 qualified enquiries a week (exact in binary floating point).
 */
export const LARKSPUR_LEAD_SOURCES: [key: string, name: string, volume: number, conversion: number][] = [
  ["instagram", "Instagram DMs", 10, 0.2],
  ["referrals", "Client referrals", 2, 1],
  ["website", "Website form", 6, 0.25],
];

/** Seasonality, January first: busy in the new year, quiet in August and December. */
export const LARKSPUR_SEASONALITY = [1.25, 1.15, 1.1, 1, 1, 0.95, 0.85, 0.7, 1.05, 1.1, 1, 0.6];

/** 1% more enquiries a month. */
export const LARKSPUR_GROWTH_MONTHLY = 0.01;

/** Where LARKSPUR_START falls in the calendar (5 October: October is month 9, and the 5th is 4/31 of the way in). */
export const LARKSPUR_START_MONTH = 9 + 4 / 31;
