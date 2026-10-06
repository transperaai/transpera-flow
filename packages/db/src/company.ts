// The company model (docs/PRD.md §4.1 "Company model"): settings, roles,
// people, services, clients and demand, as one value; how its fields are
// named and shown; and snapshots of it, so a saved run can say what has
// changed since it ran (decision D19, issue #25). Pure: no I/O, no clock.

import type { Viewer } from "./queries";
import type {
  ClientAssignmentRow,
  ClientRow,
  ClientServiceRow,
  DemandSettingsRow,
  LeadSourceRow,
  PersonLeaveRow,
  PersonRoleRow,
  PersonRow,
  ProcessBundle,
  RoleRow,
  SeasonalityRow,
  ServiceRow,
  SuggestionTarget,
  WorkspaceRow,
} from "./types";

/** Everything the company model holds, as the app and MCP server load it (a ProcessBundle has all of it). */
export interface CompanyModel {
  /** Who loaded it (B1 2/3). Absent means "sees everyone" (demo fixtures, tests, the golden models). */
  viewer?: Viewer;
  workspace: WorkspaceRow;
  roles: RoleRow[];
  people: PersonRow[];
  personRoles: PersonRoleRow[];
  personLeave: PersonLeaveRow[];
  services: ServiceRow[];
  clients: ClientRow[];
  clientServices: ClientServiceRow[];
  clientAssignments: ClientAssignmentRow[];
  leadSources: LeadSourceRow[];
  seasonality: SeasonalityRow[];
  demand: DemandSettingsRow | null;
}

/** The company model a process bundle carries. */
export function companyOf(bundle: ProcessBundle): CompanyModel {
  return {
    workspace: bundle.workspace,
    roles: bundle.roles,
    people: bundle.people,
    personRoles: bundle.personRoles,
    personLeave: bundle.personLeave,
    services: bundle.services,
    clients: bundle.clients ?? [],
    clientServices: bundle.clientServices ?? [],
    clientAssignments: bundle.clientAssignments ?? [],
    leadSources: bundle.leadSources ?? [],
    seasonality: bundle.seasonality ?? [],
    demand: bundle.demand ?? null,
  };
}

// ---------------------------------------------------------------------------
// Fields: labels and formats
// ---------------------------------------------------------------------------

export type FieldFormat = "number" | "money" | "percent" | "hours" | "perWeek" | "multiplier" | "date" | "text" | "bool" | "fte" | "months";

export interface FieldMeta {
  label: string;
  format: FieldFormat;
}

/** Tables of the company model with fields people see. */
export type CompanyTable = SuggestionTarget | "roles";

/**
 * Every company-model field a suggestion can set or a run snapshot records,
 * with its label and how to show it. For `workspaces` the fields are settings keys.
 */
