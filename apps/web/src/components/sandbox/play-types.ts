// What the free-play Sandbox is given about each process of the company model (built from the workspace's published processes and solutions by the
// page, or from an engine model by the browser test): the map's version popover lists the solutions, the automation rows name the steps.

import type { SolutionStatus } from "@transpera-flow/db";

export interface PlayStep {
  id: string;
  name: string;
  /** Who does it, in words: a role, a person, or "the client's manager". */
  who: string;
}

export interface PlaySolution {
  id: string;
  name: string;
  /** The title of the issue the solution is linked to, or null. */
  issue: string | null;
  /** Where the solution stands (a pill in the version popover). */
  status: SolutionStatus;
}

export interface PlayProcess {
  id: string;
  name: string;
  steps: PlayStep[];
  solutions: PlaySolution[];
}

/** The twelve months of the run, named. */
export interface PlayMonths {
  /** "Nov 2026". */
  long: string[];
  /** "Nov". */
  short: string[];
}
