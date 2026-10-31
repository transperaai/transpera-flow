// What the free-play Sandbox's processes panel is given about each process of the company model (built from the workspace's published processes
// and solutions by the page, or from an engine model by the browser test).

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
