import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NORTHBEAM_WORKSPACE_ID, northbeamStepIds, type CapacityChangeInput } from "@transpera-flow/db";
import { addMember, signInAs, type TestUser } from "./action-harness";
import { createTestDb, type TestDb } from "../../../packages/db/test/harness";

// A change names the issue it fixes (capacity build P8, item 1): the picker's value is stored in capacity_changes.issue_id by the Sandbox's save
// action, and clearing it stores null. Runs against a real database as an Agency admin.

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth/session", async () => (await import("./action-harness")).sessionMock);
const { saveCapacityChange } = await import("@/app/w/[slug]/capacity-change-actions");

const WS = NORTHBEAM_WORKSPACE_ID;
let tdb: TestDb;
let editor: TestUser;
let issueId: string;

const input = (issue_id: string | null): CapacityChangeInput => ({
  name: "Auto QA",
  kind: "automation",
  effects: [{ step: northbeamStepIds.audit, part: "automatable", remove: 0.5 }],
  adoption: 1,
  ramp_months: 0,
  tiers: null,
  cost_monthly: null,
  issue_id,
  source: "estimate",
});
const stored = async (id: string) => (await tdb.client.query("select issue_id from capacity_changes where id = $1", [id])).rows[0].issue_id as string | null;

beforeAll(async () => {
  tdb = await createTestDb();
  editor = await addMember(tdb, WS, "editor");
  issueId = (await tdb.client.query("insert into issues (workspace_id, type, severity, title) values ($1, 'delay', 'info', 'Slow reporting') returning id", [WS])).rows[0].id;
  signInAs({ tdb }, editor);
}, 120_000);
afterAll(async () => {
  await tdb?.close();
});

describe("the issue a change fixes", () => {
  it("is stored when picked, replaced when another is picked, and cleared when set to none", async () => {
    const added = await saveCapacityChange(WS, null, input(issueId));
    expect(added.status).toBe("ok");
    if (added.status !== "ok") return;
    expect(added.change.issue_id).toBe(issueId);
    expect(await stored(added.change.id)).toBe(issueId);

    const cleared = await saveCapacityChange(WS, added.change.id, input(null));
    expect(cleared.status === "ok" && cleared.change.issue_id).toBeNull();
    expect(await stored(added.change.id)).toBeNull();

    const again = await saveCapacityChange(WS, added.change.id, input(issueId));
    expect(again.status).toBe("ok");
    expect(await stored(added.change.id)).toBe(issueId);
  });

  it("refuses an issue from another workspace", async () => {
    const other = (await tdb.client.query("insert into workspaces (name, slug) values ('Other', 'other-p8') returning id")).rows[0].id as string;
    const foreign = (await tdb.client.query("insert into issues (workspace_id, type, severity, title) values ($1, 'delay', 'info', 'Not yours') returning id", [other])).rows[0].id as string;
    const r = await saveCapacityChange(WS, null, input(foreign));
    expect(r.status).toBe("error");
  });
});
