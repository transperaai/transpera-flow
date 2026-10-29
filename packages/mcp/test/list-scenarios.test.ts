import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NORTHBEAM_HIRE_MARCH_ID, NORTHBEAM_WORKSPACE_ID, northbeamPersonIds, northbeamRoleIds, northbeamSandboxScenarios } from "@transpera-flow/db";
import { call, connect, createUser, issueToken, startTestDb, type McpTestDb } from "./helpers";

// list_scenarios (sandbox phase 5a, docs/plans/sandbox-p5-brief.md §4.1): every saved scenario with its effective changes (parents
// first), the note on each, what it builds on, where it can run, and no run. A Viewer's token reads the same list with people labelled.

type Change = { id: string; lever: string; lever_label: string; target: string | null; target_name: string | null; op: string; value: number; from: string | null; params: unknown; note: string | null; inherited_from: { id: string; name: string } | null };
type Row = { id: string; name: string; description: string | null; parent: { id: string; name: string } | null; horizon_months: number; updated_at: string; runs_in: string; changes: Change[]; problem: string | null };
type Listed = { workspace: { id: string; name: string }; scenarios: Row[]; text: string };

let env: McpTestDb;
let admin: pg.Client;
let ownerToken: string;
let viewerToken: string;
const CHILD = "5c000000-0000-4000-8000-0000000000a1";
const LEAVE = "5c000000-0000-4000-8000-0000000000a2";

beforeAll(async () => {
  env = await startTestDb();
  admin = env.t.client;
  const owner = await createUser(admin, "list-owner@example.com");
  const viewer = await createUser(admin, "list-viewer@example.com");
  await admin.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, 'owner'), ($1, $3, 'viewer')", [NORTHBEAM_WORKSPACE_ID, owner, viewer]);
  ownerToken = await issueToken(admin, owner);
  viewerToken = await issueToken(admin, viewer);
  // Builds on "Hire in March" (a timed lead change with a note), and one with leave for a named person.
  await admin.query("insert into sandbox_scenarios (id, workspace_id, name, description, parent_id, changes) values ($1, $2, 'Then more leads', 'Builds on March', $3, $4::jsonb)", [
    CHILD,
    NORTHBEAM_WORKSPACE_ID,
    NORTHBEAM_HIRE_MARCH_ID,
    JSON.stringify([{ id: "5c000000-0000-4000-8000-0000000000b1", lever: "A1", target: null, op: "multiply", value: 1.25, from: "2027-05", note: "Assumes the spring campaign lifts leads." }]),
  ]);
  await admin.query("insert into sandbox_scenarios (id, workspace_id, name, changes) values ($1, $2, 'Dan away', $3::jsonb)", [
    LEAVE,
    NORTHBEAM_WORKSPACE_ID,
    JSON.stringify([{ id: "5c000000-0000-4000-8000-0000000000b2", lever: "D3", target: northbeamPersonIds["Dan Okafor"], op: "set", value: 3, from: "2027-02-01" }]),
  ]);
}, 120_000);

afterAll(async () => {
  await env?.close();
});

const list = async (token: string, args: Record<string, unknown> = {}) => {
  const client = await connect(token, env.options);
  const r = await call<Listed>(client, "list_scenarios", args);
  await client.close();
  return r;
};

describe("list_scenarios", () => {
  it("lists every saved scenario by name, with its changes, notes and where it runs, and runs nothing", async () => {
    const r = await list(ownerToken, { workspace: "northbeam" });
    expect(r.ok).toBe(true);
    const names = r.data.scenarios.map((s) => s.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
    expect(names).toEqual(expect.arrayContaining(["Hire in March", "Hire in January", "Then more leads", "Dan away"]));
    const march = r.data.scenarios.find((s) => s.id === NORTHBEAM_HIRE_MARCH_ID)!;
    const seeded = northbeamSandboxScenarios().find((s) => s.id === NORTHBEAM_HIRE_MARCH_ID)!;
    expect(march).toMatchObject({ parent: null, horizon_months: 12, runs_in: "sandbox", problem: null });
    expect(march.changes).toEqual([
      {
        id: seeded.changes[0]!.id,
        lever: "D1",
        lever_label: expect.any(String),
        target: northbeamRoleIds.ppc,
        target_name: expect.stringMatching(/PPC/i),
        op: "set",
        value: 1,
        from: "2027-03",
        params: null,
        note: seeded.changes[0]!.note,
        inherited_from: null,
      },
    ]);
    expect(march.changes[0]!.note).toMatch(/PPC specialist/);
    expect(r.data.text).toMatch(/saved scenarios/);
  });

  it("says which can run anywhere (a standalone whole-run scenario) and which only in the Sandbox", async () => {
    const r = await list(ownerToken, { workspace: "northbeam" });
    const by = (name: string) => r.data.scenarios.find((s) => s.name === name)!;
    expect(by("Hire a strategist").runs_in).toBe("anywhere");
    expect(by("Hire in March").runs_in).toBe("sandbox");
    expect(by("Then more leads").runs_in).toBe("sandbox");
  });

  it("gives a scenario that builds on another the parent's changes first, tagged with where they come from", async () => {
    const child = (await list(ownerToken, { workspace: "northbeam" })).data.scenarios.find((s) => s.id === CHILD)!;
    expect(child.parent).toEqual({ id: NORTHBEAM_HIRE_MARCH_ID, name: "Hire in March" });
    expect(child.changes.map((c) => [c.lever, c.inherited_from?.name ?? null, c.note?.slice(0, 20) ?? null])).toEqual([
      ["D1", "Hire in March", "Assumes a PPC specia"],
      ["A1", null, "Assumes the spring c"],
    ]);
  });

  it("names a person as the reader may see them: a Viewer gets a label, an owner the name", async () => {
    const owner = (await list(ownerToken, { workspace: "northbeam" })).data.scenarios.find((s) => s.id === LEAVE)!;
    expect(owner.changes[0]!.target_name).toBe("Dan Okafor");
    const viewer = (await list(viewerToken, { workspace: "northbeam" })).data.scenarios.find((s) => s.id === LEAVE)!;
    expect(viewer.changes[0]!.target_name).not.toBe("Dan Okafor");
    expect(viewer.changes[0]!.target_name).toMatch(/team member/i);
    expect(JSON.stringify(viewer)).not.toContain("Dan Okafor");
  });

  it("says 'gone' for a target that is no longer in the model", async () => {
    await admin.query("update sandbox_scenarios set changes = $2::jsonb where id = $1", [
      LEAVE,
      JSON.stringify([{ id: "5c000000-0000-4000-8000-0000000000b2", lever: "D3", target: "00000000-0000-4000-8000-00000000dead", op: "set", value: 3, from: "2027-02-01" }]),
    ]);
    const r = (await list(ownerToken, { workspace: "northbeam" })).data.scenarios.find((s) => s.id === LEAVE)!;
    expect(r.changes[0]!.target_name).toBe("gone");
  });
});
