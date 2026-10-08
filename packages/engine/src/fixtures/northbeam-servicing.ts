// Northbeam's servicing processes as plain data (issue #19), shared by the
// engine's northbeamWithServicing() and the database seed fixture. No imports,
// so the seed scripts can load it directly with Node's type stripping
// (package export "./northbeam-servicing").

/** A step of a servicing process: a working step, the start, or the end (outcome done). */
export interface NorthbeamServicingStep {
  key: string;
  name: string;
  kind: "task" | "decision" | "start" | "end";
  /** Role key (NORTHBEAM_TEAM's roles); null for the start and end. */
  role: string | null;
  work: number;
  wait: number;
  tool: string | null;
  x: number;
  y: number;
}

/** A servicing process every Northbeam client runs, on both services, and how often. */
export interface NorthbeamServicingProcess {
  key: string;
  name: string;
  entityName: string;
  description: string;
  recurrence: { every: "week" | "month"; times: number };
  /** On time within this many working hours of the task starting. */
  slaHours: number;
  /** Working steps first, in the order the database ids sort, then the start and the end. */
  steps: NorthbeamServicingStep[];
  /** [from, to, probability, condition tag]. */
  edges: [string, string, number, string | null][];
}

/**
 * The monthly report carries the month's retainer work (it replaces the
 * services' fallback load, which is sized the same: strategy 1.5 h, SEO 16 h
 * or PPC 19 h, account manager 3 h of the 6 h and finance 1.2 h a client a
 * month); the fortnightly check-in is the account manager's other 3 h or so.
 * The report's specialist step follows the client's service by condition tag.
 */
export const NORTHBEAM_SERVICING: NorthbeamServicingProcess[] = [
  {
    key: "report",
    name: "Monthly report",
    entityName: "report",
    description: "Each client's month of retainer work, written up and sent with the invoice.",
    recurrence: { every: "month", times: 1 },
    slaHours: 40,
    steps: [
      { key: "report_strat", name: "Set the month's priorities", kind: "task", role: "strat", work: 1.5, wait: 0, tool: "Notion", x: 60, y: 50 },
      { key: "report_seo", name: "SEO work & report data", kind: "task", role: "seo", work: 16, wait: 0, tool: "Ahrefs, Looker Studio", x: 290, y: -22 },
      { key: "report_ppc", name: "PPC optimisation & report data", kind: "task", role: "ppc", work: 19, wait: 0, tool: "Google Ads, Looker Studio", x: 290, y: 120 },
      { key: "report_am", name: "Write & send the report", kind: "task", role: "am", work: 3, wait: 0, tool: "Google Docs", x: 520, y: 50 },
      { key: "report_fin", name: "Invoice", kind: "task", role: "fin", work: 1.2, wait: 0, tool: "Xero", x: 750, y: 50 },
      { key: "report_start", name: "Month starts", kind: "start", role: null, work: 0, wait: 0, tool: null, x: -150, y: 50 },
      { key: "report_sent", name: "Report sent", kind: "end", role: null, work: 0, wait: 0, tool: null, x: 980, y: 50 },
    ],
    edges: [
      ["report_start", "report_strat", 1, null],
      ["report_strat", "report_seo", 0.55, "seo"],
      ["report_strat", "report_ppc", 0.45, "ppc"],
      ["report_seo", "report_am", 1, null],
      ["report_ppc", "report_am", 1, null],
      ["report_am", "report_fin", 1, null],
      ["report_fin", "report_sent", 1, null],
    ],
  },
  {
    key: "checkin",
    name: "Client check-in",
    entityName: "check-in",
    description: "A fortnightly call with each client: questions, results, next steps.",
    recurrence: { every: "week", times: 0.5 },
    slaHours: 16,
    steps: [
      { key: "checkin_call", name: "Check-in call", kind: "task", role: "am", work: 1.5, wait: 0, tool: "Zoom", x: 290, y: 50 },
      { key: "checkin_start", name: "Check-in due", kind: "start", role: null, work: 0, wait: 0, tool: null, x: 60, y: 50 },
      { key: "checkin_done", name: "Done", kind: "end", role: null, work: 0, wait: 0, tool: null, x: 520, y: 50 },
    ],
    edges: [
      ["checkin_start", "checkin_call", 1, null],
      ["checkin_call", "checkin_done", 1, null],
    ],
  },
];
