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

/**
 * Whether the simulation uses the named clients (PRD D42): only while no client group counts any clients. Once one does,
 * the groups are simulated and this list is a record.
 */
export function namedClientsSimulated(clientGroups: readonly { client_count: number | string }[]): boolean {
  return !clientGroups.some((g) => Number(g.client_count) > 0);
}

/** The sentence under the Clients heading that says how the list reaches the simulation. */
export function clientsRuleSentence(simulated: boolean): string {
  return simulated
    ? "No clients are counted in client groups, so the simulation uses the active clients on this list. Inactive clients are left out."
    : "Your client groups drive the simulation, so this list is a record of who your clients are and doesn't change the numbers.";
}
