import { describe, expect, it } from "vitest";
import { laneOfProcesses, laneSpecs, WHOLE_BUSINESS_LANE, type DepartmentLaneInput } from "@/lib/overview/department-lanes";
import { departmentField, WHOLE_BUSINESS_CHOICE } from "@/lib/process-page/department";

// Q4: the lane list (Sales and whole business, then departments by sort) and the Department field's value and default.

const input: DepartmentLaneInput = {
  departments: [
    { id: "ppc", name: "Performance", sort: 2 },
    { id: "seo", name: "Organic (SEO)", sort: 1 },
  ],
  services: [
    { id: "seo-t1", department_id: "seo", tier_id: "t1" },
    { id: "ppc-t1", department_id: "ppc", tier_id: "t1" },
  ],
  links: [
    { process_id: "audit", service_id: "seo-t1" },
    { process_id: "both", service_id: "seo-t1" },
    { process_id: "both", service_id: "ppc-t1" },
  ],
};

describe("laneSpecs", () => {
  it("puts Sales and whole business first, then the departments by sort", () => {
    expect(laneSpecs(input).map((l) => l.label)).toEqual(["Sales and whole business", "Organic (SEO)", "Performance"]);
    expect(laneSpecs({ departments: [], services: [], links: [] }).map((l) => l.key)).toEqual([WHOLE_BUSINESS_LANE]);
  });
});

describe("laneOfProcesses", () => {
  it("uses the chosen department, else the worked-out one, else the whole business", () => {
    const lanes = laneOfProcesses([{ id: "audit" }, { id: "both" }, { id: "pipeline" }, { id: "moved", department_id: "ppc" }, { id: "pinned", whole_business: true }], input);
    expect([...lanes]).toEqual([
      ["audit", "seo"],
      ["both", WHOLE_BUSINESS_LANE],
      ["pipeline", WHOLE_BUSINESS_LANE],
      ["moved", "ppc"],
      ["pinned", WHOLE_BUSINESS_LANE],
    ]);
  });
});

describe("departmentField", () => {
  it("shows the worked-out department as the default", () => {
    const f = departmentField({ id: "audit", department_id: null, whole_business: false }, input);
    expect(f).toMatchObject({ value: null, workedOut: "Organic (SEO)", current: "Organic (SEO)", chosen: false });
    expect(f.options.map((o) => o.label)).toEqual(["Organic (SEO)", "Performance", "Sales and whole business"]);
  });
  it("shows a choice, including whole business over a worked-out department", () => {
    expect(departmentField({ id: "audit", department_id: "ppc", whole_business: false }, input)).toMatchObject({ value: "ppc", current: "Performance", chosen: true });
    expect(departmentField({ id: "audit", department_id: null, whole_business: true }, input)).toMatchObject({ value: WHOLE_BUSINESS_CHOICE, current: "Sales and whole business", workedOut: "Organic (SEO)" });
  });
});
