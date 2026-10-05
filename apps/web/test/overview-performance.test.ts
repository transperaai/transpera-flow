import { describe, expect, it } from "vitest";
import { northbeamBundle, northbeamIssues, partOf, toEngineModel } from "@transpera-flow/db";
import { simulate, type EngineModel } from "@transpera-flow/engine";
import { forecastInsights, forecastModel } from "@/lib/forecast/forecast";
import { timelineData } from "@/lib/forecast/timeline";
import { buildInsights } from "@/lib/insights/insights";
import { registerEntries } from "@/lib/issues/register";
import { findingsByProcess } from "@/lib/overview/by-process";
import { countByRating, openIssues, openedVersusResolved, timeSplitByProcess, timeSplitOf } from "@/lib/overview/health";
import { rerate } from "@/lib/rules/edit";

// The Overview stays fast (issue #173, B15). It simulates the company twice, each once, in workers: the workspace's own
// length (13 weeks) for the findings, and the horizon month by month for the map, the cards and the charts. Everything
// else is worked out on the page from those two runs, so that part must cost little. Limits:
// - the two runs at the longest horizon (24 months) for the full seeded Northbeam: 250 ms (the PRD §6.7 13-week target)
//   plus 8 × 250 ms (the same target scaled to 104 weeks, as horizon-performance.test.ts scales it);
// - the page's own work from the two runs (findings by process, health strip, time split, team load, forecast alerts): 100 ms.
// Timing tests can fail on a loaded machine: re-run them alone.

const START = "2026-10-05";

function runs() {
  const bundle = northbeamBundle();
  const base: EngineModel = toEngineModel(bundle);
  const horizon = forecastModel(bundle, 24, START);
  const t = performance.now();
  const baseResult = simulate(base, 30, 1);
  const horizonResult = simulate(horizon.model!, 30, 1, { monthly: true, monthStarts: horizon.monthStarts! });
  return { bundle, base, baseResult, horizonModel: horizon.model!, horizonResult, ms: performance.now() - t };
}

describe("the Overview at 24 months, full seeded Northbeam", { tags: ["perf"] }, () => {
  it("its two runs: < 250 ms + 8 × 250 ms", () => {
    runs();
    let best = Infinity;
    for (let i = 0; i < 2; i++) best = Math.min(best, runs().ms);
    console.info(`Overview runs at 24 months, full Northbeam: ${best.toFixed(0)} ms (limit ${250 + 8 * 250})`);
    expect(best).toBeLessThan(250 + 8 * 250);
  }, 60_000);

  it("the page's own work from the two runs: < 100 ms", () => {
    const r = runs();
    const parts = [partOf(r.bundle), ...(r.bundle.otherProcesses ?? [])];
    const issues = northbeamIssues();
    const derive = () => {
      const findings = [...rerate(r.base, r.baseResult, {}, r.bundle.process.id), ...forecastInsights(r.horizonModel, r.horizonResult, {}, START)];
      const insights = buildInsights(registerEntries(issues, findings));
      const groups = findingsByProcess({ parts, pipelineId: r.bundle.process.id, insights, issues, solutions: [] });
      countByRating(groups.map((g) => g.rating));
      openIssues(issues, new Date());
      openedVersusResolved(issues, new Date());
      timeSplitOf(r.horizonModel, r.horizonResult);
      timeSplitByProcess(r.horizonModel, r.horizonResult, parts);
      return timelineData(r.horizonModel, r.horizonResult, r.bundle, START);
    };
    derive();
    let best = Infinity;
    for (let i = 0; i < 3; i++) {
      const t = performance.now();
      expect(derive()?.roles.length).toBeGreaterThan(0);
      best = Math.min(best, performance.now() - t);
    }
    console.info(`Overview page work at 24 months, full Northbeam: ${best.toFixed(1)} ms (limit 100)`);
    expect(best).toBeLessThan(100);
  }, 60_000);
});
