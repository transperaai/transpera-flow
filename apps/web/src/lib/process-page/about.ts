// "About this process" (issue #174): plain attributes of a process, worked out from what the page already has. Pure.

import { defaultProcessCategory, PROCESS_CATEGORY_LABELS, type ProcessBundle, type ProcessCategory } from "@transpera-flow/db";
import { processSteps } from "@/lib/process-steps";

export interface About {
  /** What the process is for (Q3): Sales, Onboarding, Routine client work, Ad hoc or Internal. The engine kind stays underneath. */
  category: ProcessCategory;
  steps: number;
  roles: number;
  /** The live version, or null when it was never published. */
  version: number | null;
}

const isWorking = (k: string) => k === "task" || k === "wait" || k === "decision" || k === "subprocess";

export function aboutProcess(input: { bundle: ProcessBundle; liveVersion: number }): About {
  const steps = processSteps(input.bundle).filter((s) => isWorking(s.kind) && !s.child_process_id);
  return {
    // A bundle from before categories (a fixture, an old export) has none: its kind's default.
    category: input.bundle.process.category ?? defaultProcessCategory(input.bundle.process.kind),
    steps: steps.length,
    roles: new Set(steps.flatMap((s) => (s.role_id ? [s.role_id] : []))).size,
    version: input.liveVersion > 0 ? input.liveVersion : null,
  };
}

/** The one muted line under the page title: "4 steps · 2 roles · Version 3", or "… · Draft, not published yet" when there is no live version. */
export function aboutSummary(a: About): string {
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  return [plural(a.steps, "step", "steps"), plural(a.roles, "role", "roles"), a.version === null ? "Draft, not published yet" : `Version ${a.version}`].join(" · ");
}

/** The attributes as label and value pairs in the order the page shows them, in plain words. */
export function aboutLine(a: About): { label: string; value: string }[] {
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  return [
    { label: "Type", value: PROCESS_CATEGORY_LABELS[a.category] },
    { label: "Size", value: `${plural(a.steps, "step", "steps")}, ${plural(a.roles, "role", "roles")}` },
    { label: "Version", value: a.version === null ? "Not published yet" : String(a.version) },
  ];
}
