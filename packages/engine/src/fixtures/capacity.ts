// The prototype's example agency, as an engine model that uses the capacity fields (docs/adr/0022-capacity-inputs.md).
// Source: docs/prototypes/client-capacity-app.PROTOTYPE.html (`base`, `PROCS`, `LIB`). The prototype's data is made up, so
// nothing here is confidential; the names are the prototype's.
//
// The engine reads the P2 fields (engine 1.15.0), and this model is the `capacity` golden (docs/engine-versioning.md). It is
// also what P1 seeds from and what the check is tested on. The work split, tier multipliers and changes are P3's: the model
// sets them, and the engine doesn't read them yet.
//
// What the mapping does (the ADR has the reasoning):
// - a service is one tier of one department (six of them), with its own deliverables and ad-hoc rule;
// - each distinct step frequency in the prototype is a servicing process, linked to every tier of its department;
// - "who: owner" steps go to the client's manager (`toClientManager`), falling back to the department's client-facing role;
// - "speed" becomes `capacityFactor.default` = 1 ÷ speed; "team time" (`mgmt`) becomes `reservedShare`; "counts" become `portfolio`;
// - counted clients (the people's counts, summed by tier) sit beside the 13 named clients (`clientMix: "groups-add"`);
// - salary, contractor and offshore labels, the busy-share line and the rule of thumb stay out: they are database-only.
//
// Left out of the model: onboarding (once per new client; the prototype's `org-onb` and `perf-onb`), the `onb-o` change that
// acts on it, the global 8% leave (the engine takes leave as windows per person), and the sandbox scenarios.

import type { EngineClient, EngineClientGroup, EngineModel, EnginePerson, EngineRole, EngineService, EngineServicingLink, EngineStep, EngineStepChange, Recurrence, SourceLabel } from "../model";

const HOURS_PER_WEEK = 38;
/** Hours in a 52/12-week month at 38 hours a week. */
const MONTH_HOURS = (52 / 12) * HOURS_PER_WEEK;
/** Servicing tasks count as on time within this many working hours (the prototype has no SLA; engine-only). */
const SLA_HOURS = 160;

type Dept = "org" | "perf";
const TIERS = ["T1", "T2", "T3"] as const;
type Tier = (typeof TIERS)[number];

const DEPT_NAME: Record<Dept, string> = { org: "Organic", perf: "Performance" };

/** Service id of a department's tier: "org-T1". */
export const capacityServiceId = (dept: Dept, tier: Tier) => `${dept}-${tier}`;

/** Per tier and department, from `base().tiers`. `adhocP` is the chance a client asks; `adhoc` the requests if they do. */
const TIER_DATA: Record<Dept, Record<Tier, { fee: number; churn: number; meet: number; adhocP: number; adhoc: number; org?: { words: number; links: number; techH: number }; perf?: { channels: number; builds: number; creatives: number } }>> = {
  org: {
    T1: { fee: 11000, churn: 0.01, meet: 4, adhocP: 0.9, adhoc: 6.5, org: { words: 4000, links: 8, techH: 10 } },
    T2: { fee: 4500, churn: 0.02, meet: 1, adhocP: 0.7, adhoc: 4, org: { words: 1500, links: 5, techH: 5 } },
    T3: { fee: 3000, churn: 0.025, meet: 1, adhocP: 0.5, adhoc: 4, org: { words: 1000, links: 3, techH: 2 } },
  },
  perf: {
    T1: { fee: 8000, churn: 0.01, meet: 4, adhocP: 0.95, adhoc: 8.5, perf: { channels: 4, builds: 5, creatives: 2 } },
    T2: { fee: 3500, churn: 0.02, meet: 1, adhocP: 0.7, adhoc: 4.3, perf: { channels: 1.5, builds: 3, creatives: 1 } },
    T3: { fee: 2200, churn: 0.025, meet: 1, adhocP: 0.5, adhoc: 4, perf: { channels: 1.2, builds: 1.5, creatives: 0.5 } },
  },
};

