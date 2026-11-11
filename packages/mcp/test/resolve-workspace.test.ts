import type { Db } from "@transpera-flow/db";
import { describe, expect, it } from "vitest";
import { resolveWorkspace, type ToolContext, type WorkspaceRef } from "../src/context";
import { ToolError } from "../src/result";

// Which workspace a tool acts on (docs/adr/0024-one-workspace-per-deployment.md): a client's deployment holds one, so with no
// `workspace` argument and no active workspace the only one is used. With two or more the caller still has to choose.

const ws = (slug: string): WorkspaceRef => ({ id: `00000000-0000-4000-8000-${slug.padStart(12, "0")}`, name: slug.toUpperCase(), slug, settings: {} });

/** A context whose database answers the visible-workspaces query with `list`. */
function ctx(list: WorkspaceRef[], activeWorkspaceId: string | null = null): ToolContext {
  const chain = { select: () => chain, orderBy: () => chain, execute: async () => list };
  const db = { selectFrom: () => chain } as unknown as Db;
  return { db, tokenHash: "t", activeWorkspaceId, today: "2026-11-11" };
}

async function refusal(p: Promise<unknown>): Promise<ToolError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof ToolError) return e;
    throw e;
  }
  throw new Error("expected a ToolError");
}

describe("resolveWorkspace", () => {
  it("uses the only workspace when none is passed or active, and says so", async () => {
    const assumptions: string[] = [];
    expect((await resolveWorkspace(ctx([ws("acme")]), undefined, assumptions)).slug).toBe("acme");
    expect(assumptions.join(" ")).toMatch(/only workspace/);
  });

  it("uses the only workspace when the active one is no longer visible", async () => {
    const assumptions: string[] = [];
    expect((await resolveWorkspace(ctx([ws("acme")], ws("gone").id), undefined, assumptions)).slug).toBe("acme");
    expect(assumptions.join(" ")).toMatch(/only workspace/);
  });

  it("prefers the argument, then the active workspace, with no assumption", async () => {
    const both = [ws("acme"), ws("larkspur")];
    const assumptions: string[] = [];
    expect((await resolveWorkspace(ctx(both, ws("acme").id), "larkspur", assumptions)).slug).toBe("larkspur");
    expect((await resolveWorkspace(ctx(both, ws("acme").id), undefined, assumptions)).slug).toBe("acme");
    expect(assumptions).toEqual([]);
  });

  it("with two or more and nothing chosen, asks for set_active_workspace and lists them", async () => {
    const e = await refusal(resolveWorkspace(ctx([ws("acme"), ws("larkspur")]), undefined, []));
    expect(e.code).toBe("no_active_workspace");
    expect(e.candidates).toEqual([
      { id: ws("acme").id, name: "ACME", slug: "acme" },
      { id: ws("larkspur").id, name: "LARKSPUR", slug: "larkspur" },
    ]);
  });

  it("with none visible, says so", async () => {
    expect((await refusal(resolveWorkspace(ctx([]), undefined, []))).code).toBe("not_found");
  });
});
