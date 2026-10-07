import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ENGINE_VERSION } from "@transpera-flow/engine";
import { LARKSPUR_PROCESS_ID, LARKSPUR_WORKSPACE_ID, NORTHBEAM_WORKSPACE_ID, loadShareData, shareSnapshotLeaks, loadShareSecrets, type Db, type ProcessShare, type ShareSecrets, type ShareToggles } from "@transpera-flow/db";
import { generateApiToken } from "../src";
import { signJwt } from "./helpers";

// Play links over PostgREST (issue #33, B4; migration 20261221000000): a visitor with nothing but the public key opens a play link,
// sends an idea through `submit_play_proposal`, and can make no other write; what they typed is held from members when it names someone;
// owners and editors read the visitor's email through `play_proposal_contacts`. Every assertion is on what PostgREST answered.
// Skipped unless POSTGREST_URL is set (see postgrest-db.ts).

const POSTGREST_URL = process.env.POSTGREST_URL;
const JWT_SECRET = process.env.POSTGREST_JWT_SECRET ?? "";
const ADMIN_URL = process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/postgres";
const DATABASE_NAME = process.env.POSTGREST_DATABASE ?? "transpera_flow_postgrest";

const ws = LARKSPUR_WORKSPACE_ID;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const newToken = () => randomBytes(32).toString("base64url");
const OPEN: ShareToggles = { people: false, financials: false };
const RESTRICTED: ShareToggles = { people: true, financials: false };

