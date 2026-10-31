// The runs behind an issue page's "Changes anchored to this issue" (capacity build P8 section 2): today's run, then one run per change (today's
// model with that change alone swapped in from month 1). They go through `runCapacity`, so each is cached by its model's hash: coming back to the
// page, or opening another issue, only runs what has not run. Run in the worker one after the other, never on the server.

import { changeRunModel, issueChangeFigure, todayModel, type CapacityChangeRow, type CapacitySetup, type IssueChangeFigure } from "@transpera-flow/db";
import type { EngineModel } from "@transpera-flow/engine";
import type { SimClientLike } from "./client-like";
import { runCapacity } from "./runs";

export interface IssueRunProgress {
  done: number;
  total: number;
}

/**
 * Runs today, then each change; calls `onFigure` as each finishes. `isCancelled` is checked between runs. Returns the figures by change id.
 */
export async function runIssueChanges(
  client: SimClientLike,
  setup: CapacitySetup,
  baseModel: EngineModel,
  changes: readonly CapacityChangeRow[],
  hooks: { onProgress?: (p: IssueRunProgress) => void; onFigure?: (f: IssueChangeFigure) => void; isCancelled?: () => boolean } = {},
): Promise<Record<string, IssueChangeFigure>> {
  const out: Record<string, IssueChangeFigure> = {};
  const total = changes.length;
  if (!total) return out;
  const today = todayModel(baseModel);
  hooks.onProgress?.({ done: 0, total });
  const base = await runCapacity(client, "today", today);
  let done = 0;
  for (const change of changes) {
    if (hooks.isCancelled?.()) return out;
    const model = changeRunModel(today, change);
    const run = await runCapacity(client, "today", model);
    const figure = issueChangeFigure(setup, change, { model: today, result: base.result }, { model, result: run.result });
    out[change.id] = figure;
    done++;
    hooks.onFigure?.(figure);
    hooks.onProgress?.({ done, total });
  }
  return out;
}
