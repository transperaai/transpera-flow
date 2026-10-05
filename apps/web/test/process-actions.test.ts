import { beforeEach, describe, expect, it, vi } from "vitest";

// Creating a process from the app checks the name against the workspace's ordinary processes only: the company map (B11) is
// called "Company map" and must not take that name away from a process. The kind is chosen (B19, #182), and an archived
// process gives its name up (restoring it is refused while another process has it).

const db = vi.hoisted(() => ({
  filters: [] as unknown[][],
  rows: [{ name: "Company map", is_company: true }, { name: "Sales", is_company: false }, { name: "Old audit", is_company: false, archived_at: "2026-10-01T00:00:00Z" }],
}));
vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({ redirect: () => undefined }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    let onlyOrdinary = false;
    let onlyInUse = false;
    const chain = {
      is: (...args: unknown[]) => {
        db.filters.push(["is", ...args]);
        if (args[0] === "archived_at" && args[1] === null) onlyInUse = true;
        return chain;
      },
      select: () => chain,
      eq: (...args: unknown[]) => {
        db.filters.push(args);
        if (args[0] === "is_company" && args[1] === false) onlyOrdinary = true;
        return chain;
      },
      insert: () => chain,
      single: async () => ({ data: null, error: { code: "x" } }),
      then: (resolve: (v: unknown) => void) => resolve({ data: db.rows.filter((r) => (!onlyOrdinary || !r.is_company) && (!onlyInUse || !("archived_at" in r && r.archived_at))), error: null }),
    };
    return {
      auth: { getClaims: async () => ({ data: { claims: { sub: "u1" } } }) },
      from: () => chain,
    };
  },
}));
const { createProcess } = await import("@/app/w/[slug]/process-actions");

const WS = "a0000000-0000-4000-8000-000000000001";
const form = (name: string, kind: string | null = "servicing") => {
  const f = new FormData();
  f.set("name", name);
  if (kind !== null) f.set("kind", kind);
  return f;
};

beforeEach(() => {
  db.filters = [];
});

describe("createProcess", () => {
  it("lets a process be called 'Company map', but not the name of an ordinary one", async () => {
    // The name check leaves the company map out; the insert then fails in this fake, which is as far as it needs to go.
    expect(await createProcess(WS, "northbeam", {}, form("Company map"))).toEqual({ error: "Couldn't create it. Try again." });
    expect(db.filters).toContainEqual(["is_company", false]);
    expect(await createProcess(WS, "northbeam", {}, form("sales"))).toEqual({ error: "There is already a process called 'sales'." });
  });

  it("asks for the kind, and lets a new process take an archived one's name", async () => {
    expect(await createProcess(WS, "northbeam", {}, form("Quarterly review", null))).toEqual({ error: "Choose Sales pipeline or Client work." });
    expect(await createProcess(WS, "northbeam", {}, form("Quarterly review", "company"))).toEqual({ error: "Choose Sales pipeline or Client work." });
    // Past the name check (the fake's insert then fails): "Old audit" is archived.
    expect(await createProcess(WS, "northbeam", {}, form("old AUDIT", "pipeline"))).toEqual({ error: "Couldn't create it. Try again." });
    expect(db.filters).toContainEqual(["is", "archived_at", null]);
  });
});
