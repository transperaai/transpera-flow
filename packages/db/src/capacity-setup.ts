// Capacity Set up (work package P1, migration 20270119000000_capacity_setup.sql): loaders for the two Set up screens, the rules the
// screens' fields are checked against, and the pure helpers that turn the stored rows into the figures Set up shows (a tier's client
// count, unique clients, and what isn't entered yet).
//
// THIS ONLY STORES AND SHOWS. Nothing here reaches `toEngineModel` (the engine's inputs are unchanged until P2 wires the columns in).
// Column names are chosen so the later mapping is plain (docs/plans/capacity/p23-interface-brief.md section 1):
//
//   services.department_id / tier_id    EngineService.department / tier   (a service is one tier of one department)
//   services.words … channels           EngineService.deliverables.{words, links, techHours, meetings, builds, creativeSets, channels}
//   services.adhoc_chance / _requests   EngineService.adhoc.{chance, requests}
//   services.price / churn_monthly_base EngineService price / churnMonthly (as today)
//   services.price_rise_churn           not in the engine yet (D36, P7)
//   clients.<same names> + adhoc_hours  EngineClient.overrides.{…deliverables, adhoc.chance, adhoc.requests, adhocHours, stepFactor}
//   clients.hand_holding_hours          EngineClient.handHoldingHours (per role: P2 decides which role holds it)
//   people.reserved_share               EnginePerson.reservedShare
//   people.ramp / workspace ramp_default EnginePerson.ramp (null = the workspace default)
//   person_tiers                        EnginePerson.tiers (tier keys)
//   person_portfolio                    EnginePerson.portfolio (service id → counted clients)
//   roles.unit                          EngineRole.unit.label (perHour is blank until Joe keys a rate, D35)
//   roles.line / rule_of_thumb          the busy line (D17) and the max-clients rule of thumb (reporting)
//   tiers.both_count                    not an engine input: it only feeds the unique-clients figure (D23)

import type { Db } from "./queries";
import { rpc } from "./rpc";
import type { Json } from "./db-types";

// ---------------------------------------------------------------------------------------------------------------------
// Vocabulary

/** Where a number came from. `entered` is a person's own typing; the rest are labels the Set up screens show. */
export const SETUP_SOURCES = ["entered", "interview", "calculator", "measured", "estimate"] as const;
export type SetupSource = (typeof SETUP_SOURCES)[number];

/** The label to show beside a number: nothing for `entered` or no provenance, otherwise the source in words. */
export function sourceLabel(provenance: unknown, column: string): string | null {
  const p = provenance && typeof provenance === "object" ? (provenance as Record<string, unknown>)[column] : undefined;
  const source = p && typeof p === "object" ? (p as { source?: unknown }).source : undefined;
  if (typeof source !== "string" || source === "entered") return null;
  if (source === "estimate" || source === "estimated") return "Estimate";
  if (source === "interview") return "From an interview";
  if (source === "calculator") return "From the calculator";
  if (source === "measured") return "Measured";
  return null;
}

/** A tier's deliverables, per client a month. */
export const DELIVERABLE_COLUMNS = ["words", "links", "tech_hours", "meetings", "builds", "creative_sets", "channels"] as const;
export type DeliverableColumn = (typeof DELIVERABLE_COLUMNS)[number];

/** What each kind of department fills in per tier (the prototype's two tables), in column order. Fee and churn are in both. */
export const ORGANIC_TIER_FIELDS = ["words", "links", "tech_hours", "meetings", "adhoc_chance", "adhoc_requests"] as const;
export const PERFORMANCE_TIER_FIELDS = ["channels", "builds", "creative_sets", "meetings", "adhoc_chance", "adhoc_requests"] as const;
export type TierField = (typeof ORGANIC_TIER_FIELDS)[number] | (typeof PERFORMANCE_TIER_FIELDS)[number];

