// The workspace's tiers and what each tier's service gets (deliverables), for the step inspector (capacity P4). P1 builds the
// tables (`tiers`, and deliverables and `tier_id` on `services`); until they exist this returns the prototype's T1, T2, T3 and
// no deliverables, and the inspector says "Set in Tiers & clients". The orchestrator swaps this for P1's loader on merge.
// No server-only import: the query is a function of a Kysely handle, so a test can run it.

import { sql, type Kysely } from "kysely";

export const DEFAULT_TIER_KEYS = ["T1", "T2", "T3"] as const;
export const DELIVERABLE_COLUMNS = { words: "words", links: "links", techHours: "tech_hours", meetings: "meetings", builds: "builds", creativeSets: "creative_sets", channels: "channels" } as const;
export type DeliverableName = keyof typeof DELIVERABLE_COLUMNS;

export interface TierSetup {
  /** Tier keys in display order. */
  keys: string[];
  /** A service's tier key and deliverables, by service id; null when P1's columns aren't there to read. */
  services: Record<string, { tier: string; deliverables: Partial<Record<DeliverableName, number>> }> | null;
}

export const DEFAULT_TIER_SETUP: TierSetup = { keys: [...DEFAULT_TIER_KEYS], services: null };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function readTierSetup(db: Kysely<any>, workspaceId: string): Promise<TierSetup> {
  try {
    const has = await sql<{ t: string | null }>`select to_regclass('public.tiers')::text as t`.execute(db);
    if (!has.rows[0]?.t) return DEFAULT_TIER_SETUP;
    const keyRows = await sql<{ key: string }>`select key from public.tiers where workspace_id = ${workspaceId} order by sort, key`.execute(db);
    const keys = keyRows.rows.map((r) => r.key);
    const out: TierSetup = { keys: keys.length ? keys : [...DEFAULT_TIER_KEYS], services: null };
    const cols = await sql<{ column_name: string }>`
      select column_name from information_schema.columns where table_schema = 'public' and table_name = 'services'`.execute(db);
    const have = new Set(cols.rows.map((c) => c.column_name));
    if (!have.has("tier_id")) return out;
    const wanted = Object.values(DELIVERABLE_COLUMNS).filter((c) => have.has(c));
    const select = wanted.length ? sql.join(wanted.map((c) => sql`s.${sql.id(c)}`), sql`, `) : sql`null`;
    const rows = await sql<Record<string, unknown>>`
      select s.id, t.key as tier_key, ${select}
      from public.services s join public.tiers t on t.id = s.tier_id and t.workspace_id = s.workspace_id
      where s.workspace_id = ${workspaceId}`.execute(db);
    out.services = {};
    for (const r of rows.rows) {
      const deliverables: Partial<Record<DeliverableName, number>> = {};
      for (const [name, col] of Object.entries(DELIVERABLE_COLUMNS) as [DeliverableName, string][]) {
        const v = r[col];
        if (v !== null && v !== undefined && Number.isFinite(Number(v))) deliverables[name] = Number(v);
      }
      out.services[String(r.id)] = { tier: String(r.tier_key), deliverables };
    }
    return out;
  } catch {
    // Not readable (an older schema, or a role that can't see it): the defaults, as before P1.
    return DEFAULT_TIER_SETUP;
  }
}
