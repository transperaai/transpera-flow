import { describe, expect, it } from "vitest";
import {
  MemoryRobustnessCache,
  RobustnessCancelled,
  handleRobustnessRequest,
  northbeamModel,
  northbeamWithServicing,
  type PoolWorker,
  type RobustnessRequest,
  type RobustnessResponse,
  type ScenarioPatch,
} from "@transpera-flow/engine";
import { RobustnessSession, robustnessParameters } from "@/lib/robustness/session";

/** A worker that runs the real engine on a later tick, counting what it is sent. */
class FakeWorker implements PoolWorker {
  static posted = 0;
  onmessage: ((event: { data: RobustnessResponse }) => void) | null = null;
  onerror: ((event: { message?: string }) => void) | null = null;
  postMessage(message: RobustnessRequest) {
    FakeWorker.posted++;
    setTimeout(() => this.onmessage?.({ data: handleRobustnessRequest(message) }), 0);
  }
  terminate() {
    this.onmessage = null;
  }
}

const hire: ScenarioPatch[] = [{ path: "roles.strat.headcount", op: "add", value: 1 }];

function input() {
  const model = northbeamModel();
  const steps = model.steps.map((s) => ({ id: s.id, provenance: s.id === "discovery" ? { source: "entered" } : {} }));
  const parameters = robustnessParameters(model, { steps }).slice(0, 4);
  return { model, scenario: hire, options: { parameters, refineTop: 2 } };
}

describe("robustness parameters from provenance", () => {
  it("perturbs a step's values unless its provenance says entered", () => {
    const model = northbeamModel();
    const paths = (steps: { id: string; provenance?: unknown }[]) => robustnessParameters(model, { steps }).map((p) => p.path);
    expect(paths([])).toContain("steps.audit.work_hours");
    expect(paths([{ id: "audit", provenance: { source: "entered" } }])).not.toContain("steps.audit.work_hours");
    // Per-column: only the named column is known.
    const perColumn = paths([{ id: "audit", provenance: { work_hours: { source: "entered" } } }]);
    expect(perColumn).not.toContain("steps.audit.work_hours");
    expect(perColumn).toContain("steps.audit.rework_rate");
    // No provenance on demand yet: estimated.
    expect(paths([])).toContain("demand.leads_per_week");
  });

  it("perturbs health rules and churn sensitivity unless the workspace or service row says they are known (issue #79)", () => {
    const model = northbeamWithServicing();
    model.health = { latePenalty: 6 };
    const paths = (rows: Parameters<typeof robustnessParameters>[1]) =>
      robustnessParameters(model, rows)
        .map((p) => p.path)
        .filter((p) => p.startsWith("health.") || p.endsWith("churn_health_sensitivity"));
    expect(paths({})).toHaveLength(6);
    const known = paths({
      services: [{ id: "seo", provenance: { churn_health_sensitivity: { source: "entered" } } }],
      workspace: { "settings.health_late_penalty": { source: "entered" } },
    });
    expect(known).not.toContain("services.seo.churn_health_sensitivity");
    expect(known).not.toContain("health.late_penalty");
    expect(known).toContain("services.ppc.churn_health_sensitivity");
    expect(known).toContain("health.missed_penalty");
  });
});

describe("RobustnessSession", () => {
  it("runs the check on the worker pool with progress", async () => {
    FakeWorker.posted = 0;
    const session = new RobustnessSession(() => new FakeWorker(), new MemoryRobustnessCache(), 3);
    const progress: number[] = [];
    const result = await session.run(input(), (p) => progress.push(p.done / p.total));
    expect(FakeWorker.posted).toBe(result.stats.jobs);
    expect(result.screened).toBe(4);
    expect(progress.at(-1)).toBe(1);
    session.dispose();
  });

  it("re-opening compare on an unchanged model reuses the cached results without re-running", async () => {
    const cache = new MemoryRobustnessCache();
    const first = new RobustnessSession(() => new FakeWorker(), cache, 3);
    expect(first.cached(input())).toBeNull();
    const result = await first.run(input(), () => {});
    first.dispose();

    // The compare view unmounts and mounts again: a new session on the tab's cache.
    FakeWorker.posted = 0;
    const reopened = new RobustnessSession(() => new FakeWorker(), cache, 3);
    const shown = reopened.cached(input());
    expect(shown).not.toBeNull();
    expect({ ...shown!, stats: null }).toEqual({ ...result, stats: null });
    expect(FakeWorker.posted).toBe(0);
    // Running it again anyway posts nothing to the workers either.
    const again = await reopened.run(input(), () => {});
    expect(FakeWorker.posted).toBe(0);
    expect(again.stats.cached).toBe(again.stats.jobs);

    // A changed model is a different check.
    const changed = input();
    changed.model.leadsPerWeek += 1;
    expect(reopened.cached(changed)).toBeNull();
    reopened.dispose();
  });

  it("cancels a running check", async () => {
    const session = new RobustnessSession(() => new FakeWorker(), new MemoryRobustnessCache(), 2);
    const running = session.run(input(), () => {});
    session.cancel();
    await expect(running).rejects.toBeInstanceOf(RobustnessCancelled);
    // Starting another cancels the first.
    const a = session.run(input(), () => {});
    const b = session.run(input(), () => {});
    await expect(a).rejects.toBeInstanceOf(RobustnessCancelled);
    await expect(b).resolves.toMatchObject({ complete: true });
    session.dispose();
  });
});
