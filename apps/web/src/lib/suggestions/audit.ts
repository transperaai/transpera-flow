// The company model's change log (issue #25; docs/PRD.md §4.1 "Everything is
// audit-logged", D19): audit_log entries written by the database for every
// company-model write, told in plain words. Framework-free.

import { fieldMeta, formatCompanyValue, MONTH_NAMES, type CompanyModel, type CompanyTable } from "@transpera-flow/db";

export interface AuditEntry {
  id: string;
  created_at: string;
  actor_id: string | null;
  actor_kind: "user" | "mcp" | "system";
  action: string;
  target_table: string;
  target_id: string | null;
  diff: {
    old?: Record<string, unknown>;
    new?: Record<string, unknown>;
    suggestion_id?: string;
    role_id?: string;
    service_id?: string;
    /** The step of a skill or a per-person time (the row's step, also on an update). */
    step_id?: string;
    /** A per-person time that is the person's time for every step (#230; its null `step_id` is stripped from the diff). */
    every_step?: boolean;
  };
}

const GONE_STEP = "a step no longer in any process";

/**
 * The step an entry is about: the top-level `step_id`, else the one inside the whole row an insert or delete logs
 * (`new` / `old`), else null. Entries logged before #230 have none on an update of a per-person time.
 */
export function auditStepId(e: Pick<AuditEntry, "diff">): string | null {
  const id = e.diff.step_id ?? e.diff.new?.step_id ?? e.diff.old?.step_id;
  return typeof id === "string" ? id : null;
}

/** Whether a per-person time's new provenance says it was measured (from the person's own times, #227). Read defensively. */
function isMeasured(e: AuditEntry): boolean {
  const provenance = e.diff.new?.provenance;
  if (!provenance || typeof provenance !== "object") return false;
  const factor = (provenance as Record<string, unknown>).factor;
  return !!factor && typeof factor === "object" && (factor as Record<string, unknown>).source === "measured";
}


/** The tables whose writes the change log shows. */
export const COMPANY_AUDIT_TABLES = [
  "workspaces",
  "roles",
  "services",
  "people",
  "person_roles",
  "person_skills",
  "person_leave",
  "person_capacity_factors",
  "clients",
  "client_services",
  "client_assignments",
  "client_groups",
  "lead_sources",
  "seasonality",
  "demand_settings",
  "suggestions",
] as const;

const NOUN: Record<string, string> = {
  roles: "role",
  services: "service",
  people: "person",
  clients: "client",
  client_groups: "client group",
  lead_sources: "lead source",
  seasonality: "seasonality",
  demand_settings: "demand growth",
  person_leave: "leave",
};

/** Tables with labelled fields (COMPANY_FIELDS). */
const FIELD_TABLES = new Set<string>(["services", "people", "clients", "lead_sources", "seasonality", "demand_settings", "roles"]);

const SKIP = new Set(["updated_at", "created_at", "created_by", "provenance", "id", "workspace_id"]);

/** What changed in a workspace's branding (issue #34): colours by value, the logo never by its storage path. */
function describeBrandingChange(before: unknown, after: unknown): string[] {
  if (JSON.stringify(before ?? {}) === JSON.stringify(after ?? {})) return [];
  const read = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
  const [a, b] = [read(before), read(after)];
  const out: string[] = [];
  const colour = (v: unknown) => (typeof v === "string" ? v : null);
  if (colour(a.accent) !== colour(b.accent)) out.push(`accent colour ${colour(a.accent) ?? "default"} → ${colour(b.accent) ?? "default"}`);
  if (colour(a.accent_dark) !== colour(b.accent_dark)) out.push(`dark-mode accent → ${colour(b.accent_dark) ?? "automatic"}`);
  const [logoBefore, logoAfter] = [typeof a.logo_path === "string", typeof b.logo_path === "string"];
  if (logoBefore !== logoAfter) out.push(logoAfter ? "logo added" : "logo removed");
  else if (logoAfter && a.logo_path !== b.logo_path) out.push("logo changed");
  return out;
}

