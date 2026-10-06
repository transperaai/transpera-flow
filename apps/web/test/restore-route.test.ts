import { randomBytes } from "node:crypto";
import { gzipSync } from "node:zlib";
import { beforeEach, describe, expect, it, vi } from "vitest";

// POST /w/<slug>/restore/bundle (issue #39, B10 2b): the order of the refusals (env, session, origin, workspace, role, size,
// unzip, JSON, checker, then the database), what each answers, that the role is read from the database and the RPC is never
// called for someone who can't edit, that `canManage` is passed on, and that no SQL text reaches any body.

type RpcAnswer = { data?: unknown; error?: { code?: string; message?: string; hint?: string } | null };
const state = {
  env: true,
  claims: { claims: { sub: "u1" } } as { claims?: { sub?: string } } | null,
  workspace: { id: "w1" } as { id: string } | null,
  canEdit: true,
  canManage: true,
  forceOk: false,
  restore: { data: { processes: [{ id: "p1", name: "Intake", revision_id: "r1" }], counts: { roles: 2 }, settings: "applied" }, error: null } as RpcAnswer,
  rpcCalls: [] as { name: string; args: Record<string, unknown> }[],
  planOptions: [] as unknown[],
};

vi.mock("@/lib/supabase/env", () => ({ supabaseEnv: () => (state.env ? { url: "x", key: "y" } : null) }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getClaims: async () => ({ data: state.claims }) },
    rpc: async (name: string, args: Record<string, unknown>) => {
      state.rpcCalls.push({ name, args });
      if (name === "can_edit_workspace") return { data: state.canEdit };
      if (name === "can_manage_workspace") return { data: state.canManage };
      return state.restore;
    },
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: state.workspace, error: null }) }) }) }),
  }),
}));
vi.mock("@transpera-flow/db", async (orig) => {
  const real = await orig<typeof import("@transpera-flow/db")>();
  return {
    ...real,
    checkWorkspaceBundle: (v: unknown) => (state.forceOk ? { ok: true, errors: [], warnings: [], summary: { restored: [], leftOut: [], settings: "none", measures: {} } } : real.checkWorkspaceBundle(v)),
    planWorkspaceImport: (b: unknown, options: unknown) => {
      if (!state.forceOk) return real.planWorkspaceImport(b as never, options as never);
      state.planOptions.push(options);
      return { plan: { format: "transpera-workspace-import/1" }, summary: { leftOut: [{ key: "solutions", label: "solutions and their links", count: 2 }] }, placeholderOf: new Map(), warnings: [] };
    },
  };
});

const ORIGIN = "http://localhost";
const call = async (body: BodyInit | null, headers: Record<string, string> = {}, slug = "northbeam") => {
  const { POST } = await import("@/app/w/[slug]/restore/bundle/route");
  return POST(new Request(`${ORIGIN}/w/${slug}/restore/bundle`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/gzip", "x-backup-name": encodeURIComponent("my backup.json"), ...headers }, body }), {
    params: Promise.resolve({ slug }),
  } as never);
};
const zipped = (value: unknown) => gzipSync(Buffer.from(typeof value === "string" ? value : JSON.stringify(value)));
const restoreCalls = () => state.rpcCalls.filter((c) => c.name === "import_workspace_bundle");

beforeEach(() => {
  state.env = true;
  state.claims = { claims: { sub: "u1" } };
  state.workspace = { id: "w1" };
  state.canEdit = true;
  state.canManage = true;
  state.forceOk = false;
  state.restore = { data: { processes: [{ id: "p1", name: "Intake", revision_id: "r1" }], counts: { roles: 2 }, settings: "applied" }, error: null };
  state.rpcCalls = [];
  state.planOptions = [];
});

