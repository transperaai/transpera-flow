import { describe, expect, it } from "vitest";
import type { DetectedIssue } from "@transpera-flow/engine";
import { factsForProcess } from "@/lib/insights/process-facts";

// A process page lists only the facts about that process (Austin, 2 Nov): its steps, the people and roles who work them,
// and the process as a whole. The run is company-wide, so a busy director elsewhere must not show on the content process.

const fact = (key: string, over: Partial<DetectedIssue> = {}): DetectedIssue =>
  ({ key, type: "capacity", rating: "bad", title: key, evidence: "", metrics: {}, stepId: null, roleId: null, personId: null, ...over }) as DetectedIssue;

const process = {
  steps: [
    { id: "brief", role_id: "seo", person_id: null },
    { id: "write", role_id: "content", person_id: null },
    { id: "vet", role_id: "seo", person_id: "karl" },
  ],
};
// Laura (an SEO manager) works the brief step in this run; Wendlley only works Performance steps.
const result = { personTime: { stepHours: { laura: { brief: 12, pacing: 3 }, wendlley: { pacing: 40 }, sarah: { write: 0 } }, clients: {} } };

describe("the facts a process page shows", () => {
  const facts = [
    fact("capacity:person:wendlley", { personId: "wendlley", roleId: "dir_perf", stepId: "pacing" }),
    fact("capacity:person:laura", { personId: "laura", roleId: "seo", stepId: "pacing" }),
    fact("spof:step:vet", { stepId: "vet", personId: "karl" }),
    fact("capacity:person:sarah", { personId: "sarah", roleId: "content", stepId: "write" }),
    fact("capacity:role:content", { roleId: "content", stepId: "write" }),
    fact("capacity:role:dir_perf", { roleId: "dir_perf", stepId: "pacing" }),
    fact("queue:step:pacing", { stepId: "pacing" }),
    fact("cycle:process", {}),
    fact("churn_risk:client:c1", { clientId: "c1" }),
  ];

  it("keeps its steps, the people who work them, its roles and the process itself, and drops the rest", () => {
    expect(factsForProcess(facts, process, result).map((f) => f.key)).toEqual([
      "capacity:person:laura",
      "spof:step:vet",
      "capacity:role:content",
      "cycle:process",
    ]);
  });

  it("keeps a person pinned to one of its steps even before the run is in, and keeps the order", () => {
    expect(factsForProcess([fact("b", { stepId: "write" }), fact("overtime:person:karl", { personId: "karl" })], process, null).map((f) => f.key)).toEqual(["b", "overtime:person:karl"]);
  });
});
