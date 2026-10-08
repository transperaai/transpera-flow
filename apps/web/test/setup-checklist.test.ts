import { describe, expect, it } from "vitest";
import { setupChecklist } from "@/lib/overview/setup";

// The start page's checklist (issue #243): five steps in order, each ticked from one count.

const ZERO = { roles: 0, people: 0, clients: 0, clientGroups: 0, processes: 0, published: 0 };
const BASE = "/w/acme";
const done = (counts: Partial<typeof ZERO>, draft: { id: string } | null = null) => setupChecklist({ ...ZERO, ...counts }, BASE, draft).map((i) => i.done);

describe("setupChecklist", () => {
  it("lists roles, people, clients, the first process and publishing, in that order", () => {
    expect(setupChecklist(ZERO, BASE, null).map((i) => [i.key, i.label])).toEqual([
      ["roles", "Add roles"],
      ["people", "Add people"],
      ["clients", "Add clients or client groups"],
      ["process", "Start the first process"],
      ["publish", "Publish it"],
    ]);
  });

  it("links to the Settings sections and the Processes page, and to the draft when there is one", () => {
    expect(setupChecklist(ZERO, BASE, null).map((i) => i.href)).toEqual([
      "/w/acme/settings#roles-heading",
      "/w/acme/settings#people-heading",
      "/w/acme/settings#clients-heading",
      "/w/acme/processes",
      "/w/acme/processes",
    ]);
    expect(setupChecklist(ZERO, BASE, { id: "p1" })[4]!.href).toBe("/w/acme/p/p1/edit");
    expect(setupChecklist(ZERO, BASE, { id: "p1" })[3]!.href).toBe("/w/acme/processes");
  });

  it("ticks nothing from zeros", () => {
    expect(done({})).toEqual([false, false, false, false, false]);
  });

  it("ticks each item from its own count and no other", () => {
    expect(done({ roles: 1 })).toEqual([true, false, false, false, false]);
    expect(done({ people: 3 })).toEqual([false, true, false, false, false]);
    expect(done({ clients: 2 })).toEqual([false, false, true, false, false]);
    expect(done({ processes: 1 })).toEqual([false, false, false, true, false]);
    expect(done({ published: 1 })).toEqual([false, false, false, false, true]);
  });

  it("ticks clients from client groups alone", () => {
    expect(done({ clientGroups: 1 })).toEqual([false, false, true, false, false]);
  });

  it("ticks everything once it is all there", () => {
    expect(done({ roles: 1, people: 1, clients: 1, processes: 1, published: 1 })).toEqual([true, true, true, true, true]);
  });
});