/** Share of arrivals: department mix (50/50) times tier mix (10/40/50). */
const TIER_MIX: Record<Tier, number> = { T1: 0.1, T2: 0.4, T3: 0.5 };

// ---- roles --------------------------------------------------------------------------------------------------------

const ROLES: Record<string, EngineRole> = {
  sales: { name: "Sales", count: 1, cost: 0, ongoing: 0 },
  dir_org: { name: "SEO Director", count: 1, cost: 0, ongoing: 0 },
  mgr_org: { name: "SEO Manager / Analyst", count: 6, cost: 0, ongoing: 0 },
  content: { name: "Content team", count: 5, cost: 0, ongoing: 0, unit: { label: "words" } },
  links: { name: "Link outreach (offshore)", count: 2, cost: 0, ongoing: 0, unit: { label: "links" } },
  tech: { name: "Technical SEO", count: 3, cost: 0, ongoing: 0, unit: { label: "ticket hours" } },
  dir_perf: { name: "Performance Director", count: 1, cost: 0, ongoing: 0 },
  pmm: { name: "Performance Marketing Manager", count: 5, cost: 0, ongoing: 0 },
  impl: { name: "Performance implementers", count: 2, cost: 0, ongoing: 0, unit: { label: "tasks" } },
  track: { name: "Conversion tracking", count: 1, cost: 0, ongoing: 0, unit: { label: "set-ups and incidents" } },
};

/** The client-facing role steps for "the client's manager" fall back to, per department. */
const MANAGER_ROLE: Record<Dept, string> = { org: "mgr_org", perf: "pmm" };

// ---- servicing steps ----------------------------------------------------------------------------------------------

type Src = "Interview" | "Estimate" | "Calculator";
const SRC: Record<Src, SourceLabel> = { Interview: "interview", Estimate: "estimate", Calculator: "calculator" };

/** One prototype step: minutes, the work split in percent, and the tier multipliers. `who`: "owner", a role key, or "@person". */
type ProtoStep = [id: string, name: string, who: string, min: number, split: [number, number, number], purpose: string, src: Src, mult?: Record<string, number>];

const ORG_STEPS: Record<string, ProtoStep[]> = {
  meet: [
    ["o1", "Meeting prep & notes", "owner", 30, [50, 30, 20], "Client meetings", "Interview", { T1: 1.5 }],
    ["o2", "Client meeting (WIP)", "owner", 40, [0, 10, 90], "Client meetings", "Interview"],
  ],
  content: [
    ["o3", "Content briefs", "owner", 20, [60, 30, 10], "Content", "Interview"],
    ["o4", "Writing (per 1,000 words)", "content", 240, [0, 15, 85], "Content", "Estimate"],
    ["o5", "Editing & QA (per 1,000 words)", "content", 45, [20, 30, 50], "Content", "Estimate"],
    ["o6", "Content upload & coordination", "owner", 30, [40, 30, 30], "Content", "Estimate"],
  ],
  links: [
    ["o7", "Link outreach", "links", 30, [30, 30, 40], "Links", "Estimate"],
    ["o8", "Domain vetting", "@karl", 4, [60, 20, 20], "Links", "Interview"],
    ["o9", "Link admin & live checks", "links", 10, [70, 10, 20], "Links", "Interview"],
  ],
  tech: [["o10", "Technical tickets", "tech", 60, [10, 30, 60], "Technical", "Calculator"]],
  monthly: [
    ["o11", "Project plan & approvals", "owner", 120, [40, 30, 30], "Account management", "Estimate", { T1: 1.5, T3: 0.7 }],
    ["o12", "Monthly report", "owner", 60, [50, 30, 20], "Reporting", "Interview", { T1: 1.5, T3: 0.7 }],
  ],
  strategy: [["o13", "Strategy review", "owner", 480, [20, 40, 40], "Strategy", "Interview"]],
  adhoc: [["o14", "Ad-hoc requests & email", "owner", 45, [0, 30, 70], "Ad hoc", "Estimate"]],
  tracking: [["o15", "Tracking troubleshooting", "track", 60, [40, 20, 40], "Technical", "Estimate"]],
};