/** Which fields a department's tier table has: Performance (by name) has channels, builds and creative sets; any other, the Organic set. */
export function tierFieldsFor(departmentName: string): readonly TierField[] {
  return /^\s*perf/i.test(departmentName) ? PERFORMANCE_TIER_FIELDS : ORGANIC_TIER_FIELDS;
}

/** Overrides a named client may carry (null: use the tier's), in the order the screen shows them. */
export const CLIENT_OVERRIDE_COLUMNS = [
  "channels", "hand_holding_hours", "adhoc_chance", "adhoc_requests", "adhoc_hours", "meetings", "words", "links", "tech_hours", "builds", "creative_sets", "step_factor",
] as const;
export type ClientOverrideColumn = (typeof CLIENT_OVERRIDE_COLUMNS)[number];

/** What a shared team can work in (D27); the unit is free text, these are the suggestions. */
export const SHARED_UNITS = ["words", "links", "ticket hours", "tasks", "set-ups and incidents", "hours"] as const;

export const ROLE_KINDS = ["client_facing", "shared"] as const;
export type RoleKind = (typeof ROLE_KINDS)[number];
export const PERSON_LABELS = ["contractor", "offshore"] as const;
export type PersonLabel = (typeof PERSON_LABELS)[number];

// ---------------------------------------------------------------------------------------------------------------------
// The shape of what the Set up screens load

type Prov = Record<string, unknown>;

export interface SetupDepartment {
  id: string;
  name: string;
  sort: number;
}
export interface SetupTier {
  id: string;
  key: string;
  name: string;
  sort: number;
  both_count: number;
  provenance: Prov;
}
export interface SetupService {
  id: string;
  name: string;
  active: boolean;
  department_id: string | null;
  tier_id: string | null;
  pricing_model: string;
  /** The fee a client pays a month. */
  price: number;
  price_low: number | null;
  price_high: number | null;
  margin: number;
  tenure_months: number;
  churn_monthly_base: number;
  churn_health_sensitivity: number;
  mix_share: number;
  entry_process_id: string | null;
  path_tags: string[];
  words: number | null;
  links: number | null;
  tech_hours: number | null;
  meetings: number | null;
  builds: number | null;
  creative_sets: number | null;
  channels: number | null;
  adhoc_chance: number | null;
  adhoc_requests: number | null;
  price_rise_churn: number;
  provenance: Prov;
}
export interface SetupGroup {
  id: string;
  service_id: string;
  client_count: number;
  provenance: Prov;
}
export interface SetupClient {
  id: string;
  name: string;
  active: boolean;
  mrr: number;
  start_date: string | null;
  health: number | null;
  notes: string | null;
  provenance: Prov;
  /** Services the client takes (client_services). */
  service_ids: string[];
  /** Who looks after the client in each role (client_assignments): role id → person id. */
  assignments: Record<string, string>;
  channels: number | null;
  hand_holding_hours: number | null;
  adhoc_chance: number | null;
  adhoc_requests: number | null;
  adhoc_hours: number | null;
  meetings: number | null;
  words: number | null;
  links: number | null;
  tech_hours: number | null;
  builds: number | null;
  creative_sets: number | null;
  step_factor: number | null;
}
export interface SetupRole {
  id: string;
  name: string;
  color: string | null;
  active: boolean;
  default_cost_rate: number;
  headcount: number;
  ongoing_hours_per_client_week: number;
  department_id: string | null;
  kind: RoleKind;
  line: number;
  rule_of_thumb: number | null;
  unit: string | null;
  provenance: Prov;
}
export interface SetupPerson {
  id: string;
  name: string;
  email: string | null;
  active: boolean;
  fte: number;
  capacity_hours_week: number | null;
  cost_rate: number | null;
  start_date: string | null;
  end_date: string | null;
  notes: string | null;
  reserved_share: number;
  /** Null for everyone when the viewer can't see pay (`payHidden`). */
  salary_monthly: number | null;
  label: PersonLabel | null;
  ramp: number[] | null;
  provenance: Prov;
  role_ids: string[];
  tier_ids: string[];
}
export interface SetupPortfolioRow {
  person_id: string;
  service_id: string;
  client_count: number;
  provenance: Prov;
}

