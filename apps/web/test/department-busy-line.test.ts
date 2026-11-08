import { describe, expect, it } from "vitest";
import { busyLineNote } from "@/components/overview/department-cards";

describe("the department card's busy line note (Q1 item 5)", () => {
  it("says what the line is", () => {
    expect(busyLineNote([0.85, 0.85])).toBe("Busy above 85%");
  });
  it("gives the range when the roles' lines differ", () => {
    expect(busyLineNote([0.85, 0.8, 0.85])).toBe("Busy above 80–85% (each role's utilisation threshold)");
  });
  it("says nothing with nobody in the department", () => {
    expect(busyLineNote([])).toBeUndefined();
  });
});