export const COMPANY_FIELDS: Record<CompanyTable, Record<string, FieldMeta>> = {
  workspaces: {
    hours_per_week: { label: "Working hours a week", format: "number" },
    working_days: { label: "Working days a week", format: "number" },
    currency: { label: "Currency", format: "text" },
    fy_start: { label: "Financial year start", format: "text" },
    overhead_monthly: { label: "Overhead a month", format: "money" },
    target_margin: { label: "Target margin", format: "percent" },
    overtime_cap: { label: "Overtime cap", format: "percent" },
    availability_floor: { label: "Availability floor", format: "percent" },
    utilisation_threshold: { label: "Utilisation threshold", format: "percent" },
    capacity_factor_enabled: { label: "Capacity factors", format: "bool" },
    horizon_weeks: { label: "Simulation horizon (weeks)", format: "number" },
    leads_per_week: { label: "Leads a week (interim)", format: "perWeek" },
    active_clients: { label: "Active clients (interim)", format: "number" },
    churn_monthly: { label: "Monthly churn (interim)", format: "percent" },
    retainer: { label: "Retainer (interim)", format: "money" },
  },
  roles: {
    name: { label: "Name", format: "text" },
    headcount: { label: "Head-count", format: "number" },
    default_cost_rate: { label: "Cost rate", format: "money" },
    ongoing_hours_per_client_week: { label: "Hours per client a week", format: "hours" },
    active: { label: "Active", format: "bool" },
  },
  services: {
    name: { label: "Name", format: "text" },
    pricing_model: { label: "Pricing", format: "text" },
    price: { label: "Price", format: "money" },
    margin: { label: "Margin", format: "percent" },
    tenure_months: { label: "Typical tenure", format: "months" },
    churn_monthly_base: { label: "Base churn a month", format: "percent" },
    churn_health_sensitivity: { label: "Churn sensitivity to health", format: "number" },
    mix_share: { label: "Share of new work", format: "number" },
    active: { label: "Active", format: "bool" },
  },
  people: {
    name: { label: "Name", format: "text" },
    email: { label: "Email", format: "text" },
    fte: { label: "FTE", format: "fte" },
    capacity_hours_week: { label: "Capacity", format: "hours" },
    cost_rate: { label: "Cost rate", format: "money" },
    active: { label: "Active", format: "bool" },
    start_date: { label: "Start date", format: "date" },
    end_date: { label: "End date", format: "date" },
    notes: { label: "Notes", format: "text" },
  },
  clients: {
    name: { label: "Name", format: "text" },
    start_date: { label: "Client since", format: "date" },
    mrr: { label: "MRR", format: "money" },
    health: { label: "Health", format: "number" },
    notes: { label: "Notes", format: "text" },
    active: { label: "Active", format: "bool" },
  },
  lead_sources: {
    name: { label: "Name", format: "text" },
    volume_week: { label: "Lead volume", format: "perWeek" },
    conversion_to_qualified: { label: "Conversion to qualified", format: "percent" },
  },
  seasonality: {
    month: { label: "Month", format: "number" },
    multiplier: { label: "Seasonality", format: "multiplier" },
  },
  demand_settings: {
    growth_monthly: { label: "Growth a month", format: "percent" },
  },
};

export const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

const trim = (v: number, digits: number) => Number(v.toFixed(digits)).toString();

/** A value as people read it ("£3,500", "45%", "15/wk", "×1.2"). Null shows as "not set". */
export function formatCompanyValue(format: FieldFormat, value: unknown, currency = "GBP"): string {
  if (value === null || value === undefined || value === "") return "not set";
  if (format === "bool") return value ? "yes" : "no";
  if (format === "text" || format === "date" || typeof value !== "number") return String(value);
  switch (format) {
    case "money":
      try {
        return new Intl.NumberFormat("en-GB", { style: "currency", currency, maximumFractionDigits: 0 }).format(value);
      } catch {
        return `${currency} ${Math.round(value).toLocaleString("en-GB")}`;
      }
    case "percent":
      return `${trim(value * 100, 1)}%`;
    case "hours":
      return `${trim(value, 1)} h/wk`;
    case "perWeek":
      return `${trim(value, 2)}/wk`;
    case "multiplier":
      return `×${trim(value, 2)}`;
    case "fte":
      return trim(value, 2);
    case "months":
      return `${trim(value, 1)} months`;
    default:
      return trim(value, 2);
  }
}

/** A field's label and formatted value, with a fallback for unknown fields. */
export function fieldMeta(table: CompanyTable, field: string): FieldMeta {
  return COMPANY_FIELDS[table][field] ?? { label: field.replace(/_/g, " "), format: "text" };
}

// ---------------------------------------------------------------------------
// Snapshots and what changed since
// ---------------------------------------------------------------------------

type Scalar = string | number | boolean | null;

/** A process revision a run used. */
export interface SnapshotProcess {
  id: string;
  name: string;
  revision_id: string;
  revision: number;
}

