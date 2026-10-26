import { randomBytes, randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NORTHBEAM_WORKSPACE_ID, exportWorkspaceBundle, supabaseReader, supabaseWorkspaceReader, type Db } from "@transpera-flow/db";
import { rpc, type Claims } from "@transpera-flow/db/client";
import { GATEWAY_TOO_BIG_MESSAGE, LOST_CONNECTION_MESSAGE, SLOW_START_MESSAGE, restoreFailure } from "@/lib/restore/errors";
import { createTestDb, createUser, type TestDb } from "../../../packages/db/test/harness";

// POST /w/<slug>/restore/bundle (issue #39, B10 2b): the order of the refusals (env, session, origin, workspace, role, size,
// unzip, JSON, checker, then the database), what each answers, that the role is read from the database and the restore is never
// run for someone who can't edit, that `canManage` is passed on, and that no SQL text reaches any body.
// Runs against a throwaway Postgres as the signed-in user; only the session module is replaced. A database failure that can't be
// made to happen for real (a timeout, a dropped connection) is made by a plugin on the Db the route gets.

let tdb: TestDb;
const state = {
  user: null as { id: string; email: string; agencyAdmin: boolean } | null,
  claims: null as Claims | null,
  /** Runs before every query whose SQL names `match`; it may throw, to make that query fail without running it. */
  hooks: [] as { match: string; fn: () => void }[],
  seen: [] as string[],
};

vi.mock("@/lib/auth/session", () => ({
  getSessionUser: async () => state.user,
  getDb: async () => withHooks(tdb.dbAs(state.claims)),
}));

function withHooks(db: Db): Db {
  return db.withPlugin({
    // Before the query runs, so a hook that throws makes it fail without any effect.
    transformQuery(args) {
      const text = JSON.stringify(args.node, (_k, v) => (typeof v === "bigint" ? String(v) : v));
      for (const h of state.hooks) {
        if (!text.includes(h.match)) continue;
        state.seen.push(h.match);
        h.fn();
      }
      return args.node;
    },
    transformResult: async (args) => args.result,
  }) as Db;
}

const failWith = (match: string, error: unknown) => state.hooks.push({ match, fn: () => { throw error; } });
const dbError = (code: string | undefined, message: string, hint?: string) => Object.assign(new Error(message), { code, hint });

type U = { id: string; email: string };
let source: { workspaceBundle: unknown };
let editor: U;
let owner: U;
let member: U;
let viewer: U;
let stranger: U;
let agency: U;
let seq = 0;

const as = (u: U | null, agencyAdmin = false) => {
  state.user = u && { id: u.id, email: u.email, agencyAdmin };
  state.claims = u && { sub: u.id, role: "authenticated", email: u.email, app_metadata: { agency_admin: agencyAdmin } };
};

/** A new, empty workspace made by the agency admin, with one user of each role. */
async function newWorkspace() {
  const slug = `restored-${++seq}-${randomUUID().slice(0, 6)}`;
  as(agency, true);
  const id = await rpc(tdb.dbAs(state.claims), "create_workspace", { ws_name: "Restored Co", ws_slug: slug });
  for (const [u, role] of [[editor, "editor"], [owner, "owner"], [member, "member"], [viewer, "viewer"]] as const) {
    await tdb.client.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, $3)", [id, u.id, role]);
  }
  return { id, slug, base: await processCount(id) };
}

async function processCount(ws: string) {
  return Number((await tdb.client.query("select count(*) from processes where workspace_id = $1", [ws])).rows[0].count);
}

