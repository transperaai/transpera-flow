import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, createUser, type TestDb } from "./harness";

// Better Auth and deployment access (migration 20261228000000, docs/plans/supabase-exit-brief.md step 2; three roles since
// 20270103000000): the role an address gets, the mirror into auth.users, the per-sign-in sync of memberships, the Owner flag and
// identities, and who may edit the list ("Who can sign in").
//
// The list's roles are `owner` (Austin: the agency-admin JWT flag), `agency_admin` (an `owner` membership in every workspace) and
// `viewer` (a `viewer` membership in every workspace). The list is the single source of truth: the sync lowers as well as raises.

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
  await db.client.query(`
    insert into deployment_access (kind, value, role) values
      ('domain', 'client.com', 'viewer'),
      ('email', 'lead@client.com', 'agency_admin'),
      ('email', 'boss@client.com', 'owner'),
      ('email', 'someone@gmail.com', 'viewer'),
      ('domain', 'agency.io', 'agency_admin')`);
  // Enough workspaces to give one membership of each kind.
  await db.client.query("insert into workspaces (name, slug) values ('Extra A', 'extra-a'), ('Extra B', 'extra-b'), ('Extra C', 'extra-c')");
});

afterAll(async () => {
  await db?.close();
});

const role = async (email: string | null, verified = true, admins: string[] = []) =>
  (await db.client.query("select private.deployment_role($1, $2, $3) as r", [email, verified, admins])).rows[0].r as string | null;

/** A Better Auth user; the trigger mirrors it into auth.users. */
async function signUp(email: string, options: { verified?: boolean; name?: string } = {}) {
  const id = randomUUID();
  await db.client.query(
    `insert into better_auth."user" (id, name, email, "emailVerified", image) values ($1, $2, $3, $4, 'https://img/x.png')`,
    [id, options.name ?? "Test Person", email, options.verified ?? true],
  );
  return id;
}

const sync = async (id: string, admins: string[] = [], identities: unknown[] = []) =>
  (await db.client.query("select private.sync_deployment_access($1, $2, $3) as r", [id, admins, JSON.stringify(identities)])).rows[0]
    .r as string | null;

// beforeAll makes at least four workspaces.
const workspaceIds = async () =>
  (await db.client.query("select id from workspaces order by id")).rows.map((r) => r.id as string) as [string, string, string, string, ...string[]];
const memberships = async (id: string) =>
  (await db.client.query("select workspace_id, role, source, active from memberships where user_id = $1", [id])).rows as {
    workspace_id: string;
    role: string;
    source: string;
    active: boolean;
  }[];
const agencyFlag = async (id: string) =>
  (await db.client.query("select raw_app_meta_data -> 'agency_admin' as f from auth.users where id = $1", [id])).rows[0].f as boolean | null;

describe("private.deployment_role", () => {
  it("gives a domain's default role", async () => {
    expect(await role("anyone@client.com")).toBe("viewer");
    expect(await role("anyone@agency.io")).toBe("agency_admin");
  });

  it("lets a named email beat its domain, up or down", async () => {
    expect(await role("lead@client.com")).toBe("agency_admin");
    expect(await role("boss@client.com")).toBe("owner");
  });

  it("ignores case and surrounding spaces", async () => {
    expect(await role("  LEAD@Client.COM ")).toBe("agency_admin");
    expect(await role("Anyone@CLIENT.com")).toBe("viewer");
  });

  it("matches the exact domain only: no subdomain, no parent, no look-alike", async () => {
    expect(await role("a@eu.client.com")).toBeNull();
    expect(await role("a@notclient.com")).toBeNull();
    expect(await role("a@client.com.evil.io")).toBeNull();
    expect(await role("a@com")).toBeNull();
    expect(await role("client.com@evil.io")).toBeNull();
    expect(await role("a@evil.io@client.com")).toBeNull();
  });

  it("refuses an unverified email, even a named one or a bootstrap admin", async () => {
    expect(await role("anyone@client.com", false)).toBeNull();
    expect(await role("lead@client.com", false)).toBeNull();
    expect(await role("root@x.io", false, ["root@x.io"])).toBeNull();
    expect(await role("anyone@client.com", null as unknown as boolean)).toBeNull();
  });

  it("refuses an address on no list, and an empty one", async () => {
    expect(await role("stranger@elsewhere.org")).toBeNull();
    expect(await role("")).toBeNull();
    expect(await role(null)).toBeNull();
  });

  it("gives a personal address its named role, but not the rest of its domain", async () => {
    expect(await role("someone@gmail.com")).toBe("viewer");
    expect(await role("other@gmail.com")).toBeNull();
  });

  it("counts ACCESS_ADMIN_EMAILS as Owner rules that need no table row", async () => {
    expect(await role("first@x.io", true, ["First@X.io"])).toBe("owner");
    expect(await role("first@x.io")).toBeNull();
    // And they win over a lower row, so the Owner can't lock themselves out.
    expect(await role("lead@client.com", true, ["lead@client.com"])).toBe("owner");
  });
});

