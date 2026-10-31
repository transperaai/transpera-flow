// The workspace's tiers and what each tier's service gets (deliverables), for the step inspector (capacity P4). Read from P1's Set up
// data (`loadCapacitySetup`): the `tiers` table in sort order, and the deliverables on the services that are a tier of a department.
// A workspace with no tiers reads as the prototype's T1, T2, T3. Pure: the loader in data.ts reads, this maps.

import type { CapacitySetup } from "@transpera-flow/db";

export const DEFAULT_TIER_KEYS = ["T1", "T2", "T3"] as const;
export const DELIVERABLE_COLUMNS = { words: "words", links: "links", techHours: "tech_hours", meetings: "meetings", builds: "builds", creativeSets: "creative_sets", channels: "channels" } as const;
export type DeliverableName = keyof typeof DELIVERABLE_COLUMNS;

export interface TierSetup {
  /** Tier keys in display order. */
  keys: string[];
  /** A service's tier key and deliverables, by service id; null when the setup couldn't be read. */
  services: Record<string, { tier: string; deliverables: Partial<Record<DeliverableName, number>> }> | null;
}

export const DEFAULT_TIER_SETUP: TierSetup = { keys: [...DEFAULT_TIER_KEYS], services: null };

/** The tier setup for the inspector from P1's Set up data. */
export function tierSetupFrom(setup: CapacitySetup | null): TierSetup {
  if (!setup) return DEFAULT_TIER_SETUP;
  const tiers = [...setup.tiers].sort((a, b) => a.sort - b.sort);
  const keyOf = new Map(tiers.map((t) => [t.id, t.key]));
  const services: NonNullable<TierSetup["services"]> = {};
  for (const s of setup.services) {
    const tier = s.tier_id ? keyOf.get(s.tier_id) : undefined;
    if (!tier) continue;
    const deliverables: Partial<Record<DeliverableName, number>> = {};
    for (const [name, col] of Object.entries(DELIVERABLE_COLUMNS) as [DeliverableName, keyof typeof s][]) {
      const v = s[col];
      if (typeof v === "number" && Number.isFinite(v)) deliverables[name] = v;
    }
    services[s.id] = { tier, deliverables };
  }
  return { keys: tiers.length ? tiers.map((t) => t.key) : [...DEFAULT_TIER_KEYS], services };
}