beforeAll(async () => {
  vi.stubEnv("DATABASE_URL", "postgres://unused");
  vi.stubEnv("BETTER_AUTH_SECRET", "unused");
  tdb = await createTestDb({ supabaseDefaultPrivileges: true });
  const mk = async (name: string, meta: Record<string, unknown> = {}): Promise<U> => {
    const email = `${name}-${randomUUID().slice(0, 6)}@restore-route.example.com`;
    return { id: (await createUser(tdb, email, meta)).id, email };
  };
  editor = await mk("editor");
  owner = await mk("owner");
  member = await mk("member");
  viewer = await mk("viewer");
  stranger = await mk("stranger");
  agency = await mk("agency", { agency_admin: true });
  await tdb.client.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, 'editor')", [NORTHBEAM_WORKSPACE_ID, editor.id]);
  // A real backup: Northbeam as an editor exports it.
  as(editor);
  const db = tdb.dbAs(state.claims);
  source = { workspaceBundle: await exportWorkspaceBundle(NORTHBEAM_WORKSPACE_ID, supabaseWorkspaceReader(db), supabaseReader(db), { canEdit: true, now: new Date() }) };
}, 120_000);
afterAll(async () => {
  vi.unstubAllEnvs();
  await tdb?.close();
});

beforeEach(() => {
  as(editor);
  state.hooks = [];
  state.seen = [];
});
afterEach(() => {
  vi.useRealTimers();
});

const ORIGIN = "http://localhost";
const call = async (slug: string, body: BodyInit | null, headers: Record<string, string> = {}) => {
  const { POST } = await import("@/app/w/[slug]/restore/bundle/route");
  return POST(new Request(`${ORIGIN}/w/${slug}/restore/bundle`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/gzip", "x-backup-name": encodeURIComponent("my backup.json"), ...headers }, body }), {
    params: Promise.resolve({ slug }),
  } as never);
};
const zipped = (value: unknown) => gzipSync(Buffer.from(typeof value === "string" ? value : JSON.stringify(value)));
const backup = () => zipped(source.workspaceBundle);
const RESTORE = "import_workspace_bundle";
const restoreCalls = () => state.seen.filter((m) => m === RESTORE).length;

