// "About this process" (issue #174): plain attributes of a process, worked out from what the page already has. Pure.

import type { ProcessBundle } from "@transpera-flow/db";
import { processSteps } from "@/lib/process-steps";

export interface About {
  type: "Pipeline" | "Servicing";
  steps: number;
  roles: number;
  /** The live version, or null when it was never published. */
  version: number | null;
}

const isWorking = (k: string) => k === "task" || k === "wait" || k === "decision" || k === "subprocess";

export function aboutProcess(input: { bundle: ProcessBundle; liveVersion: number }): About {
  const steps = processSteps(input.bundle).filter((s) => isWorking(s.kind) && !s.child_process_id);
  return {
    type: input.bundle.process.kind === "servicing" ? "Servicing" : "Pipeline",
    steps: steps.length,
    roles: new Set(steps.flatMap((s) => (s.role_id ? [s.role_id] : []))).size,
    version: input.liveVersion > 0 ? input.liveVersion : null,
  };
}

/** The attributes as label and value pairs in the order the page shows them, in plain words. */
export function aboutLine(a: About): { label: string; value: string }[] {
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  return [
    { label: "Type", value: a.type },
    { label: "Size", value: `${plural(a.steps, "step", "steps")}, ${plural(a.roles, "role", "roles")}` },
    { label: "Version", value: a.version === null ? "Not published yet" : String(a.version) },
  ];
}