describe("deployment_access table", () => {
  it("rejects a free-mail domain, a bad value, mixed case and a duplicate ignoring case", async () => {
    const insert = (kind: string, value: string) =>
      db.client.query("insert into deployment_access (kind, value, role) values ($1, $2, 'viewer')", [kind, value]);
    await expect(insert("domain", "gmail.com")).rejects.toThrow(/value_format/);
    await expect(insert("domain", "Client.com")).rejects.toThrow(/value_format/);
    await expect(insert("domain", "@client.com")).rejects.toThrow(/value_format/);
    await expect(insert("email", "not-an-email")).rejects.toThrow(/value_format/);
    await expect(insert("email", "lead@client.com")).rejects.toThrow(/duplicate key/);
    // Only the three roles: the old words (admin, editor) and a made-up one are refused.
    for (const old of ["admin", "editor", "member", "root"]) {
      await expect(db.client.query("insert into deployment_access (kind, value, role) values ('email', 'x@y.io', $1)", [old]), old).rejects.toMatchObject({
        code: "23514",
        constraint: "deployment_access_role_check",
      });
    }
    for (const ok of ["owner", "agency_admin", "viewer"]) {
      await db.client.query("insert into deployment_access (kind, value, role) values ('email', $1, $2)", [`probe-${ok}@y.io`, ok]);
      await db.client.query("delete from deployment_access where value = $1", [`probe-${ok}@y.io`]);
    }
  });

  /** Who can sign in, as each caller: the Owner (flag), an Agency admin (an `owner` membership), a Viewer, someone with no membership. */
  let made: ReturnType<typeof makeCallers> | undefined;
  const callers = () => (made ??= makeCallers());
  async function makeCallers() {
    const [ws] = await workspaceIds();
    const owner = (await createUser(db, "list-owner@agency.test", { agency_admin: true })).claims;
    const admin = await createUser(db, "list-admin@agency.test");
    const viewer = await createUser(db, "list-viewer@agency.test");
    await db.client.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, 'owner'), ($1, $3, 'viewer')", [ws, admin.id, viewer.id]);
    return { owner, admin: admin.claims, viewer: viewer.claims, stranger: { sub: randomUUID(), role: "authenticated", app_metadata: {} } };
  }
  const rows = (claims: Record<string, unknown> | null) => db.as(claims, async (c) => (await c.query("select * from deployment_access")).rowCount);

  it("is readable by the Owner and Agency admins only, not by a Viewer, a stranger or anon", async () => {
    const who = await callers();
    const total = Number((await db.client.query("select count(*) from deployment_access")).rows[0].count);
    expect(await rows(who.owner)).toBe(total);
    expect(await rows(who.admin)).toBe(total);
    expect(await rows(who.viewer)).toBe(0);
    expect(await rows(who.stranger)).toBe(0);
    expect(await rows(null)).toBe(0);
  });

  it("lets the Owner add, change and remove a rule of any role, owner rules included", async () => {
    const who = await callers();
    await db.as(who.owner, async (c) => {
      await c.query("insert into deployment_access (kind, value, role) values ('domain', 'new.io', 'viewer'), ('email', 'second-owner@new.io', 'owner')");
      expect((await c.query("update deployment_access set role = 'agency_admin' where value = 'new.io'")).rowCount).toBe(1);
      expect((await c.query("update deployment_access set role = 'viewer' where value = 'second-owner@new.io'")).rowCount).toBe(1);
      expect((await c.query("update deployment_access set role = 'owner' where value = 'second-owner@new.io'")).rowCount).toBe(1);
      expect((await c.query("delete from deployment_access where value in ('new.io', 'second-owner@new.io')")).rowCount).toBe(2);
    });
  });

  it("lets an Agency admin manage agency_admin and viewer rules", async () => {
    const who = await callers();
    await db.as(who.admin, async (c) => {
      await c.query("insert into deployment_access (kind, value, role) values ('domain', 'mine.io', 'viewer'), ('email', 'deputy@mine.io', 'agency_admin')");
      expect((await c.query("update deployment_access set role = 'agency_admin' where value = 'mine.io'")).rowCount).toBe(1);
      expect((await c.query("update deployment_access set role = 'viewer' where value = 'deputy@mine.io'")).rowCount).toBe(1);
      expect((await c.query("delete from deployment_access where value in ('mine.io', 'deputy@mine.io')")).rowCount).toBe(2);
    });
  });

  it("stops an Agency admin adding an owner rule, making a rule an owner rule, changing one, or removing one", async () => {
    const who = await callers();
    // An owner rule that exists (the Owner made it), and an ordinary one to try to promote.
    await db.client.query("insert into deployment_access (kind, value, role) values ('email', 'real-owner@mine.io', 'owner'), ('email', 'staff@mine.io', 'viewer')");
    await expect(
      db.as(who.admin, (c) => c.query("insert into deployment_access (kind, value, role) values ('email', 'sneaky@mine.io', 'owner')")),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      db.as(who.admin, (c) => c.query("insert into deployment_access (kind, value, role) values ('domain', 'sneaky.io', 'owner')")),
    ).rejects.toMatchObject({ code: "42501" });
    // Making a rule an owner rule (the new row would be an owner rule), a rule they can't see through to the end.
    await expect(db.as(who.admin, (c) => c.query("update deployment_access set role = 'owner' where value = 'staff@mine.io'"))).rejects.toMatchObject({ code: "42501" });
    await db.as(who.admin, async (c) => {
      // An owner rule is invisible to the update and delete: nothing matches, nothing changes.
      expect((await c.query("update deployment_access set role = 'viewer' where value = 'real-owner@mine.io'")).rowCount).toBe(0);
      expect((await c.query("delete from deployment_access where value = 'real-owner@mine.io'")).rowCount).toBe(0);
    });
    expect((await db.client.query("select role from deployment_access where value in ('real-owner@mine.io', 'staff@mine.io') order by value")).rows).toEqual([
      { role: "owner" },
      { role: "viewer" },
    ]);
    await db.client.query("delete from deployment_access where value in ('real-owner@mine.io', 'staff@mine.io')");
  });

  it("stops a Viewer, a stranger and anon writing the list at all", async () => {
    const who = await callers();
    for (const [name, claims] of [["viewer", who.viewer], ["stranger", who.stranger]] as const) {
      await expect(
        db.as(claims, (c) => c.query("insert into deployment_access (kind, value, role) values ('domain', 'mine.io', 'viewer')")),
        name,
      ).rejects.toThrow(/row-level security/);
      await db.as(claims, async (c) => {
        expect((await c.query("update deployment_access set role = 'viewer'")).rowCount, name).toBe(0);
        expect((await c.query("delete from deployment_access")).rowCount, name).toBe(0);
      });
    }
    await db.as(null, async (c) => expect((await c.query("delete from deployment_access")).rowCount).toBe(0));
  });

  it("writes an audit entry for a change", async () => {
    await db.client.query("insert into deployment_access (kind, value, role) values ('domain', 'audited.io', 'viewer')");
    const { rows } = await db.client.query("select action, actor_kind from audit_log where target_table = 'deployment_access' and diff -> 'new' ->> 'value' = 'audited.io'");
    expect(rows).toEqual([{ action: "insert", actor_kind: "system" }]);
  });

  it("cannot be run through the sync or role functions by a signed-in user", async () => {
    const user = { sub: randomUUID(), role: "authenticated" };
    await expect(db.as(user, (c) => c.query("select private.sync_deployment_access($1)", [user.sub]))).rejects.toThrow(/permission denied/);
    await expect(db.as(user, (c) => c.query("select private.deployment_role('a@client.com', true)"))).rejects.toThrow(/permission denied/);
    await expect(db.as(user, (c) => c.query("select private.may_sign_in('a@client.com', true)"))).rejects.toThrow(/permission denied/);
    await expect(db.as(null, (c) => c.query("select private.may_sign_in('a@client.com', true)"))).rejects.toThrow(/permission denied/);
    await expect(db.as(null, (c) => c.query("select * from better_auth.\"user\""))).rejects.toThrow(/permission denied/);
  });
});