describe("restore route", () => {
  it("says the demo has no restore (503), then asks for a session (401)", async () => {
    const { slug } = await newWorkspace();
    vi.stubEnv("DATABASE_URL", "");
    try {
      expect((await call(slug, zipped({}))).status).toBe(503);
    } finally {
      vi.stubEnv("DATABASE_URL", "postgres://unused");
    }
    as(null);
    expect((await call(slug, zipped({}))).status).toBe(401);
  });

  it("refuses a post from another origin, or with none (403 'Refused.'), before reading anything", async () => {
    const { id, slug, base } = await newWorkspace();
    state.hooks.push({ match: "workspaces", fn: () => undefined });
    for (const origin of ["https://evil.example", "", "null"]) {
      const r = await call(slug, backup(), { origin });
      expect(r.status).toBe(403);
      expect((await r.json()).message).toBe("Refused.");
    }
    expect(state.seen).toEqual([]);
    expect(await processCount(id)).toBe(base);
  });

  it("answers 404 for a workspace the user can't read or that doesn't exist", async () => {
    const { slug } = await newWorkspace();
    as(stranger);
    expect((await call(slug, zipped({}))).status).toBe(404);
    as(editor);
    expect((await call("no-such-workspace", zipped({}))).status).toBe(404);
  });

  it.each([
    ["a member", () => member],
    ["a viewer", () => viewer],
  ])("refuses %s (403) and never runs the restore", async (_who, who) => {
    const { id, slug, base } = await newWorkspace();
    as(who());
    state.hooks.push({ match: RESTORE, fn: () => undefined }, { match: "can_manage_workspace", fn: () => undefined });
    const r = await call(slug, backup());
    expect(r.status).toBe(403);
    expect((await r.json()).message).toBe("Only owners, editors and agency admins can restore a backup.");
    expect(restoreCalls()).toBe(0);
    expect(state.seen).not.toContain("can_manage_workspace");
    expect(await processCount(id)).toBe(base);
  });

  it("refuses more than 4 MB of body (413), by Content-Length and by the bytes read", async () => {
    const { id, slug, base } = await newWorkspace();
    state.hooks.push({ match: RESTORE, fn: () => undefined });
    const declared = await call(slug, zipped({}), { "content-length": String(4 * 1024 * 1024 + 1) });
    expect(declared.status).toBe(413);
    const real = await call(slug, randomBytes(4 * 1024 * 1024 + 10));
    expect(real.status).toBe(413);
    expect((await real.json()).message).toMatch(/too big to restore in one go/);
    expect(restoreCalls()).toBe(0);
    expect(await processCount(id)).toBe(base);
  });

  it("stops a gzip bomb when what it unpacks passes 25 MB (413)", async () => {
    const { slug } = await newWorkspace();
    state.hooks.push({ match: RESTORE, fn: () => undefined });
    const bomb = gzipSync(Buffer.alloc(26 * 1024 * 1024));
    expect(bomb.length).toBeLessThan(4 * 1024 * 1024);
    const r = await call(slug, bomb);
    expect(r.status).toBe(413);
    expect(restoreCalls()).toBe(0);
  });

  it("answers 400 for a body that isn't gzip, and for gzip that isn't JSON", async () => {
    const { slug } = await newWorkspace();
    expect((await call(slug, Buffer.from("not gzip at all"))).status).toBe(400);
    const r = await call(slug, zipped("{ not json"));
    expect(r.status).toBe(400);
    expect((await r.json()).message).toBe("That file isn't valid JSON.");
  });

  it("answers 400 with the checker's message for an unknown format, a process file and a non-backup", async () => {
    const { slug } = await newWorkspace();
    state.hooks.push({ match: RESTORE, fn: () => undefined });
    const unknown = await call(slug, zipped({ format: "transpera-workspace/2" }));
    expect(unknown.status).toBe(400);
    expect((await unknown.json()).message).toBe("This backup is in a format this version of Transpera Flow can't read (transpera-workspace/2). It may have been made by a newer version.");
    const proc = await call(slug, zipped({ format: "transpera-process/2" }));
    expect((await proc.json()).message).toMatch(/process file, not a workspace backup/);
    const other = await call(slug, zipped([1, 2]));
    expect((await other.json()).message).toMatch(/isn't a Transpera Flow workspace backup/);
    expect(restoreCalls()).toBe(0);
  });

  it.each([
    ["an editor (can't manage)", () => editor, "suggested"],
    ["an owner (can manage)", () => owner, "applied"],
  ])("restores a real backup for %s, passing canManage on as the database says", async (_who, who, settings) => {
    const { id, slug, base } = await newWorkspace();
    as(who());
    const r = await call(slug, backup());
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("private, no-store");
    const body = await r.json();
    expect(body.settings).toBe(settings);
    expect(body.processes.length).toBeGreaterThan(0);
    for (const p of body.processes) expect(Object.keys(p).sort()).toEqual(["id", "name"]);
    expect(body.counts).toEqual(expect.objectContaining({ roles: expect.any(Number) }));
    expect(Array.isArray(body.leftOut)).toBe(true);
    expect(await processCount(id)).toBeGreaterThanOrEqual(base + body.processes.length);
    // The label the browser sent is kept in the audit log of what was restored.
    const logged = await tdb.client.query("select count(*)::int as n from audit_log where workspace_id = $1 and action = 'import' and diff::text like '%my backup.json%'", [id]);
    expect(logged.rows[0].n).toBeGreaterThan(0);
  });

  it("refuses a second restore into a workspace that now has processes (409), whole and as it was", async () => {
    const { id, slug, base } = await newWorkspace();
    expect((await call(slug, backup())).status).toBe(200);
    const before = await processCount(id);
    const r = await call(slug, backup());
    expect(r.status).toBe(409);
    expect((await r.json()).message).toMatch(/Backups restore only into an empty workspace/);
    expect(await processCount(id)).toBe(before);
  });

  it("maps each database refusal to its message, and no SQL text reaches any body", async () => {
    const { slug } = await newWorkspace();
    const cases: [ReturnType<typeof dbError>, number, RegExp][] = [
      [dbError("42501", "Only owners, editors and agency admins can restore a backup."), 403, /Only owners, editors and agency admins/],
      [dbError("23514", "This workspace isn't empty: it already has roles. Backups restore only into a new, empty workspace.", "not_empty"), 409, /Backups restore only into an empty workspace/],
      [dbError("23514", 'import_workspace_bundle: suggestions could not be restored: new row for relation "suggestions" violates check constraint "suggestions_target_table"', "section:suggestions"), 422, /Couldn't restore the pending suggestions: a row didn't fit this workspace's rules/],
      [dbError("55000", "import_workspace_bundle: archive could not be restored: A new process can't start archived", "section:archive"), 422, /Couldn't restore the archived processes: A new process can't start archived\./],
      [dbError("57014", "canceling statement due to statement timeout"), 504, /too big to restore in one go \(the database ran out of time\)\. Nothing was restored\./],
      [dbError("XX000", 'select * from secret_table where "x" = $1 failed'), 500, /^The restore failed\. Nothing was restored\. Try again\.$/],
    ];
    for (const [error, status, message] of cases) {
      state.hooks = [];
      failWith(RESTORE, error);
      const r = await call(slug, backup());
      expect(r.status, error.message).toBe(status);
      const text = JSON.stringify(await r.json());
      expect(JSON.parse(text).message).toMatch(message);
      expect(text).not.toMatch(/secret_table|violates|relation|constraint|select \*|\$1/);
    }
  });

  // B21 (#203): one restore call may run for 40 s, so the route doesn't start it once more than 15 s have gone since the request arrived
  // (15 s + 40 s stays inside its 60 s). The clock is moved after the body is read, as a slow read would.
  describe("the 15 s rule", () => {
    const slowRead = (ms: number) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(1_000_000);
      // The route asks `can_manage_workspace` once the body is read and checked.
      state.hooks.push({ match: "can_manage_workspace", fn: () => vi.setSystemTime(1_000_000 + ms) });
    };

    it("answers 503 with the slow-start message and never calls the database when reading took over 15 s", async () => {
      const { id, slug, base } = await newWorkspace();
      state.hooks.push({ match: RESTORE, fn: () => undefined });
      slowRead(15_001);
      const r = await call(slug, backup());
      expect(r.status).toBe(503);
      expect(r.headers.get("cache-control")).toBe("private, no-store");
      expect((await r.json()).message).toBe(SLOW_START_MESSAGE);
      expect(restoreCalls()).toBe(0);
      expect(await processCount(id)).toBe(base);
    });

    it.each([0, 14_999, 15_000])("starts the database call when reading took %i ms (the rule is more than 15 s)", async (ms) => {
      const { slug } = await newWorkspace();
      state.hooks.push({ match: RESTORE, fn: () => undefined });
      slowRead(ms);
      const r = await call(slug, backup());
      expect(r.status).toBe(200);
      expect(restoreCalls()).toBe(1);
    });

    it("keeps the earlier refusals as they were (a bad body is refused at once, whatever the clock)", async () => {
      const { slug } = await newWorkspace();
      slowRead(60_000);
      const r = await call(slug, zipped("{ not json"));
      expect(r.status).toBe(400);
    });
  });

  it("keeps the gateway's 'too big' answer for an error with no code and HTTP 413 (restoreFailure; the route has no gateway now)", () => {
    // There is no HTTP gateway between the route and the database any more, so the route can't see a status. The words stay, in case
    // a proxy in front of the database ever brings it back.
    expect(restoreFailure({ message: "Request Entity Too Large" }, 413)).toEqual({ status: 413, message: GATEWAY_TOO_BIG_MESSAGE });
  });

  it("answers the lost-connection message, not 'Nothing was restored', when the database call got no answer", async () => {
    const { slug } = await newWorkspace();
    failWith(RESTORE, new Error("Connection terminated unexpectedly"));
    const r = await call(slug, backup());
    expect(r.status).toBe(502);
    expect((await r.json()).message).toBe(LOST_CONNECTION_MESSAGE);
  });

  it("maps a restore already running (hint busy) to 409 and its message", async () => {
    const { slug } = await newWorkspace();
    failWith(RESTORE, dbError("55P03", "A restore into this workspace is already running.", "busy"));
    const r = await call(slug, backup());
    expect(r.status).toBe(409);
    expect((await r.json()).message).toBe("A restore into this workspace is already running. Wait a minute, then reload this page.");
  });
});
