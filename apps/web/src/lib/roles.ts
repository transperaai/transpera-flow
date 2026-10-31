// Input checks and helpers for the roles settings (issue #88). Pure, so they
// can be unit tested. They only reject malformed input early: every write
// still runs as the signed-in user through RLS and the table's constraints.

type Scalar = string | number | boolean | null;
type Check = (v: unknown) => boolean;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isId = (v: unknown): v is string => typeof v === "string" && UUID.test(v);
const isScalar = (v: unknown): v is Scalar => v === null || ["string", "number", "boolean"].includes(typeof v);

/** Role columns saved one at a time, and what each accepts. */
export const ROLE_FIELDS = {
  name: (v) => typeof v === "string" && v.trim().length >= 1 && v.trim().length <= 200,
  active: (v) => typeof v === "boolean",
  leadership: (v) => typeof v === "boolean",
} as const satisfies Record<string, Check>;

export type RoleField = keyof typeof ROLE_FIELDS;

/** A single-field save's inputs, if well formed (text trimmed); null otherwise. */
export function parseRoleField(
  roleId: unknown,
  field: unknown,
  base: unknown,
  value: unknown,
): { roleId: string; field: RoleField; base: Scalar; value: Scalar } | null {
  if (!isId(roleId) || typeof field !== "string" || !Object.hasOwn(ROLE_FIELDS, field)) return null;
  const f = field as RoleField;
  const cleaned = typeof value === "string" ? value.trim() : value;
  if (!isScalar(base) || !ROLE_FIELDS[f](cleaned)) return null;
  return { roleId, field: f, base, value: cleaned as Scalar };
}

/** The add-role form's fields, or the sentence to show. */
export function parseNewRole(form: { get(name: string): FormDataEntryValue | null }): { name: string } | { error: string } {
  const name = String(form.get("name") ?? "").trim();
  if (!ROLE_FIELDS.name(name)) return { error: "Enter a name." };
  return { name };
}

export interface RoleUsage {
  /** Distinct steps, across every revision. */
  steps: number;
  people: number;
  clients: number;
  /** Services whose fallback load (hours per client, by role) names it. */
  services: number;
}

/** How many steps, people, clients and services name each role: what the database's `in_use` trigger checks. */
export function roleUsage(
  steps: readonly { id: string; role_id: string | null }[],
  personRoles: readonly { person_id: string; role_id: string }[],
  clientAssignments: readonly { client_id: string; role_id: string }[],
  services: readonly { id: string; fallback_ongoing_load: Record<string, unknown> | null }[] = [],
): Record<string, RoleUsage> {
  const stepIds = new Map<string, Set<string>>();
  const people = new Map<string, Set<string>>();
  const clients = new Map<string, Set<string>>();
  const serviceIds = new Map<string, Set<string>>();
  const add = (m: Map<string, Set<string>>, role: string, id: string) => (m.get(role) ?? m.set(role, new Set()).get(role)!).add(id);
  for (const s of steps) if (s.role_id) add(stepIds, s.role_id, s.id);
  for (const p of personRoles) add(people, p.role_id, p.person_id);
  for (const c of clientAssignments) add(clients, c.role_id, c.client_id);
  for (const sv of services) for (const role of Object.keys(sv.fallback_ongoing_load ?? {})) add(serviceIds, role, sv.id);
  const out: Record<string, RoleUsage> = {};
  for (const role of new Set([...stepIds.keys(), ...people.keys(), ...clients.keys(), ...serviceIds.keys()])) {
    out[role] = {
      steps: stepIds.get(role)?.size ?? 0,
      people: people.get(role)?.size ?? 0,
      clients: clients.get(role)?.size ?? 0,
      services: serviceIds.get(role)?.size ?? 0,
    };
  }
  return out;
}

/** Whether anything names the role (so it can be made inactive but not deleted). */
export const inUse = (usage: RoleUsage | undefined): boolean => !!usage && usage.steps + usage.people + usage.clients + usage.services > 0;

/** The roles a picker offers: the active ones, and any in `keep` (what is already chosen). */
export function selectableRoles<T extends { id: string; active: boolean }>(roles: readonly T[], keep: readonly (string | null)[] = []): T[] {
  return roles.filter((r) => r.active || keep.includes(r.id));
}