describe("the mirror into auth.users", () => {
  it("writes id, email, confirmation and profile for a new user", async () => {
    const id = await signUp("mirror@client.com", { name: "Mia Mirror" });
    const { rows } = await db.client.query("select email, email_confirmed_at, raw_user_meta_data from auth.users where id = $1", [id]);
    expect(rows[0].email).toBe("mirror@client.com");
    expect(rows[0].email_confirmed_at).not.toBeNull();
    expect(rows[0].raw_user_meta_data).toEqual({ full_name: "Mia Mirror", avatar_url: "https://img/x.png" });
  });

  it("leaves an unverified email unconfirmed, then confirms it once, and follows renames", async () => {
    const id = await signUp("late@client.com", { verified: false });
    const confirmedAt = async () =>
      (await db.client.query("select email_confirmed_at as c from auth.users where id = $1", [id])).rows[0].c as Date | null;
    expect(await confirmedAt()).toBeNull();
    await db.client.query(`update better_auth."user" set "emailVerified" = true where id = $1`, [id]);
    const first = await confirmedAt();
    expect(first).not.toBeNull();
    await db.client.query(`update better_auth."user" set name = 'Renamed' where id = $1`, [id]);
    expect(await confirmedAt()).toEqual(first);
    expect((await db.client.query("select raw_user_meta_data ->> 'full_name' as n from auth.users where id = $1", [id])).rows[0].n).toBe("Renamed");
  });

  it("keeps the agency-admin flag when the user changes", async () => {
    const id = await signUp("flag@client.com");
    await db.client.query(`update auth.users set raw_app_meta_data = '{"agency_admin": true}' where id = $1`, [id]);
    await db.client.query(`update better_auth."user" set name = 'Again' where id = $1`, [id]);
    expect(await agencyFlag(id)).toBe(true);
  });

  it("lets foreign keys to auth.users point at a Better Auth user", async () => {
    const id = await signUp("fk@client.com");
    const [ws] = await workspaceIds();
    await db.client.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, 'viewer')", [ws, id]);
  });
});