/** Everything the two Set up screens show, read as the signed-in user (row-level security decides what that is). */
export interface CapacitySetup {
  workspaceId: string;
  currency: string;
  departments: SetupDepartment[];
  tiers: SetupTier[];
  services: SetupService[];
  groups: SetupGroup[];
  clients: SetupClient[];
  roles: SetupRole[];
  people: SetupPerson[];
  portfolio: SetupPortfolioRow[];
  /** `settings.ramp_default`, or the built-in default. */
  rampDefault: number[];
  rampDefaultProvenance: unknown;
  /** `settings.dler_includes_leadership`; true when never set. */
  dlerIncludesLeadership: boolean;
  dlerProvenance: unknown;
  /** Whether the viewer may change anything here (Owner and Agency admins). */
  canEdit: boolean;
  /** True when the viewer can't see pay: every salary is null and the column is not shown. */
  payHidden: boolean;
}

/** New starters reach about 80% in three months (the prototype: 40%, 60%, 80% in months 1 to 3, then full). */
export const DEFAULT_RAMP: readonly number[] = [0.4, 0.6, 0.8];

const num = (v: unknown): number | null => (v == null ? null : Number(v));
const prov = (v: unknown): Prov => (v && typeof v === "object" && !Array.isArray(v) ? (v as Prov) : {});
const numList = (v: unknown): number[] | null => (Array.isArray(v) && v.every((x) => typeof x === "number") ? (v as number[]) : null);

