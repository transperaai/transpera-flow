import { createHash, randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ENGINE_VERSION } from "@transpera-flow/engine";
import { LARKSPUR_PROCESS_ID, LARKSPUR_WORKSPACE_ID, NORTHBEAM_WORKSPACE_ID, loadShareData, shareSnapshotLeaks, loadShareSecrets, type Db, type ProcessShare, type ShareSecrets, type ShareToggles } from "@transpera-flow/db";
import { rpc } from "@transpera-flow/db/client";
import { errorOf, startTestDb, tokenDbFor, userClaims, type McpTestDb } from "./helpers";

// Play links (issue #33, B4; migration 20261221000000): a signed-out visitor opens a play link,
// sends an idea through `submit_play_proposal`, and can make no other write; what they typed is held from members when it names someone;
// owners and editors read the visitor's email through `play_proposal_contacts`. Every assertion is on what the database answered.
// Runs on a throwaway database (test/helpers.ts).

const ws = LARKSPUR_WORKSPACE_ID;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const newToken = () => randomBytes(32).toString("base64url");
const OPEN: ShareToggles = { people: false, financials: false };
const RESTRICTED: ShareToggles = { people: true, financials: false };

let env: McpTestDb;

describe("play links", () => {
  let admin: pg.Client;
  const users = { editor: "", member: "", visitor: "", stranger: "" };
  const visitorEmail = `play-${randomUUID().slice(0, 8)}@visit.example`;
  let editorSession: Db;
  let memberSession: Db;
  let visitorSession: Db;
  let anon: Db;
  let apiSession: Db;
  let secrets: ShareSecrets;
  let stepId = "";
  let personName = "";
  let foreignStep = "";
  const emails = new Set<string>();

  beforeAll(async () => {
    env = await startTestDb();
    admin = env.t.client;
    const tag = randomUUID().slice(0, 8);
    for (const k of Object.keys(users) as (keyof typeof users)[]) {
      users[k] = randomUUID();
      await admin.query("insert into auth.users (id, email, email_confirmed_at) values ($1, $2, now())", [users[k], k === "visitor" ? visitorEmail : `play-${k}-${tag}@example.com`]);
    }
    // The visitor signs in with Google: a restricted link needs that identity, not just a confirmed address.
    await admin.query("insert into auth.identities (user_id, provider, provider_id, identity_data) values ($1, 'google', $2, $3)", [users.visitor, users.visitor, { sub: users.visitor, email: visitorEmail }]);
    await admin.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, 'owner'), ($1, $3, 'viewer')", [ws, users.editor, users.member]);
    await admin.query("insert into memberships (workspace_id, user_id, role) values ($1, $2, 'owner')", [NORTHBEAM_WORKSPACE_ID, users.editor]);
    editorSession = env.dbAs(userClaims(users.editor));
    memberSession = env.dbAs(userClaims(users.member));
    visitorSession = env.dbAs(userClaims(users.visitor));
    anon = env.dbAs(null);
    // The editor as an API token reaches the database: their claims, with the token's id.
    apiSession = (await tokenDbFor(env, users.editor)).db;
    personName = (await admin.query("select name from people where workspace_id = $1 order by created_at, id limit 1", [ws])).rows[0].name as string;
    // A real step of another workspace, which the link doesn't show.
    foreignStep = (await admin.query("select id from steps where workspace_id = $1 limit 1", [NORTHBEAM_WORKSPACE_ID])).rows[0].id as string;

    secrets = await loadShareSecrets(editorSession, ws);
  }, 120_000);

  afterAll(async () => {
    await env?.close();
  });

  const workspaceRow = () => editorSession.selectFrom("workspaces").select(["id", "name", "slug", "settings"]).where("id", "=", ws).executeTakeFirstOrThrow();

  /** The editor builds a process snapshot (the real loaders and redaction), checks it, and saves it as a play link. */
  async function makeLink(toggles: ShareToggles = OPEN, over: Record<string, unknown> = {}) {
    const snapshot = (await loadShareData(editorSession, await workspaceRow(), { kind: "process", id: LARKSPUR_PROCESS_ID }, toggles)) as ProcessShare;
    expect(shareSnapshotLeaks(snapshot, secrets, toggles)).toEqual([]);
    expect(Array.isArray(snapshot.hiddenLevers)).toBe(true);
    stepId = snapshot.bundle.steps.find((s) => s.kind === "task")!.id;
    const token = newToken();
    const restricted = toggles.people || toggles.financials;
    await editorSession.insertInto("share_links").values({
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
    } as never).execute();
    return { token, snapshot };
  }

  const email = () => {
    const e = `v-${randomUUID().slice(0, 8)}@visitor.example`;
    emails.add(e);
    return e;
  };
  const submit = (client: Db, token: string, over: Record<string, unknown> = {}) => {
    const args = {
      token,
      title: "One more lead a day",
      note: null,
      name: "Marta Okoye",
      email: email(),
      issue: null,
      levers: [{ path: "demand.leads_per_week", op: "set", value: 9 }],
      ...over,
    };
    return rpc(client, "submit_play_proposal", args as never) as Promise<Record<string, unknown>>;
  };
  const proposals = (client: Db) =>
    client.selectFrom("suggestion_proposals").select(["id", "title", "detail", "proposer_name", "created_via", "created_by", "status", "issue_id", "share_link_id", "payload"]).where("workspace_id", "=", ws).where("created_via", "=", "play_link").execute();

  it("an editor makes a play link; anon opens it (mode 'play') and sends an idea made of the levers the page shows; it is a pending visitor's idea", async () => {
    const { token } = await makeLink();
    const opened = await rpc(anon, "open_share_link", { token });
    expect(opened).toMatchObject({ status: "ok", kind: "process", mode: "play" });
    expect((opened as { snapshot: { hiddenLevers: unknown } }).snapshot.hiddenLevers).toBeInstanceOf(Array);

    const levers = [
      { path: "demand.leads_per_week", op: "set", value: 9 },
      { path: `steps.${stepId}.work_hours`, op: "multiply", value: 0.8 },
    ];
    const sent = await submit(anon, token, { note: "Try it for a quarter.", levers });
    expect(sent).toEqual({ status: "ok" });

    const rows = await proposals(editorSession);
    const mine = rows.filter((r) => r.title === "One more lead a day");
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ created_via: "play_link", created_by: null, status: "pending", issue_id: null, proposer_name: "Marta Okoye", detail: "Try it for a quarter." });
    expect((mine[0]!.payload as { levers: unknown }).levers).toEqual(levers);
    expect((mine[0]!.payload as { process_id: string }).process_id).toBe(LARKSPUR_PROCESS_ID);
  }, 120_000);

  it("anon can make no other write: it can't insert, update or call anything but the one function", async () => {
    const { token } = await makeLink();
    expect(await submit(anon, token)).toEqual({ status: "ok" });
    const one = (await admin.query("select id from suggestion_proposals where workspace_id = $1 and created_via = 'play_link' limit 1", [ws])).rows[0].id as string;
    // The database refuses each with SQLSTATE 42501 (permission denied, or row-level security).
    const refused = async (run: () => Promise<unknown>, what: string) => {
      const err = await errorOf(run);
      expect(err, what).not.toBeNull();
      expect(err!.code, `${what}: ${err!.message}`).toBe("42501");
    };
    await refused(() => anon.insertInto("suggestion_proposals").values({ workspace_id: ws, kind: "solution_idea", title: "Forged", payload: { steps: [] }, created_via: "play_link" }).execute(), "insert proposal");
    await refused(() => anon.insertInto("share_links").values({ workspace_id: ws, token_hash: sha(newToken()), kind: "overview", snapshot: {} as never, engine_version: "1" }).execute(), "insert share link");
    await refused(() => anon.insertInto("solutions").values({ workspace_id: ws, process_id: LARKSPUR_PROCESS_ID, base_revision_id: randomUUID(), name: "x", steps: {} as never }).execute(), "insert solution");
    await refused(() => anon.insertInto("scenarios").values({ workspace_id: ws, name: "x", patch: JSON.stringify([]) as never }).execute(), "insert scenario");
    await refused(() => anon.updateTable("share_links").set({ revoked_at: new Date().toISOString() }).where("workspace_id", "=", ws).execute(), "update share link");
    await refused(() => anon.updateTable("suggestion_proposals").set({ status: "built" }).where("id", "=", one).execute(), "update proposal");
    await refused(() => rpc(anon, "review_proposals", { ids: [one], decision: "reject" }), "review_proposals");
    await refused(
      () => rpc(anon, "build_proposal", { p_proposal: one, p_workspace: ws, p_process: LARKSPUR_PROCESS_ID, p_base_revision: randomUUID(), p_name: "x", p_steps: {}, p_changed: [], p_levers: [], p_links: [] } as never),
      "build_proposal",
    );
    await refused(() => rpc(anon, "save_solution", { p_workspace: ws, p_process: LARKSPUR_PROCESS_ID, p_base_revision: randomUUID(), p_name: "x", p_steps: {} }), "save_solution");
    await refused(() => rpc(anon, "play_proposal_contacts", { ws }), "play_proposal_contacts");
    // Nothing became a solution, a scenario or a second link, and the one idea was never touched.
    expect((await admin.query("select status from suggestion_proposals where id = $1", [one])).rows[0].status).toBe("pending");
    expect((await admin.query("select count(*)::int as n from solutions where name = 'x' or name = 'Forged'")).rows[0].n).toBe(0);
  }, 120_000);

  it("the editor reads the idea but not the visitor's email column; play_proposal_contacts gives it; a member sees the idea without it and is refused the contacts", async () => {
    const { token } = await makeLink();
    const typed = email();
    expect(await submit(anon, token, { email: typed, title: "Contacts check" })).toEqual({ status: "ok" });
    const id = (await admin.query("select id from suggestion_proposals where title = 'Contacts check'")).rows[0].id as string;
    const denied = await errorOf(() => editorSession.selectFrom("suggestion_proposals").select(["id", "proposer_email"]).where("id", "=", id).execute());
    expect(denied?.code).toBe("42501");
    expect((await errorOf(() => editorSession.selectFrom("suggestion_proposals").select(["id", "visitor_text"]).where("id", "=", id).execute()))?.code).toBe("42501");
    const contacts = await rpc(editorSession, "play_proposal_contacts", { ws });
    expect((contacts as Record<string, { email: string }>)[id]).toEqual({ email: typed });
    // A member reads the idea, and nothing about the visitor's address.
    const read = await memberSession.selectFrom("suggestion_proposals").select(["id", "title", "proposer_name"]).where("id", "=", id).execute();
    expect(read).toEqual([{ id, title: "Contacts check", proposer_name: "Marta Okoye" }]);
    expect((await errorOf(() => rpc(memberSession, "play_proposal_contacts", { ws })))?.code).toBe("42501");
    expect((await errorOf(() => memberSession.selectFrom("suggestion_proposals").select("proposer_email").where("id", "=", id).execute()))?.code).toBe("42501");
    // An API token (the MCP server's request path) is refused both ways.
    expect((await errorOf(() => rpc(apiSession, "play_proposal_contacts", { ws })))?.code).toBe("42501");
  }, 120_000);

  it("a restricted play link: anon is asked to sign in; the allowed visitor sends an idea and the stored address is the verified one", async () => {
    const { token } = await makeLink(RESTRICTED);
    expect(await rpc(anon, "open_share_link", { token })).toEqual({ status: "sign_in" });
    expect(await submit(anon, token)).toEqual({ status: "sign_in" });
    expect(await submit(memberSession, token)).toEqual({ status: "not_allowed" });
    const sent = await submit(visitorSession, token, { title: "From the allowed visitor", email: "typed-instead@example.com" });
    expect(sent).toEqual({ status: "ok" });
    const row = (await admin.query("select proposer_email, created_by from suggestion_proposals where title = 'From the allowed visitor'")).rows[0];
    expect(row).toEqual({ proposer_email: visitorEmail.toLowerCase(), created_by: null });
  }, 120_000);

  it("an API token is refused (42501); a step from another workspace is refused with 22023 and no id in the message", async () => {
    const { token } = await makeLink();
    const viaToken = await errorOf(() => submit(apiSession, token));
    expect(viaToken?.code).toBe("42501");
    const foreign = await errorOf(() => submit(anon, token, { levers: [{ path: `steps.${foreignStep}.work_hours`, op: "multiply", value: 0.8 }] }));
    expect(foreign?.code).toBe("22023");
    expect(foreign?.message).toBe("One of those changes points at something that isn't in this page.");
    expect(JSON.stringify({ message: foreign?.message, detail: (foreign as { detail?: string }).detail, hint: (foreign as { hint?: string }).hint })).not.toContain(foreignStep);
    const own = await errorOf(() => submit(anon, token, { levers: [{ path: `roles.${randomUUID()}.cost_rate`, op: "set", value: 40 }] }));
    expect(own?.code).toBe("22023");
  }, 120_000);

  it("a note naming a team member is sent as usual ('ok'); a member reads no note, the editor's contacts hold it, and visitor_text is closed to the member", async () => {
    const { token } = await makeLink();
    const note = `Ask ${personName} about it`;
    const sent = await submit(anon, token, { title: "Held note", note });
    expect(sent).toEqual({ status: "ok" });
    const id = (await admin.query("select id from suggestion_proposals where title = 'Held note'")).rows[0].id as string;
    const member = await memberSession.selectFrom("suggestion_proposals").select(["id", "title", "detail"]).where("id", "=", id).execute();
    expect(member).toEqual([{ id, title: "Held note", detail: null }]);
    expect(JSON.stringify(member)).not.toContain(personName);
    expect((await errorOf(() => memberSession.selectFrom("suggestion_proposals").select("visitor_text").where("id", "=", id).execute()))?.code).toBe("42501");
    const contacts = (await rpc(editorSession, "play_proposal_contacts", { ws })) as Record<string, { held?: { note?: string } }>;
    expect(contacts[id]!.held).toEqual({ note });
  }, 120_000);

  it("six quick submissions: the sixth is rate_limited", async () => {
    const { token } = await makeLink();
    const answers: unknown[] = [];
    for (let i = 0; i < 6; i++) answers.push(await submit(anon, token, { title: `Quick ${i}` }));
    expect(answers.slice(0, 5)).toEqual(Array(5).fill({ status: "ok" }));
    expect(answers[5]).toEqual({ status: "rate_limited" });
  }, 120_000);

  it("a view link is not a play link: submit answers gone", async () => {
    const snapshot = await loadShareData(editorSession, await workspaceRow(), { kind: "process", id: LARKSPUR_PROCESS_ID }, OPEN);
    const token = newToken();
    await editorSession.insertInto("share_links").values({ workspace_id: ws, token_hash: sha(token), kind: "process", target_id: LARKSPUR_PROCESS_ID, snapshot: snapshot as never, engine_version: ENGINE_VERSION }).execute();
    expect(await rpc(anon, "open_share_link", { token })).toMatchObject({ status: "ok", mode: "view" });
    expect(await submit(anon, token)).toEqual({ status: "gone" });
  }, 120_000);
});