const PERF_STEPS: Record<string, ProtoStep[]> = {
  pacing: [
    ["p1", "Pacing checks", "owner", 25, [70, 20, 10], "Pacing", "Interview"],
    ["p2", "Performance review & optimisation", "owner", 45, [30, 40, 30], "Optimisation", "Interview"],
    ["p13", "PPC hygiene tasks", "impl", 10, [40, 30, 30], "Optimisation", "Interview"],
  ],
  builds: [
    ["p3", "Implementation briefs", "owner", 20, [50, 30, 20], "Implementation", "Interview"],
    ["p4", "Campaign builds & changes", "impl", 45, [10, 40, 50], "Implementation", "Interview"],
    ["p5", "Ad QA", "owner", 20, [60, 10, 30], "Implementation", "Interview"],
  ],
  meet: [
    ["p6", "Meeting prep & notes", "owner", 40, [60, 25, 15], "Client meetings", "Interview", { T1: 1.5 }],
    ["p7", "Client meeting (WIP)", "owner", 40, [0, 10, 90], "Client meetings", "Interview"],
  ],
  monthly: [["p8", "Monthly report commentary", "owner", 30, [40, 40, 20], "Reporting", "Interview", { T1: 1.5, T3: 0.7 }]],
  quarterly: [["p9", "Quarterly review deck", "owner", 300, [50, 30, 20], "Strategy", "Interview"]],
  adhoc: [["p10", "Ad-hoc requests & email", "owner", 25, [0, 30, 70], "Ad hoc", "Estimate"]],
  creative: [["p12", "Creative sets", "impl", 60, [20, 40, 40], "Creative", "Interview"]],
  tracking: [["p11", "Tracking troubleshooting", "track", 60, [40, 20, 40], "Technical", "Interview"]],
};

/** How often each servicing process runs for a client of a tier. The prototype's `freq`, written as a recurrence. */
const month = (times: number): Recurrence => ({ every: "month", times });
const RECURRENCE: Record<Dept, Record<string, (tier: Tier) => Recurrence>> = {
  org: {
    meet: () => ({ perMonth: 1, driver: "meetings" }),
    content: () => ({ perMonth: 1, driver: "words", per: 1000 }),
    links: () => ({ perMonth: 1, driver: "links" }),
    tech: () => ({ perMonth: 1, driver: "techHours" }),
    monthly: () => month(1),
    strategy: (t) => month(t === "T1" ? 1 / 3 : 1 / 6),
    adhoc: () => ({ perMonth: 1, driver: "adhoc" }),
    tracking: () => month(0.15),
  },
  perf: {
    pacing: () => ({ perMonth: 1, driver: "channels" }),
    builds: () => ({ perMonth: 1, driver: "builds" }),
    meet: () => ({ perMonth: 1, driver: "meetings" }),
    monthly: () => month(1),
    quarterly: (t) => month(t === "T3" ? 1 / 6 : 1 / 3),
    adhoc: () => ({ perMonth: 1, driver: "adhoc" }),
    creative: () => ({ perMonth: 1, driver: "creativeSets" }),
    tracking: () => month(0.3),
  },
};

const processId = (dept: Dept, key: string) => `${dept}-${key}`;
const PROC_NAME: Record<string, string> = {
  meet: "Client meetings", content: "Content, per 1,000 words", links: "Links, per link", tech: "Technical tickets", monthly: "Monthly work", strategy: "Strategy review",
  adhoc: "Ad-hoc requests", tracking: "Tracking troubleshooting", pacing: "Pacing and hygiene, per channel", builds: "Builds", quarterly: "Quarterly review", creative: "Creative sets",
};

