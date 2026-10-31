// The capacity starter (capacity build P1, D19): the defaults a fresh client workspace gets so Set up is not a blank page. Joe keys in his own
// numbers over them. It gives an EMPTY workspace
//   - the two departments (Organic (SEO) and Performance; a new workspace already has them),
//   - tiers T1 to T3, each with a service per department holding the prototype's example numbers (`base().tiers` in
//     docs/prototypes/client-capacity-app.PROTOTYPE.html), all marked `estimate`,
//   - the prototype's nine roles with their department, kind, line, rule of thumb and, for the shared teams, the unit (D27, no rates: D35).
// No people and no clients. It never touches a workspace that already has tiers, roles, people, clients or services, so running it
// twice, or on Northbeam or Larkspur, changes nothing.
//
// It writes as whoever holds the connection: the deployment's owner login from `new-client.sh` / `pnpm --filter @transpera-flow/db
// capacity:starter`, in one transaction.

export interface Queryable {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount?: number | null }>;
}

/** Example numbers for one tier of one department, from the prototype. */
interface TierNumbers {
  price: number;
  churn: number;
  meetings: number;
  adhocChance: number;
  adhocRequests: number;
  /** The columns only that department has. */
  extra: Record<string, number>;
}

/** The prototype's `base().tiers`. Keys are the services' columns. */
export const STARTER_TIERS: { key: string; name: string; sort: number; mix: number }[] = [
  { key: "T1", name: "Tier 1", sort: 1, mix: 0.1 },
  { key: "T2", name: "Tier 2", sort: 2, mix: 0.4 },
  { key: "T3", name: "Tier 3", sort: 3, mix: 0.5 },
];

export const STARTER_NUMBERS: Record<"Organic (SEO)" | "Performance", Record<string, TierNumbers>> = {
  "Organic (SEO)": {
    T1: { price: 11000, churn: 0.01, meetings: 4, adhocChance: 0.9, adhocRequests: 6.5, extra: { words: 4000, links: 8, tech_hours: 10 } },
    T2: { price: 4500, churn: 0.02, meetings: 1, adhocChance: 0.7, adhocRequests: 4, extra: { words: 1500, links: 5, tech_hours: 5 } },
    T3: { price: 3000, churn: 0.025, meetings: 1, adhocChance: 0.5, adhocRequests: 4, extra: { words: 1000, links: 3, tech_hours: 2 } },
  },
  Performance: {
    T1: { price: 8000, churn: 0.01, meetings: 4, adhocChance: 0.95, adhocRequests: 8.5, extra: { channels: 4, builds: 5, creative_sets: 2 } },
    T2: { price: 3500, churn: 0.02, meetings: 1, adhocChance: 0.7, adhocRequests: 4.3, extra: { channels: 1.5, builds: 3, creative_sets: 1 } },
    T3: { price: 2200, churn: 0.025, meetings: 1, adhocChance: 0.5, adhocRequests: 4, extra: { channels: 1.2, builds: 1.5, creative_sets: 0.5 } },
  },
};

/** The share of leads that want each department (the prototype's `deptMix`), so a service's mix share is department x tier. */
const DEPT_MIX = 0.5;

/** The prototype's nine roles. Units are D27's; the client-facing roles have none. */
export const STARTER_ROLES: { name: string; department: "Organic (SEO)" | "Performance"; kind: "client_facing" | "shared"; line: number; rule: number | null; unit: string | null }[] = [
  { name: "SEO Director", department: "Organic (SEO)", kind: "client_facing", line: 0.85, rule: 10, unit: null },
  { name: "SEO Manager / Analyst", department: "Organic (SEO)", kind: "client_facing", line: 0.85, rule: 10, unit: null },
  { name: "Content team", department: "Organic (SEO)", kind: "shared", line: 0.85, rule: null, unit: "words" },
  { name: "Link outreach (offshore)", department: "Organic (SEO)", kind: "shared", line: 0.85, rule: null, unit: "links" },
  { name: "Technical SEO", department: "Organic (SEO)", kind: "shared", line: 0.85, rule: null, unit: "ticket hours" },
  { name: "Performance Director", department: "Performance", kind: "client_facing", line: 0.8, rule: 6, unit: null },
  { name: "Performance Marketing Manager", department: "Performance", kind: "client_facing", line: 0.85, rule: 15, unit: null },
  { name: "Performance implementers", department: "Performance", kind: "shared", line: 0.85, rule: null, unit: "tasks" },
  { name: "Conversion tracking", department: "Performance", kind: "shared", line: 0.85, rule: null, unit: "set-ups and incidents" },
];

