// What the free-play Sandbox is given about each process of the company model (built from the workspace's published processes and solutions by the
// page, or from an engine model by the browser test): the map's version popover lists the solutions, a version that holds an automation runs it (D53).

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

/** How far ahead the free-play Sandbox runs, in months (QA round 2: the filter above its charts). */
export const PLAY_HORIZONS = [12, 18, 24, 36, 48, 60] as const;
export type PlayHorizon = (typeof PLAY_HORIZONS)[number];

/** The months of the run, named (one per month of the horizon). */
export interface PlayMonths {
  /** "Nov 2026". */
  long: string[];
  /** "Nov". */
  short: string[];
}
