// The public demo's saved runs, kept in memory for this tab (issue #25). Lost on reload. (The store held the demo's company model,
// its suggestions and its proposals too, until Suggestions were removed 28 Oct 2026.)

import type { RunRow } from "@transpera-flow/db";

let runs: RunRow[] = [];

/** Keep a run saved on the demo's process page. */
export function saveDemoRun(run: RunRow): void {
  runs = [run, ...runs];
}

/** The runs saved in this tab, newest first. */
export const demoRunsNow = (): readonly RunRow[] => runs;