/** One entry as the change log shows it. */
export function describeAuditEntry(e: AuditEntry, model: CompanyModel, stepNames: Readonly<Record<string, string>> = {}): string {
  const currency = model.workspace.settings.currency || "GBP";
  const row = { ...(e.diff.old ?? {}), ...(e.diff.new ?? {}) } as Record<string, unknown>;
  const name = (list: { id: string; name: string }[], id: unknown) => list.find((x) => x.id === id)?.name ?? "someone or something since removed";
  const who = (table: string) => {
    if (table === "people" || table === "person_roles" || table === "person_skills" || table === "person_leave" || table === "person_capacity_factors") {
      return String(row.name ?? name(model.people, row.person_id ?? e.target_id));
    }
    if (table === "client_groups") return String(name(model.services, row.service_id));
    if (table === "clients" || table === "client_services" || table === "client_assignments") return String(row.name ?? name(model.clients, row.client_id ?? e.target_id));
    if (table === "services") return String(row.name ?? name(model.services, e.target_id));
    if (table === "roles") return String(row.name ?? name(model.roles, e.target_id));
    if (table === "lead_sources") return String(row.name ?? model.leadSources.find((l) => l.id === e.target_id)?.name ?? "a lead source");
    if (table === "seasonality") return MONTH_NAMES[Number(row.month) - 1] ?? "a month";
    return "";
  };

  switch (e.target_table) {
    case "suggestions": {
      const target = String(row.target_table ?? "company model").replace(/_/g, " ");
      if (e.action === "insert") return `Suggested a change to the ${target}`;
      if (e.action === "accepted") return `Accepted a suggested change to the ${target}`;
      if (e.action === "rejected") return `Rejected a suggested change to the ${target}${e.diff.new?.review_note ? `: “${String(e.diff.new.review_note)}”` : ""}`;
      return `Updated a suggestion`;
    }
    case "person_roles":
      return `${who("person_roles")}: role ${name(model.roles, e.diff.role_id ?? row.role_id)} ${e.action === "insert" ? "added" : "removed"}`;
    case "client_services":
      return `${who("client_services")}: service ${name(model.services, e.diff.service_id ?? row.service_id)} ${e.action === "insert" ? "added" : "removed"}`;
    case "client_assignments": {
      const role = name(model.roles, e.diff.role_id ?? row.role_id);
      if (e.action === "delete") return `${who("client_assignments")}: ${role} unassigned`;
      return `${who("client_assignments")}: ${role} → ${name(model.people, e.diff.new?.person_id ?? row.person_id)}`;
    }
    case "person_skills": {
      const verb = e.action === "insert" ? "added" : e.action === "delete" ? "removed" : "changed";
      const step = auditStepId(e);
      return step ? `${who("person_skills")}: skill ${stepNames[step] ?? GONE_STEP} ${verb}` : `${who("person_skills")}: a skill ${verb}`;
    }
    // Per-person times (C6, #230): the step, or "every step"; never the number in text (the diff holds it, and only managers read the log).
    case "person_capacity_factors": {
      const verb = e.action === "insert" ? "set" : e.action === "delete" ? "removed" : "changed";
      const step = auditStepId(e);
      // An absent step on an insert or delete is "every step": the whole row was logged and a null step_id is stripped.
      const words = e.diff.every_step === true ? "for every step" : step ? `on ${stepNames[step] ?? GONE_STEP}` : e.action !== "update" ? "for every step" : null;
      const text = words ? `${who("person_capacity_factors")}: per-person time ${words} ${verb}` : `${who("person_capacity_factors")}: a per-person time ${verb}`;
      return isMeasured(e) ? `${text} (measured)` : text;
    }
    case "person_leave":
      return `${who("person_leave")}: leave ${String(row.start_date ?? "")} to ${String(row.end_date ?? "")} ${e.action === "insert" ? "added" : e.action === "delete" ? "removed" : "changed"}`;
  }

  const table = e.target_table as CompanyTable;
  const noun = NOUN[e.target_table] ?? e.target_table.replace(/_/g, " ");
  if (e.action === "insert") return `Added ${noun} ${who(e.target_table)}`.trim();
  if (e.action === "delete") return `Removed ${noun} ${who(e.target_table)}`.trim();

  const changes: string[] = [];
  const oldRow = e.diff.old ?? {};
  const newRow = e.diff.new ?? {};
  if (e.target_table === "workspaces") {
    const before = (oldRow.settings ?? {}) as Record<string, unknown>;
    const after = (newRow.settings ?? {}) as Record<string, unknown>;
    for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (JSON.stringify(before[k]) === JSON.stringify(after[k])) continue;
      const meta = fieldMeta("workspaces", k);
      changes.push(`${meta.label} ${formatCompanyValue(meta.format, before[k], currency)} → ${formatCompanyValue(meta.format, after[k], currency)}`);
    }
    if (newRow.name !== undefined) changes.push(`name → ${String(newRow.name)}`);
    const branding = describeBrandingChange(oldRow.branding, newRow.branding);
    if (branding.length && !changes.length) return `Branding: ${branding.join(", ")}`;
    changes.push(...branding);
    return changes.length ? `Company settings: ${changes.join(", ")}` : "Company settings updated";
  }
  for (const k of Object.keys(newRow)) {
    if (SKIP.has(k)) continue;
    const meta = FIELD_TABLES.has(table) ? fieldMeta(table, k) : { label: k.replace(/_/g, " "), format: "text" as const };
    changes.push(`${meta.label} ${formatCompanyValue(meta.format, oldRow[k], currency)} → ${formatCompanyValue(meta.format, newRow[k], currency)}`);
  }
  const subject = e.target_table === "demand_settings" ? "Demand growth" : `${noun[0]!.toUpperCase()}${noun.slice(1)} ${who(e.target_table)}`.trim();
  return changes.length ? `${subject}: ${changes.join(", ")}` : `${subject}: provenance updated`;
}