function buildSteps(dept: Dept, groups: Record<string, ProtoStep[]>): { steps: EngineStep[]; processes: EngineModel["servicingProcesses"] } {
  const steps: EngineStep[] = [];
  const processes: NonNullable<EngineModel["servicingProcesses"]> = {};
  for (const [key, list] of Object.entries(groups)) {
    list.forEach(([id, name, who, min, split, purpose, src, mult], i) => {
      const next = list[i + 1]?.[0];
      const step: EngineStep = {
        id,
        name,
        role: who === "owner" ? MANAGER_ROLE[dept] : who.startsWith("@") ? MANAGER_ROLE[dept] : who,
        work: min / 60,
        wait: 0,
        rework: 0,
        purpose,
        split: { automatable: split[0] / 100, augmentable: split[1] / 100, manual: split[2] / 100 },
        sources: { work: SRC[src], split: SRC[src] },
        next: [{ to: next ?? "done", p: 1 }],
      };
      if (who === "owner") step.toClientManager = true;
      if (who.startsWith("@")) step.person = who.slice(1);
      if (mult) {
        step.tierMultiplier = mult;
        step.sources = { ...step.sources, tierMultiplier: SRC[src] };
      }
      steps.push(step);
    });
    processes[processId(dept, key)] = { name: `${DEPT_NAME[dept]}: ${PROC_NAME[key]}`, entry: list[0]![0], steps: list.map((s) => s[0]) };
  }
  return { steps, processes };
}

// ---- services -----------------------------------------------------------------------------------------------------

function buildServices(): Record<string, EngineService> {
  const out: Record<string, EngineService> = {};
  for (const dept of ["org", "perf"] as const) {
    for (const tier of TIERS) {
      const t = TIER_DATA[dept][tier];
      const servicing: EngineServicingLink[] = Object.keys(dept === "org" ? ORG_STEPS : PERF_STEPS).map((key) => ({
        process: processId(dept, key),
        recurrence: RECURRENCE[dept][key]!(tier),
        sla: SLA_HOURS,
      }));
      out[capacityServiceId(dept, tier)] = {
        name: `${DEPT_NAME[dept]} ${tier.replace("T", "Tier ")}`,
        pricingModel: "retainer",
        price: t.fee,
        margin: 0,
        tenureMonths: Math.round(1 / t.churn),
        churnMonthly: t.churn,
        mixShare: 0.5 * TIER_MIX[tier],
        pathTags: [],
        department: dept,
        tier,
        deliverables: dept === "org"
          ? { words: t.org!.words, links: t.org!.links, techHours: t.org!.techH, meetings: t.meet }
          : { channels: t.perf!.channels, builds: t.perf!.builds, creativeSets: t.perf!.creatives, meetings: t.meet },
        adhoc: { chance: t.adhocP, requests: t.adhoc },
        servicing,
      };
    }
  }
  return out;
}

// ---- people -------------------------------------------------------------------------------------------------------

/** id, name, role, hours a week, team time, speed, tiers served, counted clients by tier (T1, T2, T3), month they leave. */
type ProtoPerson = [id: string, name: string, role: string, hpw: number, mgmt: number, speed: number, tiers: string, counts?: [number, number, number], leavesAtMonth?: number];