/**
 * The company model and process revisions a run used, as saved with the run
 * (`runs.params_snapshot`). Keyed by id so it diffs field by field; names are
 * kept so a change can be described after the thing is gone.
 */
export interface ModelSnapshot {
  version: 1;
  currency: string;
  settings: Record<string, Scalar>;
  roles: Record<string, Record<string, Scalar>>;
  people: Record<string, Record<string, Scalar | string[]>>;
  services: Record<string, Record<string, Scalar>>;
  clients: Record<string, Record<string, Scalar | string[] | Record<string, string>>>;
  lead_sources: Record<string, Record<string, Scalar>>;
  /** Month (1–12) → multiplier; months with no row are 1. */
  seasonality: Record<string, number>;
  growth_monthly: number;
  processes: Record<string, { name: string; revision_id: string; revision: number }>;
}

const pick = <T extends object>(row: T, fields: readonly string[]): Record<string, Scalar> =>
  Object.fromEntries(fields.map((f) => [f, ((row as Record<string, unknown>)[f] ?? null) as Scalar]));

const num = (v: unknown) => (typeof v === "string" && v !== "" && !Number.isNaN(Number(v)) ? Number(v) : v);
const numbers = (r: Record<string, Scalar>) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, num(v) as Scalar]));

const ROLE_FIELDS = ["name", "headcount", "default_cost_rate", "ongoing_hours_per_client_week"] as const;
const PERSON_FIELDS = ["name", "fte", "capacity_hours_week", "cost_rate", "active", "start_date", "end_date"] as const;
const SERVICE_FIELDS = ["name", "pricing_model", "price", "margin", "tenure_months", "churn_monthly_base", "mix_share", "active"] as const;
const CLIENT_FIELDS = ["name", "mrr", "health", "active", "start_date"] as const;
const LEAD_SOURCE_FIELDS = ["name", "volume_week", "conversion_to_qualified"] as const;

/** Snapshot the company model (and the process revisions used) for a saved run. */
export function snapshotModel(model: CompanyModel, processes: readonly SnapshotProcess[] = []): ModelSnapshot {
  const byId = <T extends { id: string }>(rows: readonly T[], f: (r: T) => Record<string, unknown>) =>
    Object.fromEntries([...rows].sort((a, b) => a.id.localeCompare(b.id)).map((r) => [r.id, f(r)]));
  const settings = model.workspace.settings as unknown as Record<string, unknown>;
  return {
    version: 1,
    currency: model.workspace.settings.currency || "GBP",
    settings: Object.fromEntries(
      Object.keys(COMPANY_FIELDS.workspaces)
        .filter((k) => settings[k] !== undefined)
        .map((k) => [k, num(settings[k]) as Scalar]),
    ),
    roles: byId(model.roles, (r) => numbers(pick(r, ROLE_FIELDS))) as ModelSnapshot["roles"],
    people: byId(model.people, (p) => ({
      ...numbers(pick(p, PERSON_FIELDS)),
      roles: model.personRoles.filter((x) => x.person_id === p.id).map((x) => x.role_id).sort(),
      leave: model.personLeave
        .filter((x) => x.person_id === p.id)
        .map((x) => `${x.start_date}–${x.end_date}`)
        .sort(),
    })) as ModelSnapshot["people"],
    services: byId(model.services, (s) => numbers(pick(s, SERVICE_FIELDS))) as ModelSnapshot["services"],
    clients: byId(model.clients, (c) => ({
      ...numbers(pick(c, CLIENT_FIELDS)),
      services: model.clientServices.filter((x) => x.client_id === c.id).map((x) => x.service_id).sort(),
      assignments: Object.fromEntries(
        model.clientAssignments
          .filter((x) => x.client_id === c.id)
          .sort((a, b) => a.role_id.localeCompare(b.role_id))
          .map((x) => [x.role_id, x.person_id]),
      ),
    })) as ModelSnapshot["clients"],
    lead_sources: byId(model.leadSources, (l) => numbers(pick(l, LEAD_SOURCE_FIELDS))) as ModelSnapshot["lead_sources"],
    seasonality: Object.fromEntries(
      [...model.seasonality].sort((a, b) => a.month - b.month).map((m) => [String(m.month), Number(m.multiplier)]),
    ),
    growth_monthly: Number(model.demand?.growth_monthly ?? 0),
    processes: Object.fromEntries(
      [...processes].sort((a, b) => a.id.localeCompare(b.id)).map((p) => [p.id, { name: p.name, revision_id: p.revision_id, revision: p.revision }]),
    ),
  };
}