describe.skipIf(!POSTGREST_URL)("play links over PostgREST", () => {
  let admin: pg.Client;
  const users = { editor: "", member: "", visitor: "", stranger: "" };
  const visitorEmail = `play-${randomUUID().slice(0, 8)}@visit.example`;
  let apiToken = "";
  let editorSession: SupabaseClient;
  let memberSession: SupabaseClient;
  let visitorSession: SupabaseClient;
  let anon: SupabaseClient;
  let apiSession: SupabaseClient;
  let secrets: ShareSecrets;
  let stepId = "";
  let personName = "";
  let foreignStep = "";
  const emails = new Set<string>();

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
      await admin.query("insert into auth.users (id, email, email_confirmed_at) values ($1, $2, now())", [users[k], k === "visitor" ? visitorEmail : `play-${k}-${tag}@example.com`]);
    }
    // The visitor signs in with Google: a restricted link needs that identity, not just a confirmed address.
    await admin.query("insert into auth.identities (user_id, provider, provider_id, identity_data) values ($1, 'google', $2, $3)", [users.visitor, users.visitor, { sub: users.visitor, email: visitorEmail }]);
    await admin.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, 'editor'), ($1, $3, 'member')", [ws, users.editor, users.member]);
    await admin.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, 'editor')", [NORTHBEAM_WORKSPACE_ID, users.editor]);
    const { token, hash } = generateApiToken();
    await admin.query("insert into api_tokens (user_id, token_hash, label) values ($1, $2, 'play')", [users.editor, hash]);
    apiToken = token;
    editorSession = session(jwt(users.editor));
    memberSession = session(jwt(users.member));
    visitorSession = session(jwt(users.visitor));
    const anonJwt = signJwt({ role: "anon", iss: "test" }, JWT_SECRET);
    anon = session(anonJwt);
    apiSession = session(anonJwt, { "x-api-token": apiToken });
    personName = (await admin.query("select name from people where workspace_id = $1 order by created_at, id limit 1", [ws])).rows[0].name as string;
    // A real step of another workspace, which the link doesn't show.
    foreignStep = (await admin.query("select id from steps where workspace_id = $1 limit 1", [NORTHBEAM_WORKSPACE_ID])).rows[0].id as string;

    const deadline = Date.now() + 60_000;
    while ((await editorSession.from("workspaces").select("id").eq("id", ws)).data?.length !== 1) {
      if (Date.now() > deadline) throw new Error("PostgREST never became ready");
      await new Promise((r) => setTimeout(r, 1000));
    }
    secrets = await loadShareSecrets(editorSession as unknown as Db, ws);
  }, 120_000);

  afterAll(async () => {
    if (!admin) return;
    // Only what this file made: the other PostgREST files share the database and run at the same time, and share-links makes
    // links in the same workspace. (Its teardown once deleted every Larkspur link, so a link made here answered `gone`.)
    await admin.query("delete from suggestion_proposals where share_link_id in (select id from share_links where created_by = any($1))", [Object.values(users)]);
    await admin.query("delete from share_links where created_by = any($1)", [Object.values(users)]);
    await admin.query("delete from memberships where user_id = any($1)", [[users.editor, users.member]]);
    await admin.query("delete from api_tokens where user_id = $1", [users.editor]);
    await admin.query("delete from auth.users where id = any($1)", [Object.values(users)]);
    await admin.end();
  });

  const workspaceRow = async () => (await editorSession.from("workspaces").select("id, name, slug, settings").eq("id", ws).single()).data!;

  /** The editor builds a process snapshot (the real loaders and redaction), checks it, and saves it as a play link through PostgREST. */
  async function makeLink(toggles: ShareToggles = OPEN, over: Record<string, unknown> = {}) {
    const snapshot = (await loadShareData(editorSession as unknown as Db, await workspaceRow(), { kind: "process", id: LARKSPUR_PROCESS_ID }, toggles)) as ProcessShare;
    expect(shareSnapshotLeaks(snapshot, secrets, toggles)).toEqual([]);
    expect(Array.isArray(snapshot.hiddenLevers)).toBe(true);
    stepId = snapshot.bundle.steps.find((s) => s.kind === "task")!.id;
    const token = newToken();
    const restricted = toggles.people || toggles.financials;
    const res = await editorSession.from("share_links").insert({
      workspace_id: ws,
      token_hash: sha(token),
      kind: "process",
      target_id: LARKSPUR_PROCESS_ID,
      mode: "play",
      show_people: toggles.people,
      show_financials: toggles.financials,
      allowed_emails: restricted ? [visitorEmail] : [],
      expires_at: restricted ? new Date(Date.now() + 7 * 86400_000).toISOString() : null,
      snapshot: snapshot as never,
      engine_version: ENGINE_VERSION,
      ...over,
    });
    expect(res.error, JSON.stringify(res.error)).toBeNull();
    return { token, snapshot };
  }

  const email = () => {
    const e = `v-${randomUUID().slice(0, 8)}@visitor.example`;
    emails.add(e);
    return e;
  };
  const submit = (client: SupabaseClient, token: string, over: Record<string, unknown> = {}) =>
    client.rpc("submit_play_proposal", {
      token,
      title: "One more lead a day",
      note: null,
      name: "Marta Okoye",
      email: email(),
      issue: null,
      levers: [{ path: "demand.leads_per_week", op: "set", value: 9 }],
      ...over,
    });
  const proposals = async (client: SupabaseClient) => client.from("suggestion_proposals").select("id, title, detail, proposer_name, created_via, created_by, status, issue_id, share_link_id, payload").eq("workspace_id", ws).eq("created_via", "play_link");

  it("an editor makes a play link; anon opens it (mode 'play') and sends an idea made of the levers the page shows; it is a pending visitor's idea", async () => {
    const { token } = await makeLink();
    const opened = await anon.rpc("open_share_link", { token });
    expect(opened.error).toBeNull();
    expect(opened.data).toMatchObject({ status: "ok", kind: "process", mode: "play" });
    expect(((opened.data as { snapshot: { hiddenLevers: unknown } }).snapshot.hiddenLevers)).toBeInstanceOf(Array);

    const levers = [
      { path: "demand.leads_per_week", op: "set", value: 9 },
      { path: `steps.${stepId}.work_hours`, op: "multiply", value: 0.8 },
    ];
    const sent = await submit(anon, token, { note: "Try it for a quarter.", levers });
    expect(sent.error).toBeNull();
    expect(sent.data).toEqual({ status: "ok" });

    const rows = await proposals(editorSession);
    expect(rows.error).toBeNull();
    const mine = rows.data!.filter((r) => r.title === "One more lead a day");
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ created_via: "play_link", created_by: null, status: "pending", issue_id: null, proposer_name: "Marta Okoye", detail: "Try it for a quarter." });
    expect((mine[0]!.payload as { levers: unknown }).levers).toEqual(levers);
    expect((mine[0]!.payload as { process_id: string }).process_id).toBe(LARKSPUR_PROCESS_ID);
  }, 120_000);

  it("anon can make no other write: it can't insert, update or call anything but the one function", async () => {
    const { token } = await makeLink();
    expect((await submit(anon, token)).data).toEqual({ status: "ok" });
    const one = (await admin.query("select id from suggestion_proposals where workspace_id = $1 and created_via = 'play_link' limit 1", [ws])).rows[0].id as string;
    const refused = (r: { error: { code?: string } | null; status: number }, what: string) => {
      expect(r.error, what).not.toBeNull();
      expect([401, 403, 404], `${what}: status ${r.status}`).toContain(r.status);
    };
    refused(await anon.from("suggestion_proposals").insert({ workspace_id: ws, kind: "solution_idea", title: "Forged", payload: { steps: [] }, created_via: "play_link" }), "insert proposal");
    refused(await anon.from("share_links").insert({ workspace_id: ws, token_hash: sha(newToken()), kind: "overview", snapshot: {} as never, engine_version: "1" }), "insert share link");
    refused(await anon.from("solutions").insert({ workspace_id: ws, process_id: LARKSPUR_PROCESS_ID, base_revision_id: randomUUID(), name: "x", steps: {} as never }), "insert solution");
    refused(await anon.from("scenarios").insert({ workspace_id: ws, name: "x", patch: [] as never }), "insert scenario");
    refused(await anon.from("share_links").update({ revoked_at: new Date().toISOString() }).eq("workspace_id", ws), "update share link");
    refused(await anon.from("suggestion_proposals").update({ status: "built" }).eq("id", one), "update proposal");
    refused(await anon.rpc("review_proposals", { ids: [one], decision: "reject" }), "review_proposals");
    refused(
      await anon.rpc("build_proposal", { p_proposal: one, p_workspace: ws, p_process: LARKSPUR_PROCESS_ID, p_base_revision: randomUUID(), p_name: "x", p_steps: {}, p_changed: [], p_levers: [], p_links: [] }),
      "build_proposal",
    );
    refused(await anon.rpc("save_solution", { p_workspace: ws, p_process: LARKSPUR_PROCESS_ID, p_base_revision: randomUUID(), p_name: "x", p_steps: {} }), "save_solution");
    refused(await anon.rpc("play_proposal_contacts", { ws }), "play_proposal_contacts");
    // Nothing became a solution, a scenario or a second link, and the one idea was never touched.
    expect((await admin.query("select status from suggestion_proposals where id = $1", [one])).rows[0].status).toBe("pending");
    expect((await admin.query("select count(*)::int as n from solutions where name = 'x' or name = 'Forged'")).rows[0].n).toBe(0);
  }, 120_000);

  it("the editor reads the idea but not the visitor's email column; play_proposal_contacts gives it; a member sees the idea without it and is refused the contacts", async () => {
    const { token } = await makeLink();
    const typed = email();
    expect((await submit(anon, token, { email: typed, title: "Contacts check" })).data).toEqual({ status: "ok" });
    const id = (await admin.query("select id from suggestion_proposals where title = 'Contacts check'")).rows[0].id as string;
    const denied = await editorSession.from("suggestion_proposals").select("id, proposer_email").eq("id", id);
    expect(denied.error?.code).toBe("42501");
    expect((await editorSession.from("suggestion_proposals").select("id, visitor_text").eq("id", id)).error?.code).toBe("42501");
    const contacts = await editorSession.rpc("play_proposal_contacts", { ws });
    expect(contacts.error).toBeNull();
    expect((contacts.data as Record<string, { email: string }>)[id]).toEqual({ email: typed });
    // A member reads the idea, and nothing about the visitor's address.
    const read = await memberSession.from("suggestion_proposals").select("id, title, proposer_name").eq("id", id);
    expect(read.error).toBeNull();
    expect(read.data).toEqual([{ id, title: "Contacts check", proposer_name: "Marta Okoye" }]);
    expect((await memberSession.rpc("play_proposal_contacts", { ws })).error?.code).toBe("42501");
    expect((await memberSession.from("suggestion_proposals").select("proposer_email").eq("id", id)).error?.code).toBe("42501");
    // An API token (the MCP server's request path) is refused both ways.
    expect((await apiSession.rpc("play_proposal_contacts", { ws })).error?.code).toBe("42501");
  }, 120_000);

  it("a restricted play link: anon is asked to sign in; the allowed visitor sends an idea and the stored address is the verified one", async () => {
    const { token } = await makeLink(RESTRICTED);
    expect((await anon.rpc("open_share_link", { token })).data).toEqual({ status: "sign_in" });
    expect((await submit(anon, token)).data).toEqual({ status: "sign_in" });
    expect((await submit(memberSession, token)).data).toEqual({ status: "not_allowed" });
    const sent = await submit(visitorSession, token, { title: "From the allowed visitor", email: "typed-instead@example.com" });
    expect(sent.error).toBeNull();
    expect(sent.data).toEqual({ status: "ok" });
    const row = (await admin.query("select proposer_email, created_by from suggestion_proposals where title = 'From the allowed visitor'")).rows[0];
    expect(row).toEqual({ proposer_email: visitorEmail.toLowerCase(), created_by: null });
  }, 120_000);

  it("an API token is refused (42501); a step from another workspace is refused with 22023 and no id in the message", async () => {
    const { token } = await makeLink();
    const viaToken = await submit(apiSession, token);
    expect(viaToken.error?.code).toBe("42501");
    const foreign = await submit(anon, token, { levers: [{ path: `steps.${foreignStep}.work_hours`, op: "multiply", value: 0.8 }] });
    expect(foreign.error?.code).toBe("22023");
    expect(foreign.status).toBe(400);
    expect(foreign.error?.message).toBe("One of those changes points at something that isn't in this page.");
    expect(JSON.stringify(foreign.error)).not.toContain(foreignStep);
    const own = await submit(anon, token, { levers: [{ path: `roles.${randomUUID()}.cost_rate`, op: "set", value: 40 }] });
    expect(own.error?.code).toBe("22023");
  }, 120_000);

  it("a note naming a team member is sent as usual ('ok'); a member reads no note, the editor's contacts hold it, and visitor_text is closed to the member", async () => {
    const { token } = await makeLink();
    const note = `Ask ${personName} about it`;
    const sent = await submit(anon, token, { title: "Held note", note });
    expect(sent.error).toBeNull();
    expect(sent.data).toEqual({ status: "ok" });
    const id = (await admin.query("select id from suggestion_proposals where title = 'Held note'")).rows[0].id as string;
    const member = await memberSession.from("suggestion_proposals").select("id, title, detail").eq("id", id);
    expect(member.data).toEqual([{ id, title: "Held note", detail: null }]);
    expect(JSON.stringify(member.data)).not.toContain(personName);
    expect((await memberSession.from("suggestion_proposals").select("visitor_text").eq("id", id)).error?.code).toBe("42501");
    const contacts = (await editorSession.rpc("play_proposal_contacts", { ws })).data as Record<string, { held?: { note?: string } }>;
    expect(contacts[id]!.held).toEqual({ note });
  }, 120_000);

  it("six quick submissions: the sixth is rate_limited", async () => {
    const { token } = await makeLink();
    const answers: unknown[] = [];
    for (let i = 0; i < 6; i++) answers.push((await submit(anon, token, { title: `Quick ${i}` })).data);
    expect(answers.slice(0, 5)).toEqual(Array(5).fill({ status: "ok" }));
    expect(answers[5]).toEqual({ status: "rate_limited" });
  }, 120_000);

  it("a view link is not a play link: submit answers gone", async () => {
    const snapshot = await loadShareData(editorSession as unknown as Db, await workspaceRow(), { kind: "process", id: LARKSPUR_PROCESS_ID }, OPEN);
    const token = newToken();
    const res = await editorSession.from("share_links").insert({ workspace_id: ws, token_hash: sha(token), kind: "process", target_id: LARKSPUR_PROCESS_ID, snapshot: snapshot as never, engine_version: ENGINE_VERSION });
    expect(res.error).toBeNull();
    expect((await anon.rpc("open_share_link", { token })).data).toMatchObject({ status: "ok", mode: "view" });
    expect((await submit(anon, token)).data).toEqual({ status: "gone" });
  }, 120_000);
});