const PEOPLE: ProtoPerson[] = [
  ["laura", "Laura", "dir_org", 38, 0.35, 1.5, "T1 T2 T3", [0, 2, 7]],
  ["karl", "Karl", "mgr_org", 38, 0.2, 1.4, "T1 T2 T3", [0, 5, 5]],
  ["nadiya", "Nadiya", "mgr_org", 38, 0, 1, "T2 T3", [0, 6, 9]],
  ["zach", "Zach", "mgr_org", 38, 0, 1, "T1 T2 T3", [0, 4, 6]],
  ["jc", "JC", "mgr_org", 38, 0, 0.9, "T2 T3", [0, 3, 6]],
  ["khas", "Khaselyn", "mgr_org", 38, 0, 0.75, "T3", [0, 0, 5]],
  ["resign", "SEO Manager (resigned)", "mgr_org", 38, 0, 1, "T2 T3", [0, 7, 12], 1],
  ["sarah", "Sarah", "content", 38, 0.25, 1.2, ""],
  ["jess", "Jess", "content", 38, 0, 1, ""],
  ["chloe", "Chloe", "content", 38, 0, 1, ""],
  ["hayley", "Hayley", "content", 38, 0, 1, ""],
  ["free", "Freelancers (4, pooled)", "content", 40, 0, 1, ""],
  ["tonie", "Tonie", "links", 40, 0, 1, ""],
  ["jasfer", "Jasfer", "links", 40, 0, 1, ""],
  ["henry", "Henry", "tech", 38, 0.3, 1, ""],
  ["everhardt", "Everhardt", "tech", 38, 0, 1, ""],
  ["sid", "Sid", "tech", 38, 0, 1, ""],
  ["wendlley", "Wendlley", "dir_perf", 38, 0.5, 1.3, "T1 T2 T3", [0, 0, 0]],
  ["sophie", "Sophie", "pmm", 38, 0, 1.15, "T1 T2 T3", [0, 6, 5]],
  ["shrishti", "Shrishti", "pmm", 38, 0, 1.15, "T1 T2 T3", [0, 6, 6]],
  ["diya", "Diya", "pmm", 38, 0, 1, "T2 T3", [0, 8, 12]],
  ["thomas", "Thomas", "pmm", 38, 0, 1, "T2 T3", [0, 6, 7]],
  ["tanya", "Tanya", "pmm", 38, 0, 1, "T2 T3", [0, 5, 7]],
  ["tatiana", "Tatiana", "impl", 38, 0, 1, ""],
  ["michaela", "Michaela", "impl", 38, 0, 1, ""],
  ["liam", "Liam", "track", 38, 0, 1, ""],
  ["sales", "Sales lead", "sales", 38, 0, 1, ""],
];

const ROLE_DEPT: Record<string, Dept> = { dir_org: "org", mgr_org: "org", dir_perf: "perf", pmm: "perf" };

function buildPeople(): Record<string, EnginePerson> {
  const out: Record<string, EnginePerson> = {};
  for (const [id, name, role, hpw, mgmt, speed, tiers, counts, leaves] of PEOPLE) {
    const p: EnginePerson = { name, roles: [role], capacity: hpw };
    if (mgmt > 0) p.reservedShare = mgmt;
    if (speed !== 1) p.capacityFactor = { default: 1 / speed };
    if (tiers) p.tiers = tiers.split(" ");
    if (leaves !== undefined) p.until = leaves * MONTH_HOURS;
    const dept = ROLE_DEPT[role];
    if (dept && counts) {
      const portfolio: Record<string, number> = {};
      TIERS.forEach((t, i) => {
        if (counts[i]! > 0) portfolio[capacityServiceId(dept, t)] = counts[i]!;
      });
      if (Object.keys(portfolio).length) p.portfolio = portfolio;
    }
    out[id] = p;
  }
  return out;
}

/** Counted clients by service: the people's counts, summed. */
function buildGroups(people: Record<string, EnginePerson>): Record<string, EngineClientGroup> {
  const count: Record<string, number> = {};
  for (const p of Object.values(people)) for (const [sid, n] of Object.entries(p.portfolio ?? {})) count[sid] = (count[sid] ?? 0) + n;
  const out: Record<string, EngineClientGroup> = {};
  for (const [sid, n] of Object.entries(count)) {
    const [dept, tier] = sid.split("-") as [Dept, Tier];
    const t = TIER_DATA[dept][tier];
    out[sid] = { count: n, fee: t.fee, churnMonthly: t.churn, stayMonths: Math.round(1 / t.churn), health: 80 };
  }
  return out;
}

// ---- named clients ------------------------------------------------------------------------------------------------