/** Reads everything the Set up screens show. Null when the workspace isn't readable by the caller. */
export async function loadCapacitySetup(db: Db, workspaceId: string): Promise<CapacitySetup | null> {
  const workspace = await db.selectFrom("workspaces").select(["settings", "provenance"]).where("id", "=", workspaceId).executeTakeFirst();
  if (!workspace) return null;
  const [canEdit, canSeePeople, departments, tiers, services, groups, clients, clientServices, clientAssignments, roles, people, personRoles, personTiers, portfolio] = await Promise.all([
    rpc(db, "can_edit_workspace", { ws: workspaceId }),
    rpc(db, "can_see_people", { ws: workspaceId }),
    db.selectFrom("departments").select(["id", "name", "sort"]).where("workspace_id", "=", workspaceId).orderBy("sort").orderBy("name").execute(),
    db.selectFrom("tiers").select(["id", "key", "name", "sort", "both_count", "provenance"]).where("workspace_id", "=", workspaceId).orderBy("sort").orderBy("key").execute(),
    db
      .selectFrom("services")
      .select([
        "id", "name", "active", "department_id", "tier_id", "pricing_model", "price", "price_low", "price_high", "margin", "tenure_months", "churn_monthly_base",
        "churn_health_sensitivity", "mix_share", "entry_process_id", "path_tags", "words", "links", "tech_hours", "meetings", "builds", "creative_sets", "channels",
        "adhoc_chance", "adhoc_requests", "price_rise_churn", "provenance",
      ])
      .where("workspace_id", "=", workspaceId)
      .orderBy("created_at")
      .orderBy("id")
      .execute(),
    db.selectFrom("client_groups").select(["id", "service_id", "client_count", "provenance"]).where("workspace_id", "=", workspaceId).execute(),
    db
      .selectFrom("clients")
      .select([
        "id", "name", "active", "mrr", "start_date", "health", "notes", "provenance", ...CLIENT_OVERRIDE_COLUMNS,
      ])
      .where("workspace_id", "=", workspaceId)
      .orderBy("created_at")
      .orderBy("id")
      .execute(),
    db.selectFrom("client_services").select(["client_id", "service_id"]).where("workspace_id", "=", workspaceId).execute(),
    db.selectFrom("client_assignments").select(["client_id", "role_id", "person_id"]).where("workspace_id", "=", workspaceId).execute(),
    db
      .selectFrom("roles")
      .select([
        "id", "name", "color", "active", "default_cost_rate", "headcount", "ongoing_hours_per_client_week", "department_id", "kind", "line", "rule_of_thumb", "unit", "provenance",
      ])
      .where("workspace_id", "=", workspaceId)
      .orderBy("created_at")
      .orderBy("id")
      .execute(),
    db
      .selectFrom("people")
      .select([
        "id", "name", "email", "active", "fte", "capacity_hours_week", "cost_rate", "start_date", "end_date", "notes", "reserved_share", "salary_monthly", "label", "ramp", "provenance",
      ])
      .where("workspace_id", "=", workspaceId)
      .orderBy("name")
      .orderBy("id")
      .execute(),
    db.selectFrom("person_roles").select(["person_id", "role_id"]).where("workspace_id", "=", workspaceId).execute(),
    db.selectFrom("person_tiers").select(["person_id", "tier_id"]).where("workspace_id", "=", workspaceId).execute(),
    db.selectFrom("person_portfolio").select(["person_id", "service_id", "client_count", "provenance"]).where("workspace_id", "=", workspaceId).execute(),
  ]);

  const settings = (workspace.settings ?? {}) as Record<string, unknown>;
  const wsProv = prov(workspace.provenance);
  const hidden = !canSeePeople;
  const servicesOf = new Map<string, string[]>();
  for (const r of clientServices) servicesOf.set(r.client_id, [...(servicesOf.get(r.client_id) ?? []), r.service_id]);
  const assignmentsOf = new Map<string, Record<string, string>>();
  for (const r of clientAssignments) assignmentsOf.set(r.client_id, { ...(assignmentsOf.get(r.client_id) ?? {}), [r.role_id]: r.person_id });
  const group = <T extends { person_id: string }>(rows: T[]) => {
    const m = new Map<string, T[]>();
    for (const r of rows) m.set(r.person_id, [...(m.get(r.person_id) ?? []), r]);
    return m;
  };
  const rolesOf = group(personRoles);
  const tiersOf = group(personTiers);

  return {
    workspaceId,
    currency: typeof settings.currency === "string" ? settings.currency : "USD",
    departments,
    tiers: tiers.map((t) => ({ ...t, provenance: prov(t.provenance) })),
    services: services.map((s) => ({
      ...s,
      price: Number(s.price),
      price_low: num(s.price_low),
      price_high: num(s.price_high),
      margin: Number(s.margin),
      tenure_months: Number(s.tenure_months),
      churn_monthly_base: Number(s.churn_monthly_base),
      churn_health_sensitivity: Number(s.churn_health_sensitivity),
      mix_share: Number(s.mix_share),
      words: num(s.words),
      links: num(s.links),
      tech_hours: num(s.tech_hours),
      meetings: num(s.meetings),
      builds: num(s.builds),
      creative_sets: num(s.creative_sets),
      channels: num(s.channels),
      adhoc_chance: num(s.adhoc_chance),
      adhoc_requests: num(s.adhoc_requests),
      price_rise_churn: Number(s.price_rise_churn),
      provenance: prov(s.provenance),
    })),
    groups: groups.map((g) => ({ ...g, provenance: prov(g.provenance) })),
    clients: clients.map((c) => ({
      id: c.id,
      name: c.name,
      active: c.active,
      mrr: Number(c.mrr),
      start_date: c.start_date,
      health: num(c.health),
      notes: c.notes,
      provenance: prov(c.provenance),
      service_ids: servicesOf.get(c.id) ?? [],
      assignments: assignmentsOf.get(c.id) ?? {},
      channels: num(c.channels),
      hand_holding_hours: num(c.hand_holding_hours),
      adhoc_chance: num(c.adhoc_chance),
      adhoc_requests: num(c.adhoc_requests),
      adhoc_hours: num(c.adhoc_hours),
      meetings: num(c.meetings),
      words: num(c.words),
      links: num(c.links),
      tech_hours: num(c.tech_hours),
      builds: num(c.builds),
      creative_sets: num(c.creative_sets),
      step_factor: num(c.step_factor),
    })),
    roles: roles.map((r) => ({
      ...r,
      default_cost_rate: Number(r.default_cost_rate),
      line: Number(r.line),
      kind: r.kind === "shared" ? "shared" : "client_facing",
      provenance: prov(r.provenance),
    })),
    people: people.map((p) => ({
      id: p.id,
      name: p.name,
      email: p.email,
      active: p.active,
      fte: Number(p.fte),
      capacity_hours_week: num(p.capacity_hours_week),
      cost_rate: hidden ? null : num(p.cost_rate),
      start_date: p.start_date,
      end_date: p.end_date,
      notes: p.notes,
      reserved_share: Number(p.reserved_share),
      salary_monthly: hidden ? null : num(p.salary_monthly),
      label: p.label === "contractor" || p.label === "offshore" ? p.label : null,
      ramp: numList(p.ramp as Json),
      provenance: prov(p.provenance),
      role_ids: (rolesOf.get(p.id) ?? []).map((r) => r.role_id),
      tier_ids: (tiersOf.get(p.id) ?? []).map((r) => r.tier_id),
    })),
    portfolio: portfolio.map((r) => ({ ...r, provenance: prov(r.provenance) })),
    rampDefault: numList(settings.ramp_default) ?? [...DEFAULT_RAMP],
    rampDefaultProvenance: wsProv["settings.ramp_default"] ?? null,
    dlerIncludesLeadership: settings.dler_includes_leadership !== false,
    dlerProvenance: wsProv["settings.dler_includes_leadership"] ?? null,
    canEdit: canEdit === true,
    payHidden: hidden,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Tiers: adding and removing (the database functions do the work and refuse in plain words)

export type TierOutcome<T = undefined> = { ok: true; value: T } | { ok: false; message: string; inUse: boolean };

/** The plain message of a database refusal that is meant to be read (the tier functions' own), else a generic one. */
function refusal(err: unknown): { message: string; inUse: boolean } {
  const e = err as { code?: string; message?: string; hint?: string };
  if (e?.code === "23514" && e.hint === "tier_in_use" && e.message) return { message: e.message, inUse: true };
  if (e?.code === "42501" && e.message) return { message: e.message, inUse: false };
  if (e?.code === "P0002" && e.message) return { message: e.message, inUse: false };
  return { message: "Couldn't change the tiers. Try again.", inUse: false };
}

/** Adds the next tier (a copy of the last one's values for each department). */
export async function addTier(db: Db, workspaceId: string): Promise<TierOutcome<string>> {
  try {
    const id = await rpc(db, "add_tier", { p_workspace: workspaceId });
    return { ok: true, value: String(id) };
  } catch (err) {
    return { ok: false, ...refusal(err) };
  }
}

/** Removes a tier and its services; refused, with the reason, while anything still depends on it. */
export async function removeTier(db: Db, tierId: string): Promise<TierOutcome> {
  try {
    await rpc(db, "remove_tier", { p_tier: tierId });
    return { ok: true, value: undefined };
  } catch (err) {
    return { ok: false, ...refusal(err) };
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// The fields the screens save (through `save_fields`, the compare-and-set function: concurrent saves never clobber)

/** A rule a typed value is checked against before it is sent; the database checks the same range. */
export type FieldRule =
  | { type: "number"; min: number; max: number; nullable?: boolean; integer?: boolean }
  | { type: "text"; max: number; nullable?: boolean }
  | { type: "enum"; values: readonly string[]; nullable?: boolean }
  | { type: "id"; nullable?: boolean }
  | { type: "ramp"; nullable?: boolean };

const n = (min: number, max: number, nullable = false, integer = false): FieldRule => ({ type: "number", min, max, nullable, integer });
const share = (nullable = false): FieldRule => n(0, 1, nullable);
const amount = (nullable = false): FieldRule => n(0, 100_000_000, nullable);
const count = (nullable = false): FieldRule => n(0, 100_000, nullable);
const text = (max: number, nullable = false): FieldRule => ({ type: "text", max, nullable });

const DELIVERABLES = Object.fromEntries(DELIVERABLE_COLUMNS.map((c) => [c, count(true)])) as Record<DeliverableColumn, FieldRule>;

/** Table → column → rule: the columns the Set up screens save with `save_fields`. */
export const SETUP_FIELDS = {
  departments: { name: text(100) },
  tiers: { name: text(100), key: text(20), both_count: n(0, 100_000, false, true) },
  services: {
    ...DELIVERABLES,
    name: text(200),
    price: amount(),
    price_low: amount(true),
    price_high: amount(true),
    churn_monthly_base: share(),
    adhoc_chance: share(true),
    adhoc_requests: count(true),
    price_rise_churn: n(0, 10),
  },
  clients: {
    name: text(200),
    mrr: amount(),
    channels: count(true),
    hand_holding_hours: count(true),
    adhoc_chance: share(true),
    adhoc_requests: count(true),
    adhoc_hours: count(true),
    meetings: count(true),
    words: count(true),
    links: count(true),
    tech_hours: count(true),
    builds: count(true),
    creative_sets: count(true),
    step_factor: n(0.01, 20, true),
  },
  people: {
    capacity_hours_week: n(0.5, 168, true),
    reserved_share: n(0, 0.9),
    salary_monthly: amount(true),
    label: { type: "enum", values: PERSON_LABELS, nullable: true },
    ramp: { type: "ramp", nullable: true },
  },
  roles: {
    department_id: { type: "id", nullable: true },
    kind: { type: "enum", values: ROLE_KINDS },
    line: n(0.01, 1.5),
    rule_of_thumb: n(1, 10_000, true, true),
    unit: text(60, true),
  },
  person_portfolio: { client_count: n(0, 100_000, false, true) },
} as const satisfies Record<string, Record<string, FieldRule>>;
export type SetupTable = keyof typeof SETUP_FIELDS;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Checks one typed value against its rule; the cleaned value (text trimmed, empty text as null where allowed), or "invalid". */
export function checkSetupValue(rule: FieldRule, value: unknown): { ok: true; value: string | number | number[] | null } | { ok: false } {
  if (value === null || value === undefined) return rule.nullable ? { ok: true, value: null } : { ok: false };
  switch (rule.type) {
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value) || value < rule.min || value > rule.max) return { ok: false };
      if (rule.integer && !Number.isInteger(value)) return { ok: false };
      return { ok: true, value };
    }
    case "text": {
      if (typeof value !== "string") return { ok: false };
      const t = value.trim();
      if (t === "") return rule.nullable ? { ok: true, value: null } : { ok: false };
      return t.length <= rule.max ? { ok: true, value: t } : { ok: false };
    }
    case "enum":
      return typeof value === "string" && rule.values.includes(value) ? { ok: true, value } : { ok: false };
    case "id":
      return typeof value === "string" && UUID.test(value) ? { ok: true, value } : { ok: false };
    case "ramp":
      return Array.isArray(value) && value.length >= 1 && value.length <= 12 && value.every((x) => typeof x === "number" && x >= 0 && x <= 1) ? { ok: true, value: value as number[] } : { ok: false };
  }
}

/** The rule for a column of a table the screens save, or null when it isn't one of them. */
export function setupFieldRule(table: string, field: string): FieldRule | null {
  if (!Object.hasOwn(SETUP_FIELDS, table)) return null;
  const rules = SETUP_FIELDS[table as SetupTable] as Record<string, FieldRule>;
  return Object.hasOwn(rules, field) ? rules[field]! : null;
}

/** A ramp as typed: "40, 60, 80" (percent of full capacity in each month); null for blank. Undefined when it isn't a valid ramp. */
export function parseRamp(text: string | null): number[] | null | undefined {
  if (text === null || text.trim() === "") return null;
  const parts = text.split(/[,\s]+/).filter(Boolean);
  const shares = parts.map((p) => Number(p.replace(/%$/, "")) / 100);
  if (parts.length < 1 || parts.length > 12 || shares.some((x) => !Number.isFinite(x) || x < 0 || x > 1)) return undefined;
  return shares.map((x) => Math.round(x * 1e6) / 1e6);
}

/** A ramp as shown: "40, 60, 80". */
export function formatRamp(ramp: readonly number[] | null): string | null {
  return ramp && ramp.length ? ramp.map((x) => String(Math.round(x * 1000) / 10)).join(", ") : null;
}

// ---------------------------------------------------------------------------------------------------------------------
// Pure helpers: the figures Set up shows

/** The rows the counts are made from (a subset of `CapacitySetup`). */
export interface CountData {
  services: Pick<SetupService, "id" | "department_id" | "tier_id" | "active">[];
  tiers: Pick<SetupTier, "id" | "both_count">[];
  groups: Pick<SetupGroup, "service_id" | "client_count">[];
  clients: Pick<SetupClient, "active" | "service_ids">[];
  portfolio: Pick<SetupPortfolioRow, "service_id" | "client_count">[];
}

/**
 * A service's (a tier of a department's) client count: the active named clients on it, plus the sum of everyone's portfolio for it,
 * plus its group's count. `client_groups.client_count` is "counted clients nobody's portfolio holds yet".
 */
export function tierCount(serviceId: string, data: Pick<CountData, "groups" | "clients" | "portfolio">): number {
  const named = data.clients.filter((c) => c.active && c.service_ids.includes(serviceId)).length;
  const held = data.portfolio.filter((r) => r.service_id === serviceId).reduce((s, r) => s + r.client_count, 0);
  const rest = data.groups.filter((g) => g.service_id === serviceId).reduce((s, g) => s + g.client_count, 0);
  return named + held + rest;
}

export interface UniqueClients {
  /** Clients with each department's services: the sum of its tiers' counts. */
  byDepartment: Record<string, number>;
  /** Named clients with two departments' services, plus each tier's counted "taking both". */
  both: number;
  /** Organic + Performance − taking both (the prototype's `lines`), over every department. */
  unique: number;
}

/** Unique clients: each department's clients added up, minus the ones counted in two departments. */
export function uniqueClients(data: CountData): UniqueClients {
  const dept = new Map(data.services.map((s) => [s.id, s.department_id]));
  const byDepartment: Record<string, number> = {};
  for (const s of data.services) {
    if (!s.active || !s.department_id || !s.tier_id) continue;
    byDepartment[s.department_id] = (byDepartment[s.department_id] ?? 0) + tierCount(s.id, data);
  }
  const namedBoth = data.clients.filter((c) => c.active && new Set(c.service_ids.map((id) => dept.get(id)).filter(Boolean)).size >= 2).length;
  const both = namedBoth + data.tiers.reduce((s, t) => s + t.both_count, 0);
  const total = Object.values(byDepartment).reduce((s, v) => s + v, 0);
  return { byDepartment, both, unique: total - both };
}

export type MissingKind = "tier_deliverable" | "client_facing_portfolio" | "shared_role_unit" | "shared_role_rate" | "person_salary";
export interface MissingItem {
  kind: MissingKind;
  /** The row it is about: a service, person or role id. */
  id: string;
  /** The column, for a deliverable. */
  field?: string;
  /** Plain words, e.g. "Organic (SEO) T1: words". */
  label: string;
}

/**
 * What isn't entered yet, in plain words:
 * - a tier deliverable (a field of the department's table that is blank);
 * - a client-facing person who looks after no clients (no portfolio count and no named client);
 * - a shared role with no unit, or no rate (rates aren't stored in Set up yet: a role is missing its rate unless `rates` has one, D35);
 * - a person with no salary (not contractors, who aren't in DLER; and not at all when `salariesVisible` is false, because the
 *   viewer can't see pay and a blank there means nothing).
 */
export function missingForCapacity(
  data: Pick<CapacitySetup, "departments" | "tiers" | "services" | "roles" | "people" | "portfolio" | "clients">,
  options: { rates?: Record<string, number | null | undefined>; salariesVisible?: boolean } = {},
): MissingItem[] {
  const out: MissingItem[] = [];
  const tierOf = new Map(data.tiers.map((t) => [t.id, t]));
  const deptOf = new Map(data.departments.map((d) => [d.id, d]));
  for (const s of data.services) {
    if (!s.active || !s.department_id || !s.tier_id) continue;
    const dept = deptOf.get(s.department_id);
    const tier = tierOf.get(s.tier_id);
    if (!dept || !tier) continue;
    for (const field of tierFieldsFor(dept.name)) {
      if (s[field] === null) out.push({ kind: "tier_deliverable", id: s.id, field, label: `${dept.name} ${tier.key}: ${FIELD_WORDS[field]}` });
    }
  }
  const roleOf = new Map(data.roles.map((r) => [r.id, r]));
  for (const p of data.people) {
    if (!p.active) continue;
    const facing = p.role_ids.some((id) => roleOf.get(id)?.kind === "client_facing" && roleOf.get(id)?.active !== false);
    if (facing) {
      const held = data.portfolio.some((r) => r.person_id === p.id && r.client_count > 0) || data.clients.some((c) => c.active && Object.values(c.assignments).includes(p.id));
      if (!held) out.push({ kind: "client_facing_portfolio", id: p.id, label: `${p.name}: no clients in their portfolio` });
    }
  }
  for (const r of data.roles) {
    if (r.kind !== "shared" || !r.active) continue;
    if (!r.unit || r.unit.trim() === "") out.push({ kind: "shared_role_unit", id: r.id, label: `${r.name}: no unit of work` });
    const rate = options.rates?.[r.id];
    if (rate === null || rate === undefined) out.push({ kind: "shared_role_rate", id: r.id, label: `${r.name}: rate not entered yet` });
  }
  if (options.salariesVisible !== false) {
    for (const p of data.people) {
      if (p.active && p.label !== "contractor" && p.salary_monthly === null) out.push({ kind: "person_salary", id: p.id, label: `${p.name}: no salary` });
    }
  }
  return out;
}

/** How the missing list names a field. */
export const FIELD_WORDS: Record<TierField, string> = {
  words: "words",
  links: "links",
  tech_hours: "tech hours",
  meetings: "meetings",
  builds: "builds",
  creative_sets: "creative sets",
  channels: "channels",
  adhoc_chance: "chance of ad hoc",
  adhoc_requests: "requests if they ask",
};

/** A named client's value for a field: its own when set, else its tier's service's (null when neither is entered). */
export function effectiveClientValue(client: SetupClient, services: Pick<SetupService, "id" | "department_id" | "tier_id" | "active" | "words" | "links" | "tech_hours" | "meetings" | "builds" | "creative_sets" | "channels" | "adhoc_chance" | "adhoc_requests">[], field: DeliverableColumn | "adhoc_chance" | "adhoc_requests", serviceId?: string): number | null {
  const own = client[field];
  if (own !== null) return own;
  const svc = services.find((s) => s.id === (serviceId ?? client.service_ids[0]));
  return svc ? svc[field] : null;
}
