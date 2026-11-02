import { describe, expect, it } from "vitest";
import { processRatings } from "@/lib/overview/process-ratings";

const proc = (id: string, parentId: string | null = null) => ({ id, name: id.toUpperCase(), kind: "pipeline" as const, parentId });
const step = (id: string, process_id: string) => ({ id, process_id });
const issue = (process_id: string | null, severity: "info" | "warning" | "serious" | "critical", status: "open" | "testing" | "resolved" | "dismissed" = "open", step_id: string | null = null) => ({
  process_id,
  step_id,
  severity,
  status,
});

describe("processRatings (the Overview's process health roll-up)", () => {
  it("gives each process the worst rating of its open issues and those inside it", () => {
    expect(processRatings([proc("a"), proc("b", "a")], [issue("b", "critical")])).toEqual({ a: "risk", b: "risk" });
    expect(processRatings([proc("a")], [])).toEqual({ a: null });
  });
  it("a Great or closed issue does not rate", () => {
    const procs = [proc("a"), proc("b", "a")];
    expect(processRatings(procs, [issue("b", "info"), issue("b", "critical", "resolved")])).toEqual({ a: null, b: null });
    expect(processRatings(procs, [issue("b", "warning"), issue("a", "serious")])).toEqual({ a: "bad", b: "good" });
  });
  it("counts an issue that names only a step toward that step's process", () => {
    const procs = [proc("a"), proc("b")];
    const issues = [issue(null, "critical", "open", "s1")];
    expect(processRatings(procs, issues)).toEqual({ a: null, b: null });
    expect(processRatings(procs, issues, [step("s1", "b")])).toEqual({ a: null, b: "risk" });
  });
  it("counts an issue for each process its links touch, and a closed one nowhere", () => {
    const steps = [step("s1", "a"), step("s2", "b")];
    const open = { ...issue("a", "critical", "open", "s1"), links: [{ process_id: "a", step_id: "s1" }, { process_id: "b", step_id: "s2" }] };
    expect(processRatings([proc("a"), proc("b")], [open], steps)).toEqual({ a: "risk", b: "risk" });
    expect(processRatings([proc("a"), proc("b")], [{ ...open, status: "resolved" as const }], steps)).toEqual({ a: null, b: null });
  });
});
