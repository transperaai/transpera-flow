"use client";

// The issues a run detects under the workspace's analysis rules, with their cost
// per month (issue #108). Most costs come straight from the run; the "too busy"
// cost needs the extra run behind the shadow price (what one more person in the
// role would bring), so the issues show first without it and again, costed, once a
// worker has run it.

import { sortWithoutMoney } from "@transpera-flow/db";
import { useShareFinancialsHidden } from "@/components/share/share-context";
import { useEffect, useMemo, useState } from "react";
import type { AbsenceTest, AnalysisSettings, DetectedIssue, EngineModel, SimulationResult, SuccessMeasureSource } from "@transpera-flow/engine";
import { rerate } from "@/lib/rules/edit";

export interface IssueCostsRequest {
  id: number;
  model: EngineModel;
  roleIds: string[];
  reps: number;
  seed: number;
}

export type IssueCostsResponse = { id: number; ok: true; value: Record<string, number> } | { id: number; ok: false; error: string };

/** The roles whose capacity issues need a shadow price to be costed. */
export function costedRoleIds(issues: readonly DetectedIssue[]): string[] {
  return [...new Set(issues.filter((i) => i.key.startsWith("capacity:") && i.roleId).map((i) => i.roleId!))].sort();
}

const DEBOUNCE_MS = 250;

/**
 * A run rated under these rules (`rerate`), then again with the shadow prices of the roles it flags. Null until there
 * is a run. A change to the rules re-rates the same run; the shadow prices are of the model, so they are kept.
 */
export function useDetectedIssues(
  model: EngineModel | null,
  result: SimulationResult | null,
  rules: AnalysisSettings,
  processId: string,
  currency: string,
  absence?: AbsenceTest | null,
  /** The process's success measures from its first principles, for rule 11 (goals met). */
  successMeasures?: SuccessMeasureSource,
): DetectedIssue[] | null {
  const first = useMemo(() => (model && result ? rerate(model, result, rules, processId, absence, { currency, successMeasures }) : null), [model, result, rules, processId, currency, absence, successMeasures]);
  const roleIds = useMemo(() => (first ? costedRoleIds(first) : []), [first]);
  const wanted = roleIds.join("\n");
  const [prices, setPrices] = useState<{ model: EngineModel; result: SimulationResult; value: Record<string, number> } | null>(null);

  useEffect(() => {
    if (!model || !result || !wanted) return;
    // Already run for this model and run, for these roles (a rules change can add a role, never needs a re-run for the same ones).
    if (prices && prices.model === model && prices.result === result && wanted.split("\n").every((id) => id in prices.value)) return;
    let worker: Worker | null = null;
    const timer = setTimeout(() => {
      worker = new Worker(new URL("../../workers/issue-costs.worker.ts", import.meta.url), { type: "module" });
      worker.onmessage = (event: MessageEvent<IssueCostsResponse>) => {
        if (event.data.ok) setPrices({ model, result, value: event.data.value });
        worker?.terminate();
      };
      // Without the extra run the issues keep the costs they have; nothing to report.
      worker.onerror = () => worker?.terminate();
      worker.postMessage({ id: 1, model, roleIds: wanted.split("\n"), reps: result.reps, seed: result.seed } satisfies IssueCostsRequest);
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      worker?.terminate();
    };
    // `prices` is read to skip a repeat run, not to start one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, result, wanted]);

  // A share link without Financials reads the issues in an order that never depends on money (B3).
  const hideMoney = useShareFinancialsHidden();
  return useMemo(() => {
    if (!model || !result || !first) return first;
    const found =
      prices && prices.model === model && prices.result === result
        ? rerate(model, result, rules, processId, absence, { currency, shadowPrices: prices.value, successMeasures })
        : first;
    return hideMoney ? sortWithoutMoney(found) : found;
  }, [model, result, first, prices, rules, processId, currency, absence, successMeasures, hideMoney]);
}