export type StarterResult = { applied: true; tiers: number; services: number; roles: number } | { applied: false; reason: string };

const estimate = (at: string) => ({ source: "estimate", at });
/** Provenance marking each named column `estimate`. */
const estimated = (columns: string[], at: string) => JSON.stringify(Object.fromEntries(columns.map((c) => [c, estimate(at)])));

/**
 * Gives an empty workspace the capacity starter. Run inside a transaction. Does nothing, and says why, when the workspace already
 * has tiers, roles, people, clients, services or counted clients (so it is safe to run twice, and never touches a workspace in use).
 */
export async function applyCapacityStarter(db: Queryable, workspaceId: string): Promise<StarterResult> {
  const ws = await db.query("select id from public.workspaces where id = $1 for update", [workspaceId]);
  if (ws.rows.length === 0) return { applied: false, reason: "No such workspace." };
  for (const table of ["tiers", "roles", "people", "clients", "services", "client_groups"]) {
    const found = await db.query(`select 1 from public.${table} where workspace_id = $1 limit 1`, [workspaceId]);
    if (found.rows.length > 0) return { applied: false, reason: `The workspace already has ${table.replace("_", " ")}: the starter is only for an empty one.` };
  }
  const at = new Date().toISOString();

  // The two departments (a new workspace has them; make sure).
  await db.query(
    `insert into public.departments (workspace_id, name, sort) values ($1, 'Organic (SEO)', 1), ($1, 'Performance', 2) on conflict do nothing`,
    [workspaceId],
  );
  const depts = new Map<string, string>(
    (await db.query("select id, name from public.departments where workspace_id = $1", [workspaceId])).rows.map((r) => [String(r.name), String(r.id)]),
  );

  const tierIds = new Map<string, string>();
  for (const t of STARTER_TIERS) {
    const r = await db.query(
      "insert into public.tiers (workspace_id, key, name, sort, provenance) values ($1, $2, $3, $4, $5::jsonb) returning id",
      [workspaceId, t.key, t.name, t.sort, estimated(["both_count"], at)],
    );
    tierIds.set(t.key, String(r.rows[0]!.id));
  }

  let services = 0;
  for (const [deptName, byTier] of Object.entries(STARTER_NUMBERS)) {
    for (const t of STARTER_TIERS) {
      const n = byTier[t.key]!;
      const cols: Record<string, number> = { price: n.price, churn_monthly_base: n.churn, meetings: n.meetings, adhoc_chance: n.adhocChance, adhoc_requests: n.adhocRequests, mix_share: Math.round(DEPT_MIX * t.mix * 1e4) / 1e4, price_rise_churn: 0.5, ...n.extra };
      const names = Object.keys(cols);
      await db.query(
        `insert into public.services (workspace_id, name, department_id, tier_id, ${names.join(", ")}, provenance)
         values ($1, $2, $3, $4, ${names.map((_, i) => `$${i + 5}`).join(", ")}, $${names.length + 5}::jsonb)`,
        [workspaceId, `${deptName.replace(/\s*\(.*\)\s*$/, "")} ${t.name}`, depts.get(deptName), tierIds.get(t.key), ...names.map((c) => cols[c]), estimated(names, at)],
      );
      services++;
    }
  }

  for (const r of STARTER_ROLES) {
    const prov = ["line", ...(r.rule === null ? [] : ["rule_of_thumb"]), ...(r.unit === null ? [] : ["unit"])];
    await db.query(
      `insert into public.roles (workspace_id, name, department_id, kind, line, rule_of_thumb, unit, provenance) values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
      [workspaceId, r.name, depts.get(r.department), r.kind, r.line, r.rule, r.unit, estimated(prov, at)],
    );
  }
  return { applied: true, tiers: STARTER_TIERS.length, services, roles: STARTER_ROLES.length };
}
