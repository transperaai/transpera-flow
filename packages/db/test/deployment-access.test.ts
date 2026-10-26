import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, createUser, type TestDb } from "./harness";

// Better Auth and deployment access (migration 20261228000000, docs/plans/supabase-exit-brief.md step 2): the role an address
// gets, the mirror into auth.users, the per-sign-in sync of memberships, the agency-admin flag and identities, and who may edit
// the list.

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
  await db.client.query(`
    insert into deployment_access (kind, value, role) values
      ('domain', 'client.com', 'viewer'),
      ('email', 'lead@client.com', 'editor'),
      ('email', 'boss@client.com', 'admin'),
      ('email', 'someone@gmail.com', 'viewer'),
      ('domain', 'agency.io', 'editor')`);
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
    expect(await role("anyone@agency.io")).toBe("editor");
  });

  it("lets a named email beat its domain, up or down", async () => {
    expect(await role("lead@client.com")).toBe("editor");
    expect(await role("boss@client.com")).toBe("admin");
  });

  it("ignores case and surrounding spaces", async () => {
    expect(await role("  LEAD@Client.COM ")).toBe("editor");
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

  it("counts ACCESS_ADMIN_EMAILS as admin rules that need no table row", async () => {
    expect(await role("first@x.io", true, ["First@X.io"])).toBe("admin");
    expect(await role("first@x.io")).toBeNull();
    // And they win over a lower row, so an admin can't lock themselves out.
    expect(await role("lead@client.com", true, ["lead@client.com"])).toBe("admin");
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
    await expect(db.client.query("insert into deployment_access (kind, value, role) values ('email', 'x@y.io', 'owner')")).rejects.toThrow();
  });

  it("is readable and writable by agency admins only", async () => {
    const admin = { ...(await createUser(db, "listadmin@agency.test", { agency_admin: true })).claims };
    const member = { sub: randomUUID(), role: "authenticated", app_metadata: {} };
    expect(await db.as(admin, async (c) => (await c.query("select * from deployment_access")).rowCount)).toBe(5);
    expect(await db.as(member, async (c) => (await c.query("select * from deployment_access")).rowCount)).toBe(0);
    expect(await db.as(null, async (c) => (await c.query("select * from deployment_access")).rowCount)).toBe(0);
    await db.as(admin, async (c) => {
      await c.query("insert into deployment_access (kind, value, role) values ('domain', 'new.io', 'viewer')");
      expect((await c.query("update deployment_access set role = 'editor' where value = 'new.io'")).rowCount).toBe(1);
    });
    await expect(
      db.as(member, (c) => c.query("insert into deployment_access (kind, value, role) values ('domain', 'mine.io', 'admin')")),
    ).rejects.toThrow(/row-level security/);
    await db.as(member, async (c) => {
      expect((await c.query("update deployment_access set role = 'admin'")).rowCount).toBe(0);
      expect((await c.query("delete from deployment_access")).rowCount).toBe(0);
    });
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
    await db.client.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, 'member')", [ws, id]);
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

  it("adds an editor to every workspace", async () => {
    const id = await signUp("lead@client.com");
    expect(await sync(id)).toBe("editor");
    expect(new Set((await memberships(id)).map((r) => r.role))).toEqual(new Set(["editor"]));
  });

  it("raises a lower membership to the deployment role and never lowers a higher one", async () => {
    const [ws1, ws2, ws3, ws4] = await workspaceIds();
    expect(ws4).toBeDefined();
    const id = await signUp("mixed@agency.io");
    await db.client.query(
      `insert into memberships (workspace_id, user_id, role, source) values
         ($1, $5, 'owner', 'manual'), ($2, $5, 'member', 'domain'), ($3, $5, 'viewer', 'access_list'), ($4, $5, 'agency_admin', 'manual')`,
      [ws1, ws2, ws3, ws4, id],
    );
    expect(await sync(id)).toBe("editor"); // agency.io
    const byWs = Object.fromEntries((await memberships(id)).map((r) => [r.workspace_id, r]));
    expect(byWs[ws1]).toMatchObject({ role: "owner", source: "manual" });
    expect(byWs[ws2]).toMatchObject({ role: "editor", source: "manual" });
    expect(byWs[ws3]).toMatchObject({ role: "editor", source: "manual" });
    expect(byWs[ws4]).toMatchObject({ role: "agency_admin" });
  });

  it("never lowers an owner or an editor to viewer, and keeps a member above viewer", async () => {
    const [ws1, ws2, ws3] = await workspaceIds();
    const id = await signUp("keeps@client.com");
    await db.client.query(
      `insert into memberships (workspace_id, user_id, role) values ($1, $4, 'owner'), ($2, $4, 'editor'), ($3, $4, 'member')`,
      [ws1, ws2, ws3, id],
    );
    expect(await sync(id)).toBe("viewer");
    const byWs = Object.fromEntries((await memberships(id)).map((r) => [r.workspace_id, r.role]));
    expect(byWs[ws1]).toBe("owner");
    expect(byWs[ws2]).toBe("editor");
    expect(byWs[ws3]).toBe("member");
  });

  it("does not reactivate a deactivated membership or remove anything", async () => {
    const [ws1, ws2] = await workspaceIds();
    const id = await signUp("blocked@client.com");
    await db.client.query(`insert into memberships (workspace_id, user_id, role, active) values ($1, $2, 'member', false)`, [ws1, id]);
    await sync(id);
    const byWs = Object.fromEntries((await memberships(id)).map((r) => [r.workspace_id, r]));
    expect(byWs[ws1]).toMatchObject({ role: "member", active: false });
    expect(byWs[ws2]).toMatchObject({ role: "viewer", active: true });
  });

  it("makes an admin an agency admin and adds no memberships", async () => {
    const id = await signUp("boss@client.com");
    expect(await sync(id)).toBe("admin");
    expect(await agencyFlag(id)).toBe(true);
    expect(await memberships(id)).toEqual([]);
    // The flag reaches the claims the app builds, so RLS then shows every workspace.
    const claims = { sub: id, role: "authenticated", app_metadata: { agency_admin: true } };
    expect(await db.as(claims, async (c) => Number((await c.query("select count(*) from workspaces")).rows[0].count))).toBe(
      (await workspaceIds()).length,
    );
  });

  it("takes the flag away when the list no longer names the user an admin, and keeps unrelated app metadata", async () => {
    const id = await signUp("demoted@client.com");
    await db.client.query(`update auth.users set raw_app_meta_data = '{"agency_admin": true, "note": "kept"}' where id = $1`, [id]);
    await sync(id);
    expect((await db.client.query("select raw_app_meta_data as m from auth.users where id = $1", [id])).rows[0].m).toEqual({
      agency_admin: false,
      note: "kept",
    });
  });

  it("lets a bootstrap admin in with no table row", async () => {
    const id = await signUp("founder@brand-new.io");
    expect(await sync(id)).toBeNull();
    expect(await sync(id, ["founder@brand-new.io"])).toBe("admin");
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

    it("records Google's hosted domain where the domain joins read it", async () => {
      const id = await signUp("hd@client.com");
      await sync(id, [], [{ provider: "google", provider_id: "g-123", hd: "client.com" }]);
      expect(await identityData(id)).toEqual([
        {
          provider: "google",
          provider_id: "g-123",
          identity_data: { sub: "g-123", email: "hd@client.com", custom_claims: { hd: "client.com" } },
        },
      ]);
      const ok = await db.client.query("select private_qualifies as q from (select public.qualifies_for_domain($1, 'client.com') as private_qualifies) s", [id]);
      expect(ok.rows[0].q).toBe(true);
    });

    it("applies a workspace's own pre-assigned role first, so the deployment role never lowers it", async () => {
      const [ws, other] = await workspaceIds();
      const id = await signUp("pre@client.com");
      await db.client.query("insert into workspace_access_emails (workspace_id, email, role) values ($1, 'pre@client.com', 'owner')", [ws]);
      expect(await sync(id)).toBe("viewer");
      const byWs = Object.fromEntries((await memberships(id)).map((r) => [r.workspace_id, r]));
      expect(byWs[ws]).toMatchObject({ role: "owner", source: "access_list" });
      expect(byWs[other]).toMatchObject({ role: "viewer", source: "manual" });
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
