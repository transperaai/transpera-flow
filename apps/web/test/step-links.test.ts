import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Step links (capacity P9): `/w/[slug]/p/[processId]?step=<id>` opens the process page with that step selected, and the Capacity page's
// bottleneck and the Overview's company map link to it. The page itself is tested in map-browser.test.ts (a step's detail opens from
// the address, with its base values read only); this checks the wiring that a browser test of the bare map can't see.

const SRC = new URL("../src/", import.meta.url).pathname;
const read = (p: string) => readFileSync(join(SRC, p), "utf8");

describe("?step=<id>", () => {
  it("the process page reads it, ignores a step the version doesn't have, and gives viewers the step's base values", () => {
    const page = read("components/process-page.tsx");
    expect(page).toContain('searchParams.get("step")');
    expect(page).toMatch(/bundle\.steps\.some\(\(s\) => s\.id === stepParam\)/);
    expect(page).toContain("initialStepId={linkedStep}");
    expect(page).toMatch(/<StepBaseValues[^>]*\breadOnly\b/);
  });

  it("the Capacity page's bottleneck and the Overview's company map link to it", () => {
    expect(read("components/capacity/capacity-view.tsx")).toContain("/p/${stepProcess[s.stepId]}?step=${s.stepId}");
    expect(read("components/overview/overview.tsx")).toContain("?step=${encodeURIComponent(stepId)}");
  });

  it("the process page page loads the tier setup the base values read", () => {
    expect(read("components/workspace-process-page.tsx")).toContain("loadTierSetup(live.workspace.id)");
  });
});