describe("private.sync_deployment_access", () => {
  it("adds a viewer to every workspace and clears the agency flag", async () => {
    const id = await signUp("v1@client.com");
    expect(await sync(id)).toBe("viewer");
    const rows = await memberships(id);
    expect(rows.map((r) => r.workspace_id).sort()).toEqual(await workspaceIds());
    expect(new Set(rows.map((r) => r.role))).toEqual(new Set(["viewer"]));
    expect(await agencyFlag(id)).toBe(false);
  });

  it("is idempotent: a second sign-in changes no membership", async () => {
    const id = await signUp("again@client.com");
    await sync(id);
    const before = await memberships(id);
    await sync(id);
    expect(await memberships(id)).toEqual(before);
  });

  it("adds an Agency admin to every workspace, as an owner membership", async () => {
    const id = await signUp("lead@client.com");
    expect(await sync(id)).toBe("agency_admin");
    const rows = await memberships(id);
    expect(rows.map((r) => r.workspace_id).sort()).toEqual(await workspaceIds());
    expect(new Set(rows.map((r) => r.role))).toEqual(new Set(["owner"]));
    expect(await agencyFlag(id)).toBe(false);
  });

  it("raises a Viewer made an Agency admin, in every workspace", async () => {
    const id = await signUp("raised@agency.io");
    await db.client.query("insert into deployment_access (kind, value, role) values ('email', 'raised@agency.io', 'viewer')");
    expect(await sync(id)).toBe("viewer");
    expect(new Set((await memberships(id)).map((r) => r.role))).toEqual(new Set(["viewer"]));
    await db.client.query("update deployment_access set role = 'agency_admin' where value = 'raised@agency.io'");
    expect(await sync(id)).toBe("agency_admin");
    expect(new Set((await memberships(id)).map((r) => r.role))).toEqual(new Set(["owner"]));
    await db.client.query("delete from deployment_access where value = 'raised@agency.io'");
  });

  it("LOWERS a membership to match the list: an Agency admin made a Viewer is a viewer everywhere at the next sign-in", async () => {
    const id = await signUp("lowered@agency.io");
    await db.client.query("insert into deployment_access (kind, value, role) values ('email', 'lowered@agency.io', 'agency_admin')");
    expect(await sync(id)).toBe("agency_admin");
    expect(new Set((await memberships(id)).map((r) => r.role))).toEqual(new Set(["owner"]));
    await db.client.query("update deployment_access set role = 'viewer' where value = 'lowered@agency.io'");
    expect(await sync(id)).toBe("viewer");
    const rows = await memberships(id);
    expect(rows.map((r) => r.workspace_id).sort()).toEqual(await workspaceIds());
    expect(new Set(rows.map((r) => r.role))).toEqual(new Set(["viewer"]));
    // And the database agrees from that moment: they no longer edit.
    const claims = { sub: id, role: "authenticated", app_metadata: {} };
    const [ws] = await workspaceIds();
    expect(await db.as(claims, async (c) => (await c.query("select public.can_edit_workspace($1) as ok", [ws])).rows[0].ok)).toBe(false);
    await db.client.query("delete from deployment_access where value = 'lowered@agency.io'");
  });

  it("makes every existing membership match, whatever it was", async () => {
    const [ws1, ws2] = await workspaceIds();
    const id = await signUp("matches@client.com");
    await db.client.query("insert into memberships (workspace_id, user_id, role) values ($1, $3, 'owner'), ($2, $3, 'viewer')", [ws1, ws2, id]);
    expect(await sync(id)).toBe("viewer");
    const byWs = Object.fromEntries((await memberships(id)).map((r) => [r.workspace_id, r.role]));
    expect(byWs[ws1]).toBe("viewer");
    expect(byWs[ws2]).toBe("viewer");
  });

  it("keeps the link to a person record when it changes a role", async () => {
    const [ws1] = await workspaceIds();
    const id = await signUp("linked@client.com");
    const person = (await db.client.query("insert into people (workspace_id, name) values ($1, 'Linked Person') returning id", [ws1])).rows[0].id as string;
    await db.client.query("insert into memberships (workspace_id, user_id, role, person_id) values ($1, $2, 'owner', $3)", [ws1, id, person]);
    expect(await sync(id)).toBe("viewer");
    expect((await db.client.query("select role, person_id from memberships where user_id = $1 and workspace_id = $2", [id, ws1])).rows).toEqual([
      { role: "viewer", person_id: person },
    ]);
  });

  it("reactivates a deactivated membership: the list is the only access list", async () => {
    const [ws1, ws2] = await workspaceIds();
    const id = await signUp("blocked@client.com");
    await db.client.query(`insert into memberships (workspace_id, user_id, role, active) values ($1, $2, 'viewer', false)`, [ws1, id]);
    await sync(id);
    const byWs = Object.fromEntries((await memberships(id)).map((r) => [r.workspace_id, r]));
    expect(byWs[ws1]).toMatchObject({ role: "viewer", active: true });
    expect(byWs[ws2]).toMatchObject({ role: "viewer", active: true });
  });

  it("makes the Owner a flag and adds no memberships, leaving any it already has alone", async () => {
    const id = await signUp("boss@client.com");
    expect(await sync(id)).toBe("owner");
    expect(await agencyFlag(id)).toBe(true);
    expect(await memberships(id)).toEqual([]);
    // The flag reaches the claims the app builds, so RLS then shows every workspace.
    const claims = { sub: id, role: "authenticated", app_metadata: { agency_admin: true } };
    expect(await db.as(claims, async (c) => Number((await c.query("select count(*) from workspaces")).rows[0].count))).toBe(
      (await workspaceIds()).length,
    );
    const [ws1] = await workspaceIds();
    await db.client.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, 'viewer')", [ws1, id]);
    await sync(id);
    expect(await memberships(id)).toMatchObject([{ role: "viewer" }]);
  });

  it("takes the flag away when the list no longer names the user an Owner, and keeps unrelated app metadata", async () => {
    const id = await signUp("demoted@client.com");
    await db.client.query(`update auth.users set raw_app_meta_data = '{"agency_admin": true, "note": "kept"}' where id = $1`, [id]);
    await sync(id);
    expect((await db.client.query("select raw_app_meta_data as m from auth.users where id = $1", [id])).rows[0].m).toEqual({
      agency_admin: false,
      note: "kept",
    });
  });

  it("lets a bootstrap Owner in with no table row", async () => {
    const id = await signUp("founder@brand-new.io");
    expect(await sync(id)).toBeNull();
    expect(await sync(id, ["founder@brand-new.io"])).toBe("owner");
    expect(await agencyFlag(id)).toBe(true);
  });

  it("refuses an unknown email, changing nothing", async () => {
    const id = await signUp("stranger@elsewhere.org");
    expect(await sync(id)).toBeNull();
    expect(await memberships(id)).toEqual([]);
    expect(await agencyFlag(id)).toBeNull();
  });

  it("refuses a user whose email is unverified", async () => {
    const id = await signUp("unverified@client.com", { verified: false });
    expect(await sync(id)).toBeNull();
    expect(await memberships(id)).toEqual([]);
  });

  it("refuses an unknown user id", async () => {
    expect(await sync(randomUUID())).toBeNull();
  });

  it("refuses someone whose access was removed, and leaves their memberships alone", async () => {
    const id = await signUp("removed@temp.io");
    await db.client.query("insert into deployment_access (kind, value, role) values ('domain', 'temp.io', 'viewer')");
    expect(await sync(id)).toBe("viewer");
    const before = await memberships(id);
    await db.client.query("delete from deployment_access where value = 'temp.io'");
    expect(await sync(id)).toBeNull();
    expect(await memberships(id)).toEqual(before);
  });

  it("writes its membership changes to the audit log as the system", async () => {
    const id = await signUp("audit@client.com");
    await sync(id);
    const { rows } = await db.client.query(
      "select distinct actor_kind from audit_log where target_table = 'memberships' and diff -> 'new' ->> 'user_id' = $1",
      [id],
    );
    expect(rows).toEqual([{ actor_kind: "system" }]);
  });

  describe("provider identities", () => {
    const identityData = async (id: string) =>
      (await db.client.query("select provider, provider_id, identity_data from auth.identities where user_id = $1 order by provider", [id]))
        .rows;

    it("records Google's hosted domain in the identity", async () => {
      const id = await signUp("hd@client.com");
      await sync(id, [], [{ provider: "google", provider_id: "g-123", hd: "client.com" }]);
      expect(await identityData(id)).toEqual([
        {
          provider: "google",
          provider_id: "g-123",
          identity_data: { sub: "g-123", email: "hd@client.com", custom_claims: { hd: "client.com" } },
        },
      ]);
    });

    it("stores the address the provider's token names, falling back to the user's", async () => {
      const id = await signUp("named@client.com");
      await sync(id, [], [{ provider: "google", provider_id: "g-named", email: "Other@Client.com" }]);
      expect((await identityData(id))[0].identity_data.email).toBe("other@client.com");
    });

    it("drops the hosted domain when a later sign-in has none, and records a Microsoft tenant", async () => {
      const id = await signUp("mixed-ids@client.com");
      await sync(id, [], [{ provider: "google", provider_id: "g-9", hd: "client.com" }, { provider: "microsoft", provider_id: "m-9", tid: "tenant-1" }]);
      await sync(id, [], [{ provider: "google", provider_id: "g-9" }, { provider: "microsoft", provider_id: "m-9", tid: "tenant-1" }]);
      const rows = await identityData(id);
      expect(rows[0].identity_data).toEqual({ sub: "g-9", email: "mixed-ids@client.com" });
      expect(rows[1].identity_data).toEqual({ sub: "m-9", email: "mixed-ids@client.com", custom_claims: { tid: "tenant-1" } });
    });

    it("never takes over another user's identity, and ignores unknown providers", async () => {
      const a = await signUp("owner-a@client.com");
      const b = await signUp("owner-b@client.com");
      await sync(a, [], [{ provider: "google", provider_id: "g-shared", hd: "client.com" }]);
      await sync(b, [], [{ provider: "google", provider_id: "g-shared", hd: "evil.io" }, { provider: "github", provider_id: "x" }]);
      expect((await identityData(a))[0].identity_data.custom_claims).toEqual({ hd: "client.com" });
      expect(await identityData(b)).toEqual([]);
    });

    it("records nothing for a refused user", async () => {
      const id = await signUp("nobody@elsewhere.org");
      await sync(id, [], [{ provider: "google", provider_id: "g-none", hd: "elsewhere.org" }]);
      expect(await identityData(id)).toEqual([]);
    });
  });
});

