import { describe, expect, it } from "vitest";
import { accessErrorMessage, emailDomain, inviteMessage, isAssignableRole, normalizeDomain, normalizeEmail, selectablePeople } from "@/lib/access";

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

  it("only allows roles an owner can assign", () => {
    expect(isAssignableRole("editor")).toBe(true);
    expect(isAssignableRole("agency_admin")).toBe(false);
    expect(isAssignableRole(null)).toBe(false);
  });

  it("explains database rejections", () => {
    const check = (constraint: string) => ({ code: "23514", message: `new row violates check constraint "${constraint}"` });
    expect(accessErrorMessage(check("workspace_domains_not_free_mail"))).toMatch(/Free email providers/);
    expect(accessErrorMessage(check("workspace_domains_domain_format"))).toMatch(/doesn't look like a domain/);
    expect(
      accessErrorMessage({ code: "23505", message: 'duplicate key value violates unique constraint "workspace_domains_domain_key"' }),
    ).toMatch(/already used/);
    expect(accessErrorMessage({ code: "42501", message: "new row violates row-level security policy" })).toMatch(/permission/);
    expect(accessErrorMessage({ message: "boom" })).toMatch(/Something went wrong/);
  });

  it("explains the last-owner guard, whatever else the message carries", () => {
    const guard = { code: "23514", message: "workspace_keeps_an_owner: a workspace needs at least one owner" };
    expect(accessErrorMessage(guard)).toBe("A workspace needs at least one owner. Make someone else an owner first.");
    expect(accessErrorMessage({ message: `ERROR: ${guard.message} (CONTEXT: trigger)` })).toMatch(/needs at least one owner/);
  });

  it("writes the invite message for the owner to send", () => {
    expect(inviteMessage("Northbeam", "maya@northbeam.example", "https://flow.example.com/")).toBe(
      "You've been given access to Northbeam in Transpera Flow. Sign in with Google as maya@northbeam.example at https://flow.example.com/login.",
    );
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