/** id, name, department, manager, fee, and the prototype's per-client values. `alsoOther` takes the other department's Tier 1 too. */
type ProtoNamed = [id: string, name: string, dept: Dept, owner: string, fee: number, extra?: { handH?: number; adhocP?: number; adhoc?: number; adhocMin?: number; meet?: number; channels?: number; alsoOther?: boolean }];

const NAMED: ProtoNamed[] = [
  ["n1", "Harbourline Group", "org", "laura", 13000, { handH: 3, adhocP: 1, adhoc: 8, meet: 4, alsoOther: true }],
  ["n2", "Meridian Finance", "org", "laura", 11000],
  ["n3", "Bluegum Education", "org", "laura", 9500],
  ["n4", "Kestrel Motors", "org", "karl", 12000, { handH: 4, adhocP: 1, adhoc: 10, adhocMin: 60 }],
  ["n5", "Atlas Legal", "org", "karl", 10000],
  ["n6", "Solace Dental", "org", "zach", 9000],
  ["n7", "Northwind Retail", "perf", "wendlley", 9000, { channels: 6, alsoOther: true }],
  ["n8", "Coastline Homes", "perf", "wendlley", 8000, { channels: 4 }],
  ["n9", "Pinnacle Mortgage", "perf", "wendlley", 7500, { channels: 4 }],
  ["n10", "Granite Super", "perf", "wendlley", 8500, { channels: 4 }],
  ["n11", "Larch & Co", "perf", "sophie", 7000, { channels: 3 }],
  ["n12", "Riverbend Health", "perf", "shrishti", 8000, { channels: 5, handH: 3, adhocP: 1, adhoc: 10 }],
  ["n13", "Summit Auto", "perf", "shrishti", 7500, { channels: 4 }],
];

function buildClients(): Record<string, EngineClient> {
  const out: Record<string, EngineClient> = {};
  for (const [id, name, dept, owner, fee, x] of NAMED) {
    const ownerRole = PEOPLE.find((p) => p[0] === owner)![2];
    const other: Dept = dept === "org" ? "perf" : "org";
    const c: EngineClient = {
      name,
      services: x?.alsoOther ? [capacityServiceId(dept, "T1"), capacityServiceId(other, "T1")] : [capacityServiceId(dept, "T1")],
      mrr: fee,
      assignments: { [ownerRole]: owner },
      manager: owner,
    };
    const o: NonNullable<EngineClient["overrides"]> = {};
    if (x?.adhocP !== undefined) o.adhocChance = x.adhocP;
    if (x?.adhoc !== undefined) o.adhocRequests = x.adhoc;
    if (x?.adhocMin !== undefined) o.adhocHours = x.adhocMin / 60;
    if (x?.meet !== undefined) o.meetings = x.meet;
    if (x?.channels !== undefined) o.channels = x.channels;
    if (Object.keys(o).length) c.overrides = o;
    if (x?.handH) c.handHoldingHours = { [ownerRole]: x.handH };
    out[id] = c;
  }
  return out;
}

// ---- the client's change list -------------------------------------------------------------------------------------

type ProtoChange = [id: string, kind: "automation" | "augmentation", name: string, adoption: number, effects: [step: string, part: "auto" | "aug", value: number, residualMin?: number][], extra?: { tiers?: string[]; startMonth?: number; rampMonths?: number }];

