import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ENGINE_VERSION } from "@transpera-flow/engine";
import {
  NORTHBEAM_WORKSPACE_ID,
  LARKSPUR_PROCESS_ID,
  LARKSPUR_REVISION_ID,
  LARKSPUR_WORKSPACE_ID,
  loadShareData,
  loadShareSecrets,
  shareSnapshotLeaks,
  type Db,
  type ShareKind,
  type ShareSecrets,
  type ShareSnapshot,
  type ShareToggles,
} from "@transpera-flow/db";
import { generateApiToken } from "../src";
import { signJwt } from "./helpers";

// Share links over PostgREST (issue #32, B3; migration 20261218000000): the acceptance test "tests inspect the raw payload". An
// editor builds a snapshot of each kind under each toggle combination on Larkspur (which has pay rates; here it also gets emails and
// notes on people and clients), saves it, and an anonymous or allowed visitor opens it through `open_share_link`. Every assertion is on
// the raw JSON PostgREST returned. Skipped unless POSTGREST_URL is set (see postgrest-db.ts).

const POSTGREST_URL = process.env.POSTGREST_URL;
const JWT_SECRET = process.env.POSTGREST_JWT_SECRET ?? "";
const ADMIN_URL = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/postgres";
const DATABASE_NAME = process.env.POSTGREST_DATABASE ?? "transpera_flow_postgrest";

const ws = LARKSPUR_WORKSPACE_ID;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const newToken = () => randomBytes(32).toString("base64url");
const TOGGLES: ShareToggles[] = [
  { people: false, financials: false },
  { people: true, financials: false },
  { people: false, financials: true },
  { people: true, financials: true },
];
const KINDS: ShareKind[] = ["overview", "process", "issue", "solution"];
const label = (t: ShareToggles) => `People ${t.people ? "on" : "off"}, Financials ${t.financials ? "on" : "off"}`;

