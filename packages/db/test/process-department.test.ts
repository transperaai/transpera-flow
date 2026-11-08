import { describe, expect, it } from "vitest";
import { derivedDepartment, processDepartment, processDepartments, WHOLE_BUSINESS_LABEL } from "../src";

// Q4: a process's department is its own when set, else the one department of the tier services its servicing links use.

const SEO = "dept-seo";
const PPC = "dept-ppc";
const services = [
  { id: "seo-t1", department_id: SEO, tier_id: "t1" },
  { id: "seo-t2", department_id: SEO, tier_id: "t2" },
  { id: "ppc-t1", department_id: PPC, tier_id: "t1" },
  { id: "plain", department_id: null, tier_id: null },
];
const known = new Set([SEO, PPC]);

describe("derivedDepartment", () => {
  it("is the department when every tier service the process serves is in it", () => {
    const links = [
      { process_id: "audit", service_id: "seo-t1" },
      { process_id: "audit", service_id: "seo-t2" },
    ];
    expect(derivedDepartment("audit", links, services)).toBe(SEO);
  });

  it("is none for a process serving both departments, or none", () => {
    expect(derivedDepartment("shared", [{ process_id: "shared", service_id: "seo-t1" }, { process_id: "shared", service_id: "ppc-t1" }], services)).toBeNull();
    expect(derivedDepartment("pipeline", [], services)).toBeNull();
  });

  it("ignores services that are not a tier, and other processes' links", () => {
    const links = [
      { process_id: "audit", service_id: "plain" },
      { process_id: "audit", service_id: "ppc-t1" },
      { process_id: "other", service_id: "seo-t1" },
    ];
    expect(derivedDepartment("audit", links, services)).toBe(PPC);
    expect(derivedDepartment("audit", [{ process_id: "audit", service_id: "plain" }], services)).toBeNull();
    expect(derivedDepartment("audit", [{ process_id: "audit", service_id: "gone" }], services)).toBeNull();
  });
});

describe("processDepartment", () => {
  const links = [{ process_id: "audit", service_id: "seo-t1" }];

  it("prefers the process's own department", () => {
    expect(processDepartment({ id: "audit", department_id: PPC }, links, services, known)).toEqual({ departmentId: PPC, chosen: true });
  });

  it("is the whole business when the owner put it there, whatever its links say", () => {
    expect(processDepartment({ id: "audit", whole_business: true }, links, services, known)).toEqual({ departmentId: null, chosen: true });
  });

  it("works it out when none is set", () => {
    expect(processDepartment({ id: "audit", department_id: null }, links, services, known)).toEqual({ departmentId: SEO, chosen: false });
    expect(processDepartment({ id: "audit" }, links, services, known)).toEqual({ departmentId: SEO, chosen: false });
  });

  it("treats a department that no longer exists as unset", () => {
    expect(processDepartment({ id: "audit", department_id: "deleted" }, links, services, known)).toEqual({ departmentId: SEO, chosen: false });
    expect(processDepartment({ id: "audit" }, links, services, new Set([PPC]))).toEqual({ departmentId: null, chosen: false });
  });

  it("is the whole business with nothing to go on", () => {
    expect(processDepartment({ id: "pipeline" }, links, services, known)).toEqual({ departmentId: null, chosen: false });
    expect(WHOLE_BUSINESS_LABEL).toBe("Sales and whole business");
  });
});

describe("processDepartments", () => {
  it("maps every process", () => {
    const m = processDepartments(
      [{ id: "pipeline" }, { id: "audit" }, { id: "ppc-work", department_id: PPC }],
      [{ process_id: "audit", service_id: "seo-t1" }],
      services,
      [{ id: SEO }, { id: PPC }],
    );
    expect([...m]).toEqual([
      ["pipeline", null],
      ["audit", SEO],
      ["ppc-work", PPC],
    ]);
  });
});