describe("guests: outsiders listed on a live restricted share link (B3)", () => {
  const sha = (t: string) => createHash("sha256").update(t).digest("hex");
  let ws = "";
  async function link(emails: string[], over: { people?: boolean; expires?: string | null; revoked?: boolean } = {}) {
    const people = over.people ?? true;
    const { rows } = await db.client.query(
      `insert into share_links (workspace_id, token_hash, kind, show_people, allowed_emails, expires_at, snapshot, engine_version)
       values ($1, $2, 'overview', $3, $4, $5, $6::jsonb, '1') returning id`,
      [ws, sha(randomUUID()), people, emails, over.expires === undefined ? new Date(Date.now() + 86400_000).toISOString() : over.expires,
        JSON.stringify({ v: 1, kind: "overview", toggles: { people, financials: false } })],
    );
    if (over.revoked) await db.client.query("update share_links set revoked_at = now() where id = $1", [rows[0].id]);
    return rows[0].id as string;
  }
  const maySignIn = async (email: string, verified = true, admins: string[] = []) =>
    (await db.client.query("select private.may_sign_in($1, $2, $3) as r", [email, verified, admins])).rows[0].r as string | null;

  beforeAll(async () => {
    [ws] = await workspaceIds();
    await link(["guest@outside.org", "lead@client.com"]);
    await link(["open@outside.org"], { people: false, expires: null });
    await link(["revoked@outside.org"], { revoked: true });
  });

  it("lets a listed, verified outsider in as a guest, and nobody else", async () => {
    expect(await maySignIn("Guest@Outside.org")).toBe("guest");
    expect(await maySignIn("guest@outside.org", false)).toBeNull();
    expect(await maySignIn("other@outside.org")).toBeNull();
    // An open link (no toggle) asks for no sign-in, so its list lets no one in; nor does a revoked link.
    expect(await maySignIn("open@outside.org")).toBeNull();
    expect(await maySignIn("revoked@outside.org")).toBeNull();
    // A deployment role wins over guest.
    expect(await maySignIn("lead@client.com")).toBe("agency_admin");
    expect(await maySignIn("guest@outside.org", true, ["guest@outside.org"])).toBe("owner");
  });

  it("stops letting them in when the link expires", async () => {
    const id = await link(["brief@outside.org"]);
    expect(await maySignIn("brief@outside.org")).toBe("guest");
    // The before-write trigger refuses a past expiry, so age the row with triggers off.
    await db.client.query("alter table share_links disable trigger user");
    try {
      await db.client.query("update share_links set expires_at = now() - interval '1 minute' where id = $1", [id]);
    } finally {
      await db.client.query("alter table share_links enable trigger user");
    }
    expect(await maySignIn("brief@outside.org")).toBeNull();
  });

  it("gives a guest no memberships and no agency admin, but records the identity the share link checks", async () => {
    const id = await signUp("guest@outside.org");
    await db.client.query(`update auth.users set raw_app_meta_data = '{"agency_admin": true}' where id = $1`, [id]);
    // Nothing is applied: the membership sync doesn't run for a guest.
    await db.client.query("delete from memberships where user_id = $1", [id]);
    expect(await sync(id, [], [{ provider: "google", provider_id: "g-guest", email: "guest@outside.org" }])).toBe("guest");
    expect(await memberships(id)).toEqual([]);
    expect(await agencyFlag(id)).toBe(false);
    const ident = (await db.client.query("select provider, identity_data ->> 'email' as e from auth.identities where user_id = $1", [id])).rows;
    expect(ident).toEqual([{ provider: "google", e: "guest@outside.org" }]);
  });
});