describe("restore route", () => {
  it("says the demo has no restore (503), then asks for a session (401)", async () => {
    state.env = false;
    expect((await call(zipped({}))).status).toBe(503);
    state.env = true;
    state.claims = null;
    expect((await call(zipped({}))).status).toBe(401);
    state.claims = { claims: {} };
    expect((await call(zipped({}))).status).toBe(401);
  });

  it("refuses a post from another origin, or with none (403 'Refused.'), before reading anything", async () => {
    for (const origin of ["https://evil.example", "", "null"]) {
      const r = await call(zipped({}), { origin });
      expect(r.status).toBe(403);
      expect((await r.json()).message).toBe("Refused.");
    }
    expect(state.rpcCalls).toEqual([]);
  });

  it("answers 404 for a workspace the user can't read or that doesn't exist", async () => {
    state.workspace = null;
    expect((await call(zipped({}))).status).toBe(404);
  });

  it("refuses a member or viewer (403) and never calls the restore", async () => {
    state.canEdit = false;
    const r = await call(zipped({ format: "transpera-workspace/1" }));
    expect(r.status).toBe(403);
    expect((await r.json()).message).toBe("Only owners, editors and agency admins can restore a backup.");
    expect(restoreCalls()).toEqual([]);
    expect(state.rpcCalls.map((c) => c.name)).toEqual(["can_edit_workspace"]);
  });

  it("refuses more than 4 MB of body (413), by Content-Length and by the bytes read", async () => {
    const declared = await call(zipped({}), { "content-length": String(4 * 1024 * 1024 + 1) });
    expect(declared.status).toBe(413);
    const real = await call(randomBytes(4 * 1024 * 1024 + 10));
    expect(real.status).toBe(413);
    expect((await real.json()).message).toMatch(/too big to restore in one go/);
    expect(restoreCalls()).toEqual([]);
  });

  it("stops a gzip bomb when what it unpacks passes 25 MB (413)", async () => {
    const bomb = gzipSync(Buffer.alloc(26 * 1024 * 1024));
    expect(bomb.length).toBeLessThan(4 * 1024 * 1024);
    const r = await call(bomb);
    expect(r.status).toBe(413);
    expect(restoreCalls()).toEqual([]);
  });

  it("answers 400 for a body that isn't gzip, and for gzip that isn't JSON", async () => {
    expect((await call(Buffer.from("not gzip at all"))).status).toBe(400);
    const r = await call(zipped("{ not json"));
    expect(r.status).toBe(400);
    expect((await r.json()).message).toBe("That file isn't valid JSON.");
  });

  it("answers 400 with the checker's message for an unknown format, a process file and a non-backup", async () => {
    const unknown = await call(zipped({ format: "transpera-workspace/2" }));
    expect(unknown.status).toBe(400);
    expect((await unknown.json()).message).toBe("This backup is in a format this version of Transpera Flow can't read (transpera-workspace/2). It may have been made by a newer version.");
    const proc = await call(zipped({ format: "transpera-process/2" }));
    expect((await proc.json()).message).toMatch(/process file, not a workspace backup/);
    const other = await call(zipped([1, 2]));
    expect((await other.json()).message).toMatch(/isn't a Transpera Flow workspace backup/);
    expect(restoreCalls()).toEqual([]);
  });

  it.each([
    [true, true],
    [false, false],
  ])("restores, passing canManage=%s as the database says (editor: %s)", async (canManage) => {
    state.forceOk = true;
    state.canManage = canManage;
    const r = await call(zipped({ format: "transpera-workspace/1" }));
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("private, no-store");
    expect(state.planOptions).toEqual([{ canManage }]);
    const body = await r.json();
    expect(body).toEqual({ processes: [{ id: "p1", name: "Intake" }], counts: { roles: 2 }, leftOut: [{ key: "solutions", label: "solutions and their links", count: 2 }], settings: "applied" });
    const [call1] = restoreCalls();
    expect(call1!.args).toMatchObject({ p_workspace: "w1", p_label: "my backup.json" });
  });

  it("maps each database refusal to its message, and no SQL text reaches any body", async () => {
    state.forceOk = true;
    const cases: [{ code?: string; message: string; hint?: string }, number, RegExp][] = [
      [{ code: "42501", message: "Only owners, editors and agency admins can restore a backup." }, 403, /Only owners, editors and agency admins/],
      [{ code: "23514", message: "This workspace isn't empty: it already has roles. Backups restore only into a new, empty workspace.", hint: "not_empty" }, 409, /Backups restore only into an empty workspace/],
      [{ code: "23514", message: 'import_workspace_bundle: suggestions could not be restored: new row for relation "suggestions" violates check constraint "suggestions_target_table"', hint: "section:suggestions" }, 422, /Couldn't restore the pending suggestions: a row didn't fit this workspace's rules/],
      [{ code: "55000", message: "import_workspace_bundle: archive could not be restored: A new process can't start archived", hint: "section:archive" }, 422, /Couldn't restore the archived processes: A new process can't start archived\./],
      [{ code: "57014", message: "canceling statement due to statement timeout" }, 504, /too big to restore in one go \(the database ran out of time\)\. Nothing was restored\./],
      [{ code: "XX000", message: 'select * from secret_table where "x" = $1 failed' }, 500, /^The restore failed\. Nothing was restored\. Try again\.$/],
    ];
    for (const [error, status, message] of cases) {
      state.restore = { data: null, error };
      const r = await call(zipped({ format: "transpera-workspace/1" }));
      expect(r.status, error.message).toBe(status);
      const text = JSON.stringify(await r.json());
      expect(JSON.parse(text).message).toMatch(message);
      expect(text).not.toMatch(/secret_table|violates|relation|constraint|select \*|\$1/);
    }
  });
});
