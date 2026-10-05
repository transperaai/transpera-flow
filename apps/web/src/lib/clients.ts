// Clients added by hand (issue #182, B19; PRD D42): what may be saved, and the plain sentence that says whether the
// named clients are simulated. Shared by the Clients section of Settings and its server actions.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export const isId = (v: unknown): v is string => typeof v === "string" && UUID.test(v);
export const isDate = (v: unknown): v is string => typeof v === "string" && DATE.test(v) && !Number.isNaN(Date.parse(v));

/** The most a client's MRR can be set to here. */
export const MAX_MRR = 100_000_000;

/** The columns of a client a person edits, each with what a new value must be. */
export const CLIENT_FIELDS = {
  name: (v: unknown) => typeof v === "string" && v.trim().length > 0 && v.trim().length <= 200,
  mrr: (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= MAX_MRR,
  start_date: (v: unknown) => v === null || isDate(v),
  active: (v: unknown) => typeof v === "boolean",
} as const;

export type ClientField = keyof typeof CLIENT_FIELDS;

export const isClientField = (f: unknown): f is ClientField => typeof f === "string" && Object.hasOwn(CLIENT_FIELDS, f);

/** A stored value to compare against: whatever shape the column holds. */
export const isBase = (v: unknown): boolean => v === null || typeof v === "boolean" || typeof v === "string" || (typeof v === "number" && Number.isFinite(v));

/** A new client from the add form: a name, and optionally MRR and a start date. Null when it isn't valid, with the reason. */
export function parseNewClient(form: { name: unknown; mrr: unknown; start_date: unknown }): { ok: true; value: { name: string; mrr: number; start_date: string | null } } | { ok: false; error: string } {
  const name = typeof form.name === "string" ? form.name.trim() : "";
  if (!CLIENT_FIELDS.name(name)) return { ok: false, error: "Enter the client's name." };
  const mrrText = typeof form.mrr === "string" ? form.mrr.trim() : "";
  const mrr = mrrText === "" ? 0 : Number(mrrText);
  if (!CLIENT_FIELDS.mrr(mrr)) return { ok: false, error: "Enter MRR as a number, 0 or more." };
  const start = typeof form.start_date === "string" && form.start_date !== "" ? form.start_date : null;
  if (!CLIENT_FIELDS.start_date(start)) return { ok: false, error: "Enter the start date as a date." };
  return { ok: true, value: { name, mrr, start_date: start } };
}

/** Which processes simulate client groups and which the named clients, by process name (PRD D42). */
export interface ClientSources {
  groups: string[];
  named: string[];
}

/**
 * Per process, as the engine decides it (packages/db/src/model.ts, `engineServices` and `engineClientGroups`): a process
 * simulates client groups when a group counts clients (rounded, above 0) for one of its services (active, and either open to
 * every process or entered through this one); otherwise it simulates the active named clients. Only pipeline processes run
 * on their own; servicing work runs inside them.
 */
export function clientSources(
  processes: readonly { id: string; name: string; kind: string }[],
  services: readonly { id: string; active: boolean; entry_process_id: string | null }[],
  groups: readonly { service_id: string; client_count: number | string }[],
): ClientSources {
  const counted = new Set(groups.filter((g) => Math.round(Number(g.client_count)) > 0).map((g) => g.service_id));
  const out: ClientSources = { groups: [], named: [] };
  for (const p of processes) {
    if (p.kind !== "pipeline") continue;
    const usesGroups = services.some((s) => s.active && (s.entry_process_id === null || s.entry_process_id === p.id) && counted.has(s.id));
    (usesGroups ? out.groups : out.named).push(p.name);
  }
  return out;
}

const list = (items: string[]) => (items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);

/** The sentence under the Clients heading that says how the list reaches the simulation. */
export function clientsRuleSentence({ groups, named }: ClientSources): string {
  if (!groups.length && !named.length) {
    return "A process whose services have clients counted in client groups simulates the groups; any other simulates the active clients on this list. Inactive clients are always left out.";
  }
  if (!named.length) return "Every process's services have clients counted in client groups, so the groups drive the simulation and this list is a record that doesn't change the numbers.";
  if (!groups.length) return "No client group counts clients for your processes' services, so the simulation uses the active clients on this list. Inactive clients are left out.";
  return `Client groups drive the simulation of ${list(groups)}, whose services have clients counted; ${list(named)} ${named.length === 1 ? "uses" : "use"} the active clients on this list. Inactive clients are always left out.`;
}