describe.skipIf(!POSTGREST_URL)("share links over PostgREST", () => {
  let admin: pg.Client;
  const users = { editor: "", member: "", visitor: "", stranger: "" };
  const visitorEmail = `visitor-${randomUUID().slice(0, 8)}@visit.example`;
  let apiToken = "";
  let editorSession: SupabaseClient;
  let memberSession: SupabaseClient;
  let visitorSession: SupabaseClient;
  let strangerSession: SupabaseClient;
  let anon: SupabaseClient;
  let apiSession: SupabaseClient;
  let secrets: ShareSecrets;
  let issueId = "";
  let solutionId = "";
  const saved: { people: unknown[]; clients: unknown[] } = { people: [], clients: [] };
  const madeTokens: string[] = [];

  const session = (bearer: string, extra: Record<string, string> = {}): SupabaseClient =>
    createClient("http://postgrest.invalid", bearer, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: {
        headers: { authorization: `Bearer ${bearer}`, ...extra },
        fetch: (input, init) => fetch(String(input instanceof Request ? input.url : input).replace("http://postgrest.invalid/rest/v1", POSTGREST_URL!), init),
      },
    });
  const jwt = (sub: string) => signJwt({ sub, role: "authenticated", aud: "authenticated", app_metadata: {} }, JWT_SECRET);

  beforeAll(async () => {
    const url = new URL(ADMIN_URL);
    url.pathname = `/${DATABASE_NAME}`;
    admin = new pg.Client({ connectionString: url.toString() });
    await admin.connect();
    const tag = randomUUID().slice(0, 8);
    for (const k of Object.keys(users) as (keyof typeof users)[]) {
      users[k] = randomUUID();
      await admin.query("insert into auth.users (id, email) values ($1, $2)", [users[k], k === "visitor" ? visitorEmail : `share-${k}-${tag}@example.com`]);
    }
    // The visitor signs in with Google: restricted links need that identity, not just a confirmed address.
    await admin.query("insert into auth.identities (user_id, provider, provider_id, identity_data) values ($1, 'google', $2, $3)", [users.visitor, users.visitor, { sub: users.visitor, email: visitorEmail }]);
    await admin.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, 'editor'), ($1, $3, 'member'), ($4, $2, 'editor')", [ws, users.editor, users.member, NORTHBEAM_WORKSPACE_ID]);
    const { token, hash } = generateApiToken();
    await admin.query("insert into api_tokens (user_id, token_hash, label) values ($1, $2, 'share')", [users.editor, hash]);
    apiToken = token;
    editorSession = session(jwt(users.editor));
    memberSession = session(jwt(users.member));
    visitorSession = session(jwt(users.visitor));
    strangerSession = session(jwt(users.stranger));
    const anonJwt = signJwt({ role: "anon", iss: "test" }, JWT_SECRET);
    anon = session(anonJwt);
    apiSession = session(anonJwt, { "x-api-token": apiToken });

    // Something to leak: emails and notes on every person, notes on every client (Larkspur already has pay rates).
    saved.people = (await admin.query("select id, email, notes from people where workspace_id = $1", [ws])).rows;
    saved.clients = (await admin.query("select id, notes from clients where workspace_id = $1", [ws])).rows;
    await admin.query("update people set email = lower(split_part(name, ' ', 1)) || '@larkspur-private.example', notes = 'Private note about ' || name where workspace_id = $1", [ws]);
    await admin.query("update clients set notes = 'Renewal talk with ' || name where workspace_id = $1", [ws]);
    const person = (await admin.query("select name from people where workspace_id = $1 order by created_at, id limit 1", [ws])).rows[0].name as string;
    const client = (await admin.query("select name from clients where workspace_id = $1 order by created_at, id limit 1", [ws])).rows[0].name as string;
    issueId = (
      await admin.query("insert into issues (workspace_id, process_id, type, title, evidence) values ($1, $2, 'delay', $3, $4) returning id", [
        ws,
        LARKSPUR_PROCESS_ID,
        `Ask ${person} about ${client}`,
        `${person.split(" ")[0]} says it costs £4,100 a month. Mail ${person.split(" ")[0]!.toLowerCase()}@larkspur-private.example.`,
      ])
    ).rows[0].id;
    solutionId = (
      await admin.query("insert into solutions (workspace_id, process_id, base_revision_id, name, notes, steps) values ($1, $2, $3, $4, $5, $6::jsonb) returning id", [
        ws,
        LARKSPUR_PROCESS_ID,
        LARKSPUR_REVISION_ID,
        `Fix for ${client}`,
        `${person} owns it. Budget £9,000.`,
        JSON.stringify({ steps: [], edges: [], entry_step_id: null }),
      ])
    ).rows[0].id;

    const deadline = Date.now() + 60_000;
    while ((await editorSession.from("workspaces").select("id").eq("id", ws)).data?.length !== 1) {
      if (Date.now() > deadline) throw new Error("PostgREST never became ready");
      await new Promise((r) => setTimeout(r, 1000));
    }
    secrets = await loadShareSecrets(editorSession as unknown as Db, ws);
  }, 120_000);

  afterAll(async () => {
    if (!admin) return;
    await admin.query("delete from share_links where workspace_id = $1", [ws]);
    await admin.query("delete from solutions where id = $1", [solutionId]);
    await admin.query("delete from issues where id = $1", [issueId]);
    for (const p of saved.people as { id: string; email: string | null; notes: string | null }[]) await admin.query("update people set email = $2, notes = $3 where id = $1", [p.id, p.email, p.notes]);
    for (const c of saved.clients as { id: string; notes: string | null }[]) await admin.query("update clients set notes = $2 where id = $1", [c.id, c.notes]);
    await admin.query("delete from memberships where user_id = any($1)", [[users.editor, users.member]]);
    await admin.query("delete from share_links where workspace_id = $1", [NORTHBEAM_WORKSPACE_ID]);
    await admin.query("delete from api_tokens where user_id = $1", [users.editor]);
    await admin.query("delete from auth.users where id = any($1)", [Object.values(users)]);
    await admin.end();
  });

  const workspaceRow = async () => (await editorSession.from("workspaces").select("id, name, slug, settings").eq("id", ws).single()).data!;
  const targetId = (kind: ShareKind) => (kind === "overview" ? null : kind === "process" ? LARKSPUR_PROCESS_ID : kind === "issue" ? issueId : solutionId);

  async function build(kind: ShareKind, toggles: ShareToggles): Promise<ShareSnapshot> {
    return loadShareData(editorSession as unknown as Db, await workspaceRow(), { kind, id: targetId(kind) }, toggles);
  }

  /** Saves `snapshot` as the editor through PostgREST; returns the token and the insert's outcome. */
  async function save(kind: ShareKind, toggles: ShareToggles, snapshot: unknown, over: Record<string, unknown> = {}) {
    const token = newToken();
    madeTokens.push(token);
    const restricted = toggles.people || toggles.financials;
    const res = await editorSession.from("share_links").insert({
      workspace_id: ws,
      token_hash: sha(token),
      kind,
      target_id: targetId(kind),
      show_people: toggles.people,
      show_financials: toggles.financials,
      allowed_emails: restricted ? [visitorEmail] : [],
      expires_at: restricted ? new Date(Date.now() + 7 * 86400_000).toISOString() : null,
      snapshot: snapshot as never,
      engine_version: ENGINE_VERSION,
      ...over,
    });
    return { token, res };
  }

  const open = async (client: SupabaseClient, token: string) => client.rpc("open_share_link", { token });

  // The strings that must never reach a visitor.
  const names = async (table: "people" | "clients") => ((await admin.query(`select name from ${table} where workspace_id = $1`, [ws])).rows as { name: string }[]).map((r) => r.name);

  for (const kind of KINDS) {
    for (const toggles of TOGGLES) {
      it(`${kind}, ${label(toggles)}: the raw payload a visitor gets holds no hidden field`, async () => {
        const snapshot = await build(kind, toggles);
        // The builder's own check, then the database's (below).
        expect(shareSnapshotLeaks(snapshot, secrets, toggles)).toEqual([]);
        const { token, res } = await save(kind, toggles, snapshot);
        expect(res.error, JSON.stringify(res.error)).toBeNull();

        const restricted = toggles.people || toggles.financials;
        // Anonymous: an open link opens, a restricted one asks for sign-in and carries nothing else.
        const asAnon = await open(anon, token);
        expect(asAnon.error).toBeNull();
        if (restricted) {
          expect(asAnon.data).toEqual({ status: "sign_in" });
        } else {
          expect((asAnon.data as { status: string }).status).toBe("ok");
        }
        // A signed-in visitor on the allowed list opens a restricted link; someone else gets not_allowed.
        if (restricted) {
          expect((await open(strangerSession, token)).data).toEqual({ status: "not_allowed" });
          expect((await open(memberSession, token)).data).toEqual({ status: "not_allowed" });
        }
        const opened = await open(restricted ? visitorSession : anon, token);
        expect(opened.error).toBeNull();
        const payload = opened.data as { status: string; kind: string; show_people: boolean; show_financials: boolean; snapshot: Record<string, unknown> };
        expect(payload.status).toBe("ok");
        expect(payload).toMatchObject({ kind, show_people: toggles.people, show_financials: toggles.financials });
        expect(Object.keys(payload).sort()).toEqual(["expires_at", "kind", "mode", "show_financials", "show_people", "snapshot", "snapshot_at", "status"]);

        // The raw JSON, as PostgREST sent it.
        const raw = JSON.stringify(opened.data);
        expect(raw).not.toMatch(/[a-z0-9._%+-]*[a-z0-9_%+-]@[a-z0-9.-]+\.[a-z]{2,}/i);
        expect(raw).not.toMatch(/"cost_rate":\s*[0-9-]/);
        expect(raw).not.toContain("larkspur-private");
        for (const c of await names("clients")) expect(raw, `client ${c}`).not.toContain(c);
        if (!toggles.people) {
          for (const p of await names("people")) {
            expect(raw, `person ${p}`).not.toContain(p);
            const first = p.split(" ")[0]!;
            if (first.length >= 3) expect(raw, `first name ${first}`).not.toMatch(new RegExp(`(?<![A-Za-z0-9])${first}(?![A-Za-z0-9])`));
          }
          expect(raw).toMatch(/Team member \d+/);
        } else {
          // The toggle shows names, so the test proves something.
          expect(raw).toContain((await names("people"))[0]);
        }
        if (!toggles.financials) {
          expect(raw).not.toMatch(/overhead_monthly|target_margin/);
          expect(raw).not.toMatch(/£\s?\d|\$\s?\d|€\s?\d/);
          // Every role rate is zero, every margin is zero.
          for (const m of raw.matchAll(/"default_cost_rate":\s*([0-9.]+)/g)) expect(Number(m[1])).toBe(0);
          for (const m of raw.matchAll(/"margin":\s*([0-9.]+)/g)) expect(Number(m[1])).toBe(0);
        } else {
          expect([...raw.matchAll(/"default_cost_rate":\s*([0-9.]+)/g)].some((m) => Number(m[1]) > 0)).toBe(true);
        }
        // Provenance, anywhere, is empty.
        expect(raw).not.toMatch(/"provenance":\s*\{\s*"/);
        // Real ids, so a visitor's run matches the editor's.
        expect(raw).toContain(LARKSPUR_PROCESS_ID);
      }, 60_000);
    }
  }

  it("a leaky hand-made snapshot is refused by the database (23514), for each kind of leak, with a message that names no value", async () => {
    const good = await build("overview", TOGGLES[0]!);
    const person = (await names("people"))[0]!;
    const client = (await names("clients"))[0]!;
    const cases: [string, Record<string, unknown>, ShareToggles][] = [
      ["email", { x: "a@b.example" }, TOGGLES[0]!],
      ["pay", { x: { cost_rate: 40 } }, TOGGLES[0]!],
      ["evidence", { x: { provenance: { a: 1 } } }, TOGGLES[0]!],
      ["client", { x: `at ${client}` }, TOGGLES[0]!],
      ["person", { x: `ask ${person}` }, TOGGLES[0]!],
      ["costs", { x: { default_cost_rate: 55 } }, TOGGLES[0]!],
    ];
    for (const [what, patch, toggles] of cases) {
      const { res } = await save("overview", toggles, { ...good, ...patch });
      expect(res.error?.code, what).toBe("23514");
      expect(res.error?.message, what).toMatch(/^The snapshot (contains|names)/);
      expect(res.error?.message).not.toContain(person);
      expect(res.error?.message).not.toContain(client);
      expect(res.status, what).toBe(400);
    }
    // Pay is refused even with both toggles on.
    const both = await build("overview", TOGGLES[3]!);
    const { res } = await save("overview", TOGGLES[3]!, { ...both, x: { cost_rate: 12 } });
    expect(res.error?.code).toBe("23514");
  });

  it("a toggle on with no emails, or no expiry, is refused (23514 share_links_restricted)", async () => {
    const snapshot = await build("overview", TOGGLES[1]!);
    const noEmails = await save("overview", TOGGLES[1]!, snapshot, { allowed_emails: [] });
    expect(noEmails.res.error?.code).toBe("23514");
    expect(noEmails.res.error?.message).toMatch(/share_links_restricted/);
    const noExpiry = await save("overview", TOGGLES[1]!, snapshot, { expires_at: null });
    expect(noExpiry.res.error?.code).toBe("23514");
    expect(noExpiry.res.error?.message).toMatch(/share_links_restricted/);
  });

  it("expired and revoked links return nothing; an unknown or malformed token returns nothing", async () => {
    const snapshot = await build("overview", TOGGLES[0]!);
    const live = await save("overview", TOGGLES[0]!, snapshot);
    expect(live.res.error).toBeNull();
    expect(((await open(anon, live.token)).data as { status: string }).status).toBe("ok");
    // The editor can't read the hash, so finds the row by id (as the app does) and turns it off through the API.
    const id = (await admin.query("select id from share_links where token_hash = $1", [sha(live.token)])).rows[0].id as string;
    const turnedOff = await editorSession.from("share_links").update({ revoked_at: new Date().toISOString() }).eq("id", id).select("id, revoked_at, revoked_by");
    expect(turnedOff.error).toBeNull();
    expect(turnedOff.data?.[0]?.revoked_by).toBe(users.editor);
    expect((await open(anon, live.token)).data).toBeNull();
    // It can't be turned back on.
    const back = await editorSession.from("share_links").update({ revoked_at: null }).eq("id", id);
    expect(back.error?.code).toBe("22023");
    // Expired: age the row (the expiry can't be edited through the API).
    const exp = await save("overview", TOGGLES[0]!, snapshot, { expires_at: new Date(Date.now() + 60_000).toISOString() });
    expect(exp.res.error).toBeNull();
    await admin.query("alter table share_links disable trigger share_links_before_write");
    await admin.query("update share_links set expires_at = now() - interval '1 second' where token_hash = $1", [sha(exp.token)]);
    await admin.query("alter table share_links enable trigger share_links_before_write");
    expect((await open(anon, exp.token)).data).toBeNull();
    expect((await open(anon, newToken())).data).toBeNull();
    expect((await open(anon, "not-a-token")).data).toBeNull();
  });

  it("a member can't make or read a link; an API token can't make one (42501)", async () => {
    const snapshot = await build("overview", TOGGLES[0]!);
    const token = newToken();
    const refused = await memberSession.from("share_links").insert({ workspace_id: ws, token_hash: sha(token), kind: "overview", snapshot: snapshot as never, engine_version: ENGINE_VERSION });
    expect(refused.error?.code).toBe("42501");
    const read = await memberSession.from("share_links").select("id, kind");
    expect(read.data).toEqual([]);
    expect((await anon.from("share_links").select("id")).error?.code).toBe("42501");
    // The editor reads the list, without the hash or the snapshot.
    const list = await editorSession.from("share_links").select("id, kind, show_people, opens");
    expect(list.error).toBeNull();
    expect(list.data!.length).toBeGreaterThan(0);
    expect((await editorSession.from("share_links").select("token_hash")).error?.code).toBe("42501");
    expect((await editorSession.from("share_links").select("snapshot")).error?.code).toBe("42501");
    // An API token (the MCP server's request path) is refused by the trigger.
    const viaToken = await apiSession.from("share_links").insert({ workspace_id: ws, token_hash: sha(newToken()), kind: "overview", snapshot: snapshot as never, engine_version: ENGINE_VERSION });
    expect(viaToken.error?.code).toBe("42501");
  });

  it("the Overview snapshots of Northbeam and Larkspur are well under 2 MB, in every toggle combination", async () => {
    const sizes: Record<string, number> = {};
    for (const [slug, id] of [["northbeam", NORTHBEAM_WORKSPACE_ID], ["larkspur", ws]] as const) {
      const workspace = (await editorSession.from("workspaces").select("id, name, slug, settings").eq("id", id).single()).data!;
      for (const toggles of TOGGLES) {
        const snapshot = await loadShareData(editorSession as unknown as Db, workspace, { kind: "overview", id: null }, toggles);
        const bytes = Buffer.byteLength(JSON.stringify(snapshot));
        sizes[`${slug} ${label(toggles)}`] = bytes;
        expect(bytes, `${slug} ${label(toggles)}`).toBeLessThan(2 * 1024 * 1024);
      }
    }
    console.info("Overview snapshot sizes (bytes):", JSON.stringify(sizes, null, 1));
  }, 120_000);

  it("an issue on a process that has no published version is refused, never shared as a draft or as another process", async () => {
    const proc = (await admin.query("insert into processes (workspace_id, name) values ($1, 'Never published') returning id", [ws])).rows[0].id as string;
    const iss = (await admin.query("insert into issues (workspace_id, process_id, type, title) values ($1, $2, 'delay', 'On a draft process') returning id", [ws, proc])).rows[0].id as string;
    try {
      await expect(loadShareData(editorSession as unknown as Db, await workspaceRow(), { kind: "issue", id: iss }, TOGGLES[0]!)).rejects.toThrow(/Publish this process first/);
    } finally {
      await admin.query("delete from issues where id = $1", [iss]);
      await admin.query("delete from processes where id = $1", [proc]);
    }
  });

  it("an issue or a solution of an archived process is refused, like the process itself", async () => {
    const sol = targetId("solution")!;
    const proc = (await admin.query("select process_id from solutions where id = $1", [sol])).rows[0].process_id as string;
    const iss = (await admin.query("insert into issues (workspace_id, process_id, type, title) values ($1, $2, 'delay', 'On a process that will be archived') returning id", [ws, proc])).rows[0].id as string;
    const setArchived = async (on: boolean) => {
      // The superuser, with the archive guards off (the real ones refuse while a service enters the process).
      await admin.query("set session_replication_role = replica");
      await admin.query(`update processes set archived_at = ${on ? "now()" : "null"} where id = $1`, [proc]);
      await admin.query("set session_replication_role = origin");
    };
    await setArchived(true);
    try {
      const workspace = await workspaceRow();
      await expect(loadShareData(editorSession as unknown as Db, workspace, { kind: "issue", id: iss }, TOGGLES[0]!)).rejects.toThrow(/archived/);
      await expect(loadShareData(editorSession as unknown as Db, workspace, { kind: "solution", id: sol }, TOGGLES[0]!)).rejects.toThrow(/archived/);
    } finally {
      await setArchived(false);
      await admin.query("delete from issues where id = $1", [iss]);
    }
  });

  it("a password sign-up with a listed address is not let in: restricted links need a Google identity", async () => {
    const snapshot = await build("overview", TOGGLES[1]!);
    const { token, res } = await save("overview", TOGGLES[1]!, snapshot, { allowed_emails: [`pw-${users.stranger.slice(0, 8)}@example.com`] });
    expect(res.error).toBeNull();
    await admin.query("update auth.users set email = $2 where id = $1", [users.stranger, `pw-${users.stranger.slice(0, 8)}@example.com`]);
    expect((await open(strangerSession, token)).data).toEqual({ status: "not_allowed" });
  });

  it("opens are counted, and the editor's list shows the count, never the link", async () => {
    const snapshot = await build("overview", TOGGLES[0]!);
    const { token, res } = await save("overview", TOGGLES[0]!, snapshot, { label: "Counting" });
    expect(res.error).toBeNull();
    await open(anon, token);
    await open(anon, token);
    const row = (await editorSession.from("share_links").select("opens, last_opened_at, label").eq("label", "Counting").single()).data!;
    expect(row.opens).toBe(2);
    expect(row.last_opened_at).not.toBeNull();
  });
});
