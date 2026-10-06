import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NORTHBEAM_WORKSPACE_ID } from "../src";
import { createTestDb, createUser, type TestDb } from "./harness";

// Who may export a workspace backup (issue #39, B10 2a): the route asks `can_edit_workspace`, so this checks the real answer for
// every role, not a mocked one. (A request-level test of the route with a real member needs the app and Supabase; the route's
// 403 is covered with a mocked answer in apps/web/test/export-bundle-route.test.ts.)

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db?.close();
});

const ws = NORTHBEAM_WORKSPACE_ID;
const canEdit = (claims: Record<string, unknown>) => db.as(claims, async (c) => (await c.query("select public.can_edit_workspace($1) as ok", [ws])).rows[0].ok as boolean);

describe("can_edit_workspace, which gates the backup export", () => {
  it.each([
    ["owner", true],
    ["editor", true],
    ["agency_admin", true],
    ["member", false],
    ["viewer", false],
  ])("%s: %s", async (role, expected) => {
    const user = await createUser(db, `export.${role}@northbeam.example`);
    await db.client.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, $3)", [ws, user.id, role]);
    expect(await canEdit(user.claims)).toBe(expected);
  });

  it("is not true for a signed-in person who isn't a member (null; the route refuses anything but true)", async () => {
    const stranger = await createUser(db, "export.stranger@example.com");
    expect(await canEdit(stranger.claims)).not.toBe(true);
  });
});