export type ChangeSection = "settings" | "roles" | "people" | "services" | "clients" | "lead_sources" | "seasonality" | "demand" | "processes";

/** One thing that differs between a run's snapshot and the model now. */
export interface ModelChange {
  section: ChangeSection;
  /** The row's id (the month for seasonality, the key for settings). */
  id: string;
  kind: "added" | "removed" | "changed";
  field?: string;
  /** Formatted values. */
  before?: string;
  after?: string;
  /** "Lead source Client referrals: lead volume 3/wk → 15/wk". */
  text: string;
}

const SECTION_NOUN: Record<Exclude<ChangeSection, "settings" | "seasonality" | "demand">, string> = {
  roles: "Role",
  people: "Person",
  services: "Service",
  clients: "Client",
  lead_sources: "Lead source",
  processes: "Process",
};

const TABLE_OF: Record<"roles" | "people" | "services" | "clients" | "lead_sources", CompanyTable> = {
  roles: "roles",
  people: "people",
  services: "services",
  clients: "clients",
  lead_sources: "lead_sources",
};

/** "Lead volume" → "lead volume"; acronyms ("FTE", "MRR") stay as they are. */
export const lowerFirst = (s: string) => (/^[A-Z][a-z]/.test(s) ? s[0]!.toLowerCase() + s.slice(1) : s);

/**
 * What changed between two snapshots (a saved run's and the model now), in a
 * stable order: settings, demand, processes, then each table's rows by name.
 * Values are formatted in the later snapshot's currency.
 */
