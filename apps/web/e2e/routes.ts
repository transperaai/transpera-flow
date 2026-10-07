const PIPELINE = "c0000000-0000-4000-8000-000000000001";

/** One entry per `src/app/demo/**\/page.tsx` (`test/e2e-routes.test.ts` checks), plus extra public pages. `route` is the file's route pattern. */
export const DEMO_ROUTES: { path: string; route: string }[] = [
  { route: "/demo", path: "/demo" },
  { route: "/demo/blocks", path: "/demo/blocks" },
  { route: "/demo/churn-drivers", path: "/demo/churn-drivers" },
  { route: "/demo/edit", path: "/demo/edit" },
  { route: "/demo/forecast", path: "/demo/forecast" },
  { route: "/demo/history", path: "/demo/history" },
  { route: "/demo/issues", path: "/demo/issues" },
  { route: "/demo/issues/[number]", path: "/demo/issues/1" },
  { route: "/demo/larkspur", path: "/demo/larkspur" },
  { route: "/demo/market", path: "/demo/market" },
  { route: "/demo/overview", path: "/demo/overview" },
  { route: "/demo/p/[processId]", path: `/demo/p/${PIPELINE}` },
  { route: "/demo/p/[processId]/first-principles", path: `/demo/p/${PIPELINE}/first-principles` },
  { route: "/demo/p/[processId]/history", path: `/demo/p/${PIPELINE}/history` },
  { route: "/demo/people", path: "/demo/people" },
  { route: "/demo/processes", path: "/demo/processes" },
  { route: "/demo/settings/ai", path: "/demo/settings/ai" },
  { route: "/demo/settings/calibration", path: "/demo/settings/calibration" },
  { route: "/demo/settings/levers", path: "/demo/settings/levers" },
  { route: "/demo/solutions", path: "/demo/solutions" },
  { route: "/demo/sources", path: "/demo/sources" },
  { route: "/demo/suggestions", path: "/demo/suggestions" },
  // Not a demo page, but public and worth the same checks.
  { route: "/privacy", path: "/privacy" },
];

/** Demo pages the crawl can't open, with why. */
export const SKIPPED: Record<string, string> = {
  "/demo/solutions/[id]": "the demo's solutions live in the tab and start empty, so there is no sample solution to open",
};