const CHANGES: ProtoChange[] = [
  ["pacing", "automation", "Unified pacing with alerts", 90, [["p1", "auto", 0.85, 2], ["p1", "aug", 1.5]]],
  ["anomaly", "automation", "Anomaly and threshold alerts", 80, [["p2", "auto", 0.7, 2]]],
  ["briefs-p", "augmentation", "Auto-generated implementation briefs", 80, [["p3", "auto", 0.6], ["p3", "aug", 1.8]]],
  ["prep-p", "augmentation", "Pre-call data collation and talking points", 80, [["p6", "auto", 0.8, 3], ["p6", "aug", 1.5]], { startMonth: 2, rampMonths: 1 }],
  ["comment", "augmentation", "Report commentary drafts", 70, [["p8", "auto", 0.7], ["p8", "aug", 2]]],
  ["deck", "automation", "Quarterly review deck generation", 80, [["p9", "auto", 0.8, 20]]],
  ["adqa", "automation", "Meta ad QA checker", 90, [["p5", "auto", 0.75, 2]]],
  ["briefs-o", "automation", "Content brief automation and freelancer handoff", 85, [["o3", "auto", 0.85, 2], ["o5", "auto", 0.6]]],
  ["vet", "automation", "AI link-domain pre-vetting", 90, [["o8", "auto", 0.8], ["o7", "auto", 0.3]]],
  ["linkops", "automation", "Link health monitor, publisher CRM, invoice chasing", 85, [["o9", "auto", 0.8, 1]]],
  ["report-o", "automation", "Report \"work completed / planned\" page", 90, [["o12", "auto", 0.7]]],
  ["prep-o", "augmentation", "Pre-call data collation (Organic)", 80, [["o1", "auto", 0.8, 3], ["o1", "aug", 1.5]]],
  ["slides", "automation", "Review slides for small clients", 70, [["o13", "auto", 0.8], ["o13", "aug", 1.5]], { tiers: ["T3"] }],
];

function buildChanges(): EngineStepChange[] {
  return CHANGES.map(([id, kind, name, adoption, effects, extra]) => ({
    id,
    name,
    kind,
    adoption: adoption / 100,
    startMonth: extra?.startMonth ?? 1,
    rampMonths: extra?.rampMonths ?? 0,
    ...(extra?.tiers ? { tiers: extra.tiers } : {}),
    effects: effects.map(([step, part, value, residualMin]) =>
      part === "auto"
        ? { step, part: "automatable" as const, remove: value, ...(residualMin ? { residualHours: residualMin / 60 } : {}) }
        : { step, part: "augmentable" as const, factor: value },
    ),
  }));
}

// ---- the model ----------------------------------------------------------------------------------------------------

/**
 * The prototype's example agency: two departments, three tiers each, 26 people, 13 named clients and the counted ones beside
 * them, the prototype's servicing steps with their work splits, and its list of 13 changes. Sales is a four-step pipeline
 * that wins about one lead in ten (the prototype's win rate), at 30 leads a month. Times in working hours.
 */
export function capacityModel(): EngineModel {
  const org = buildSteps("org", ORG_STEPS);
  const perf = buildSteps("perf", PERF_STEPS);
  const people = buildPeople();
  return {
    horizonWeeks: 52,
    hoursPerWeek: HOURS_PER_WEEK,
    leadsPerWeek: 30 / (52 / 12),
    activeClients: 0,
    churnMonthly: 0.02,
    retainer: 0,
    services: buildServices(),
    roles: ROLES,
    people,
    clients: buildClients(),
    clientGroups: buildGroups(people),
    clientMix: "groups-add",
    placeNewClients: "least-busy",
    servicingProcesses: { ...org.processes, ...perf.processes },
    changes: buildChanges(),
    entry: "qualify",
    sinks: { won: "won", lost: "lost" },
    ends: { done: { outcome: "done" } },
    steps: [
      { id: "qualify", name: "Lead arrives, call within 5 minutes", role: "sales", work: 0.25, wait: 0, rework: 0, next: [{ to: "discovery", p: 0.5 }, { to: "lost", p: 0.5 }] },
      { id: "discovery", name: "Discovery", role: "sales", work: 1, wait: 24, rework: 0, next: [{ to: "pitch", p: 0.5 }, { to: "lost", p: 0.5 }] },
      { id: "pitch", name: "Pitch or strategy", role: "sales", work: 3, wait: 40, rework: 0, next: [{ to: "contract", p: 0.4 }, { to: "lost", p: 0.6 }] },
      { id: "contract", name: "Contract and handover to delivery", role: "sales", work: 1, wait: 0, rework: 0, next: [{ to: "won", p: 1 }] },
      ...org.steps,
      ...perf.steps,
    ],
  };
}
