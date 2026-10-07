"use client";

// The automatic verdict for "+ Link an issue" on the demo (issue #115, A50). A workspace works it out on the server; the demo has
// no server, so it simulates the stored copy here, in the same worker the Editor uses, against the issue's target.

import { bundleForProcess, toEngineModel, type IssueRow, type SolutionRow } from "@transpera-flow/db";
import { demoBundle } from "@/lib/sources/demo";
import { solutionIssueOf, verdictArea } from "./area";
import { bundleFromSolution } from "./bundle";
import { withLeverChanges } from "./levers";
import { verdictInWorker } from "./verdict-client";

export interface DemoLinkVerdict {
  autoVerdict: "pass" | "fail" | null;
  holdsPct: number | null;
  autoNote: string;
}

const UNCHECKED: DemoLinkVerdict = { autoVerdict: null, holdsPct: null, autoNote: "The demo could not check this one. Give your own verdict." };

export async function demoLinkVerdict(solution: SolutionRow, issue: IssueRow): Promise<DemoLinkVerdict> {
  const base = bundleForProcess(demoBundle(), solution.process_id);
  if (!base) return UNCHECKED;
  try {
    const solved = bundleFromSolution(base, solution);
    const asIssue = solutionIssueOf(issue, solution.process_id, solved.steps);
    const was = new Set(base.steps.map((s) => s.id));
    const added = solved.steps.filter((s) => !was.has(s.id)).map((s) => s.id);
    const verdict = await verdictInWorker({ target: asIssue.target, model: withLeverChanges(toEngineModel(solved), solution.lever_changes ?? []).model, area: verdictArea(solved.steps, asIssue, added) }).promise;
    return verdict.status === "unchecked"
      ? { autoVerdict: null, holdsPct: null, autoNote: verdict.note }
      : { autoVerdict: verdict.status, holdsPct: verdict.holdsPct, autoNote: verdict.note };
  } catch {
    // A map the engine can't read, or a worker that failed: no automatic verdict, and the person's own is the call.
    return UNCHECKED;
  }
}
