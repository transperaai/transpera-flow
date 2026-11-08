import { describe, expect, it } from "vitest";
import { emailDomain, normalizeDomain, normalizeEmail, personLinkProblem, selectablePeople } from "@/lib/access";
import { DEPLOYMENT_ROLES, DEPLOYMENT_ROLE_LABEL, MEMBERSHIP_ROLE_LABEL, assignableRoles, deploymentErrorMessage, isDeploymentRole } from "@/lib/deployment-rules";

describe("access helpers", () => {
  it("normalises what people paste as a domain", () => {
    expect(normalizeDomain("  Acme.COM ")).toBe("acme.com");
    expect(normalizeDomain("@acme.com")).toBe("acme.com");
    expect(normalizeDomain("jo@acme.com")).toBe("acme.com");
    expect(normalizeDomain("https://www.acme.com/about")).toBe("acme.com");
    expect(normalizeDomain("acme.co.uk.")).toBe("acme.co.uk");
  });

  it("normalises emails and extracts their domain", () => {
    expect(normalizeEmail(" Jo.Smith@Acme.com ")).toBe("jo.smith@acme.com");
    expect(emailDomain("jo@Acme.com")).toBe("acme.com");
  });

  it("has three roles with the names the product uses", () => {
    expect(DEPLOYMENT_ROLES).toEqual(["owner", "agency_admin", "viewer"]);
    expect(DEPLOYMENT_ROLES.map((r) => DEPLOYMENT_ROLE_LABEL[r])).toEqual(["Owner", "Agency admin", "Viewer"]);
    // On a membership the stored word `owner` is an Agency admin.
    expect(MEMBERSHIP_ROLE_LABEL).toEqual({ owner: "Agency admin", viewer: "Viewer" });
    for (const old of ["admin", "editor", "member", null, 3]) expect(isDeploymentRole(old)).toBe(false);
  });

  it("lets only an Owner hand out the Owner role", () => {
    expect(assignableRoles(true)).toEqual(["owner", "agency_admin", "viewer"]);
    expect(assignableRoles(false)).toEqual(["agency_admin", "viewer"]);
  });

  it("explains database rejections", () => {
    expect(deploymentErrorMessage({ message: 'duplicate key value violates unique constraint "deployment_access_kind_value_key"' })).toMatch(/already on the list/);
    expect(deploymentErrorMessage({ message: 'violates check constraint "deployment_access_value_format"' })).toMatch(/company domain/);
    expect(deploymentErrorMessage({ code: "42501", message: "new row violates row-level security policy" })).toMatch(/Only an Owner can add, change or remove an Owner/);
    expect(deploymentErrorMessage({ message: "boom" })).toMatch(/Something went wrong/);
  });

  it("refuses linking a person who is already linked to another active membership", () => {
    const rows = [
      { id: "m1", person_id: "p1", active: true },
      { id: "m2", person_id: "p2", active: false },
    ];
    expect(personLinkProblem("m9", "p1", rows)).toMatch(/already linked/);
    // Their own row, an inactive membership and a free person are fine.
    expect(personLinkProblem("m1", "p1", rows)).toBeNull();
    expect(personLinkProblem("m9", "p2", rows)).toBeNull();
    expect(personLinkProblem("m9", "p4", rows)).toBeNull();
  });

  it("offers only people nobody else is linked to, keeping the row's own", () => {
    const people = [{ id: "a" }, { id: "b" }, { id: "c" }];
    const links = new Map([
      ["a", new Set(["m:1"])],
      ["b", new Set(["e:2"])],
    ]);
    expect(selectablePeople(people, links).map((p) => p.id)).toEqual(["c"]);
    expect(selectablePeople(people, links, "m:1").map((p) => p.id)).toEqual(["a", "c"]);
    expect(selectablePeople(people, links, "e:2").map((p) => p.id)).toEqual(["b", "c"]);
  });
});
