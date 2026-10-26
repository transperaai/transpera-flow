import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createWorld, signInAs, type World } from "./action-harness";

// Creating a process from the app checks the name against the workspace's ordinary processes only: the company map (B11) is
// called "Company map" and must not take that name away from a process. The kind is chosen (B19, #182), and an archived
// process gives its name up (restoring it is refused while another process has it). Runs against a real database as an editor.

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth/session", async () => (await import("./action-harness")).sessionMock);
vi.mock("next/navigation", () => ({ redirect: () => undefined }));
const { createProcess } = await import("@/app/w/[slug]/process-actions");

let world: World;
let WS: string;

beforeAll(async () => {
  world = await createWorld("clientco");
  WS = world.workspaceId;
  const q = world.tdb.client.query.bind(world.tdb.client);
  await q("insert into processes (workspace_id, name, kind, is_company) values ($1, 'Company map', 'pipeline', true) on conflict do nothing", [WS]);
  await q("insert into processes (workspace_id, name, kind) values ($1, 'Sales', 'pipeline')", [WS]);
  await q("insert into processes (workspace_id, name, kind) values ($1, 'Old audit', 'pipeline')", [WS]);
  await q("update processes set archived_at = '2026-10-01T00:00:00Z' where workspace_id = $1 and name = 'Old audit'", [WS]);
  signInAs(world, "editor");
});

afterAll(async () => {
  await world?.tdb.close();
});

const form = (name: string, kind: string | null = "servicing") => {
  const f = new FormData();
  f.set("name", name);
  if (kind !== null) f.set("kind", kind);
  return f;
};

const named = async (name: string) =>
  (await world.tdb.client.query("select id, kind, is_company, entity_name from processes where workspace_id = $1 and lower(name) = lower($2)", [WS, name])).rows;

describe("createProcess", () => {
  it("lets a process be called 'Company map', but not the name of an ordinary one", async () => {
    // The company map doesn't count towards the name check: an ordinary process takes its name.
    expect(await createProcess(WS, "northbeam", {}, form("Company map"))).toBeUndefined();
    expect((await named("Company map")).map((p) => p.is_company).sort()).toEqual([false, true]);
    expect(await createProcess(WS, "northbeam", {}, form("sales"))).toEqual({ error: "There is already a process called 'sales'." });
    expect(await named("Sales")).toHaveLength(1);
  });

  it("asks for the kind, and lets a new process take an archived one's name", async () => {
    expect(await createProcess(WS, "northbeam", {}, form("Quarterly review", null))).toEqual({ error: "Choose Sales pipeline or Client work." });
    expect(await createProcess(WS, "northbeam", {}, form("Quarterly review", "company"))).toEqual({ error: "Choose Sales pipeline or Client work." });
    expect(await named("Quarterly review")).toHaveLength(0);
    // "Old audit" is archived, so its name is free.
    expect(await createProcess(WS, "northbeam", {}, form("old AUDIT", "pipeline"))).toBeUndefined();
    const made = (await named("old audit")).filter((p) => p.kind === "pipeline");
    expect(made).toHaveLength(2);
    expect(made.some((p) => p.entity_name === "lead")).toBe(true);
  });
});
