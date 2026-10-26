import { createHash, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ENGINE_VERSION } from "@transpera-flow/engine";
import { LARKSPUR_PROCESS_ID, LARKSPUR_WORKSPACE_ID, loadShareData, type ProcessShare } from "@transpera-flow/db";
import { addMember, signInAs, signOut, type TestUser } from "./action-harness";
import { createTestDb, type TestDb } from "../../../packages/db/test/harness";
import { claimsFor } from "@/lib/db/claims";

// The API token actions and a play link's Send, against a throwaway database: tokens are the signed-in user's own (RLS), and a
// visitor's idea reaches the workspace only through submit_play_proposal, as `anon` on an open link.

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ refresh: () => {} }));
vi.mock("@/lib/auth/session", async () => (await import("./action-harness")).sessionMock);

const { createToken, revokeToken } = await import("@/app/settings/tokens/actions");
const { submitPlayIdea } = await import("@/app/s/[token]/actions");

const ws = LARKSPUR_WORKSPACE_ID;
let tdb: TestDb;
let editor: TestUser;
let other: TestUser;

const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};
const tokenRow = async (label: string) => (await tdb.client.query("select id, user_id, token_hash, revoked_at from api_tokens where label = $1", [label])).rows[0];

beforeAll(async () => {
  tdb = await createTestDb();
  editor = await addMember(tdb, ws, "editor");
  other = await addMember(tdb, ws, "editor");
}, 120_000);
afterAll(async () => {
  await tdb?.close();
});

describe("API tokens", () => {
  it("creates a token for the signed-in user, storing only its hash", async () => {
    signInAs({ tdb }, editor);
    const out = await createToken(null, form({ label: "Claude Desktop" }));
    expect(out).toMatchObject({ label: "Claude Desktop", token: expect.any(String) });
    const row = await tokenRow("Claude Desktop");
    expect(row).toMatchObject({ user_id: editor.id, revoked_at: null });
    expect(row.token_hash).not.toBe((out as { token: string }).token);
  });

  it("refuses a missing or long name, and says why the database refused", async () => {
    signInAs({ tdb }, editor);
    expect(await createToken(null, form({ label: " " }))).toEqual({ error: "Give the token a name of up to 100 characters." });
    signOut({ tdb });
    expect(await createToken(null, form({ label: "Signed out" }))).toEqual({ error: expect.stringMatching(/.+/) });
    expect(await tokenRow("Signed out")).toBeUndefined();
  });

  it("revokes only the user's own token", async () => {
    signInAs({ tdb }, editor);
    await createToken(null, form({ label: "Mine" }));
    const { id } = await tokenRow("Mine");
    signInAs({ tdb }, other);
    await revokeToken(form({ id }));
    expect((await tokenRow("Mine")).revoked_at).toBeNull();
    signInAs({ tdb }, editor);
    await revokeToken(form({ id }));
    expect((await tokenRow("Mine")).revoked_at).not.toBeNull();
  });
});

describe("a play link's Send", () => {
  const idea = { title: "One more lead a day", note: "", name: "Marta Okoye", email: "marta@visitor.example", issue: null, levers: [{ path: "demand.leads_per_week", op: "set", value: 9 }] };

  it("stores the idea, levers and all, through submit_play_proposal as a signed-out visitor", async () => {
    const editorDb = tdb.dbAs(claimsFor(editor));
    const workspace = await editorDb.selectFrom("workspaces").select(["id", "name", "slug", "settings"]).where("id", "=", ws).executeTakeFirstOrThrow();
    const snapshot = (await loadShareData(editorDb, workspace, { kind: "process", id: LARKSPUR_PROCESS_ID }, { people: false, financials: false })) as ProcessShare;
    const token = randomBytes(32).toString("base64url");
    await editorDb
      .insertInto("share_links")
      .values({
        workspace_id: ws,
        token_hash: createHash("sha256").update(token).digest("hex"),
        kind: "process",
        target_id: LARKSPUR_PROCESS_ID,
        mode: "play",
        show_people: false,
        show_financials: false,
        allowed_emails: [],
        snapshot: snapshot as never,
        engine_version: ENGINE_VERSION,
      })
      .execute();

    signOut({ tdb });
    expect(await submitPlayIdea(token, idea)).toEqual({ status: "ok" });
    const stored = (await tdb.client.query("select title, proposer_email, payload -> 'levers' as levers from suggestion_proposals where workspace_id = $1 and created_via = 'play_link'", [ws])).rows;
    expect(stored).toEqual([{ title: idea.title, proposer_email: idea.email, levers: idea.levers }]);
  });

  it("answers gone for a link that doesn't exist", async () => {
    signOut({ tdb });
    expect(await submitPlayIdea(randomBytes(32).toString("base64url"), idea)).toEqual({ status: "gone" });
  });
});
