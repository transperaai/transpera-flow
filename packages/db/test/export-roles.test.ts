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
    ["agency_admin", true],
    ["viewer", false],
  ])("a %s membership: %s", async (kind, expected) => {
    // The Agency admin's membership role is `owner`; the Viewer's is `viewer` (migration 20270103000000).
    const user = await createUser(db, `export.${kind}@northbeam.example`);
    await db.client.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, $3)", [ws, user.id, kind === "viewer" ? "viewer" : "owner"]);
    expect(await canEdit(user.claims)).toBe(expected);
  });

  it("is true for the Owner (the agency-admin flag), with no membership at all", async () => {
    const owner = await createUser(db, "export.owner@northbeam.example", { agency_admin: true });
    expect(await canEdit(owner.claims)).toBe(true);
  });

  it("is not true for a signed-in person who isn't a member (null; the route refuses anything but true)", async () => {
    const stranger = await createUser(db, "export.stranger@example.com");
    expect(await canEdit(stranger.claims)).not.toBe(true);
  });
});
