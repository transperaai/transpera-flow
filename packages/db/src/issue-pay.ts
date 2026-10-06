// Saved issues carry no pay (B1 2b, issue #30). Until 1.8.0 the engine's overtime issue said, in its evidence, what the
// overtime cost at cost rates, and saved the same money as the `overtime_cost` metric. Next to the overtime hours in the
// same sentence, that gives a person's rate away to every member who reads the issue. The engine now states hours only; this
// is the server's boundary for a browser tab that still runs the old engine, and for a restored backup.

/** The money clause overtime evidence carried before B1 2b. Migration 20261207700000 uses the same pattern in SQL. */
export const OVERTIME_COST_CLAUSE = /, costing about .+? at cost rates over the [\d,]+-week run\./g;

/**
 * An issue's evidence and metrics without anything that depends on a person's pay: the overtime money clause becomes
 * ".", and `overtime_cost` is dropped. Idempotent; leaves every other field and every other key as it is.
 */
export function payFreeIssueFields<T extends object>(fields: T & { evidence?: string | null; evidence_metrics?: unknown }): T {
  let out = fields;
  if (typeof fields.evidence === "string") {
    const evidence = fields.evidence.replace(OVERTIME_COST_CLAUSE, ".");
    if (evidence !== fields.evidence) out = { ...out, evidence };
  }
  const metrics = fields.evidence_metrics;
  if (metrics !== null && typeof metrics === "object" && !Array.isArray(metrics) && "overtime_cost" in metrics) {
    const { overtime_cost: _money, ...rest } = metrics as Record<string, unknown>;
    out = { ...out, evidence_metrics: rest };
  }
  return out;
}