export function diffSnapshots(before: ModelSnapshot, after: ModelSnapshot): ModelChange[] {
  const currency = after.currency || before.currency || "GBP";
  const out: ModelChange[] = [];
  const fmt = (table: CompanyTable, field: string, v: unknown) => formatCompanyValue(fieldMeta(table, field).format, v, currency);
  const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  const nameOf = (section: "roles" | "people" | "services", id: string) =>
    String(after[section][id]?.name ?? before[section][id]?.name ?? "someone no longer in the model");

  // Settings.
  for (const key of Object.keys(COMPANY_FIELDS.workspaces)) {
    const a = before.settings[key];
    const b = after.settings[key];
    if (a === undefined && b === undefined) continue;
    if (!same(a, b)) {
      const meta = fieldMeta("workspaces", key);
      out.push({
        section: "settings",
        id: key,
        kind: "changed",
        field: key,
        before: fmt("workspaces", key, a),
        after: fmt("workspaces", key, b),
        text: `${meta.label}: ${fmt("workspaces", key, a)} → ${fmt("workspaces", key, b)}`,
      });
    }
  }

  // Demand growth and seasonality.
  if (!same(before.growth_monthly, after.growth_monthly)) {
    const f = (v: number) => fmt("demand_settings", "growth_monthly", v);
    out.push({
      section: "demand",
      id: "growth_monthly",
      kind: "changed",
      field: "growth_monthly",
      before: f(before.growth_monthly),
      after: f(after.growth_monthly),
      text: `Demand growth: ${f(before.growth_monthly)} a month → ${f(after.growth_monthly)} a month`,
    });
  }
  for (let m = 1; m <= 12; m++) {
    const a = before.seasonality[String(m)] ?? 1;
    const b = after.seasonality[String(m)] ?? 1;
    if (a !== b) {
      const f = (v: number) => fmt("seasonality", "multiplier", v);
      out.push({
        section: "seasonality",
        id: String(m),
        kind: "changed",
        field: "multiplier",
        before: f(a),
        after: f(b),
        text: `Seasonality in ${MONTH_NAMES[m - 1]}: ${f(a)} → ${f(b)}`,
      });
    }
  }

  // Process revisions.
  for (const id of new Set([...Object.keys(before.processes), ...Object.keys(after.processes)])) {
    const a = before.processes[id];
    const b = after.processes[id];
    if (a && b && a.revision_id !== b.revision_id) {
      out.push({
        section: "processes",
        id,
        kind: "changed",
        field: "revision",
        before: `revision ${a.revision}`,
        after: `revision ${b.revision}`,
        text: `${b.name}: revision ${b.revision} published since this run used revision ${a.revision}`,
      });
    } else if (a && !b) {
      out.push({ section: "processes", id, kind: "removed", text: `${a.name}: no longer has a live revision` });
    }
  }

  // Rows, table by table.
  // A set held in link rows: roles and services by name, leave as date ranges.
  const listed = (field: "roles" | "services" | "leave", ids: unknown): string => {
    const list = Array.isArray(ids) ? (ids as string[]) : [];
    const names = field === "leave" ? list : list.map((id) => nameOf(field, id)).sort();
    return names.join(", ") || "none";
  };
  for (const section of ["roles", "services", "people", "clients", "lead_sources"] as const) {
    const table = TABLE_OF[section];
    const a = before[section] as Record<string, Record<string, unknown>>;
    const b = after[section] as Record<string, Record<string, unknown>>;
    const ids = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort((x, y) =>
      String(b[x]?.name ?? a[x]?.name ?? x).localeCompare(String(b[y]?.name ?? a[y]?.name ?? y)),
    );
    for (const id of ids) {
      const was = a[id];
      const now = b[id];
      const noun = SECTION_NOUN[section];
      if (!was && now) {
        out.push({ section, id, kind: "added", text: `${noun} added: ${String(now.name)}` });
        continue;
      }
      if (was && !now) {
        out.push({ section, id, kind: "removed", text: `${noun} removed: ${String(was.name)}` });
        continue;
      }
      if (!was || !now) continue;
      const name = String(now.name);
      for (const field of new Set([...Object.keys(was), ...Object.keys(now)])) {
        if (same(was[field], now[field])) continue;
        if (field === "assignments") {
          const wa = (was[field] ?? {}) as Record<string, string>;
          const na = (now[field] ?? {}) as Record<string, string>;
          for (const role of [...new Set([...Object.keys(wa), ...Object.keys(na)])].sort()) {
            if (wa[role] === na[role]) continue;
            const f = (p: string | undefined) => (p ? nameOf("people", p) : "nobody");
            out.push({
              section,
              id,
              kind: "changed",
              field: `assignments.${role}`,
              before: f(wa[role]),
              after: f(na[role]),
              text: `${noun} ${name}: ${nameOf("roles", role)} ${f(wa[role])} → ${f(na[role])}`,
            });
          }
          continue;
        }
        if (field === "roles" || field === "services" || field === "leave") {
          const from = listed(field, was[field]);
          const to = listed(field, now[field]);
          out.push({ section, id, kind: "changed", field, before: from, after: to, text: `${noun} ${name}: ${field} ${from} → ${to}` });
          continue;
        }
        const meta = fieldMeta(table, field);
        const from = fmt(table, field, was[field]);
        const to = fmt(table, field, now[field]);
        out.push({
          section,
          id,
          kind: "changed",
          field,
          before: from,
          after: to,
          text:
            field === "name"
              ? `${noun} ${String(was.name)} renamed to ${to}`
              : `${noun} ${name}: ${lowerFirst(meta.label)} ${from} → ${to}`,
        });
      }
    }
  }
  return out;
}
