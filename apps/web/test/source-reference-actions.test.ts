import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NORTHBEAM_WORKSPACE_ID } from "@transpera-flow/db";
import { createTestDb, type TestDb } from "../../../packages/db/test/harness";
import { addMember, signInAs, signOut, type TestUser } from "./action-harness";

// A source's original is a link (step 4 of the move off Supabase; docs/plans/supabase-exit-brief.md): the title plus `file_url`,
// set when the source is added or edited afterwards, opened in a new tab by the page. Nothing is uploaded or downloaded. The source
// rows are in a real database (RLS applies: a viewer's update changes nothing); the link's shape is checked by the action and
// again by the table.

const WS = NORTHBEAM_WORKSPACE_ID;
const LINK = "https://drive.google.com/file/d/abc123/view";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth/session", async () => (await import("./action-harness")).sessionMock);

const { createSource, deleteSource, saveSourceField } = await import("@/app/w/[slug]/source-actions");

let tdb: TestDb;
let editor: TestUser;
let viewer: TestUser;
let P: string;
let SRC: string;

beforeAll(async () => {
  tdb = await createTestDb();
  editor = await addMember(tdb, WS, "editor");
  viewer = await addMember(tdb, WS, "viewer");
  P = (await tdb.client.query("select id from processes where workspace_id = $1 limit 1", [WS])).rows[0].id;
}, 120_000);

afterAll(async () => {
  await tdb?.close();
});

beforeEach(async () => {
  await tdb.client.query("delete from sources where title like 'Reference %'");
  SRC = (await tdb.client.query("insert into sources (workspace_id, kind, title, body) values ($1, 'notes', 'Reference source', 'before') returning id", [WS])).rows[0].id;
  signInAs({ tdb }, editor);
});

const stored = async (id = SRC) => (await tdb.client.query("select file_url, body from sources where id = $1", [id])).rows[0];

describe("adding a source with a link to the original", () => {
  it("keeps the link on the new source, trimmed, beside its pasted text", async () => {
    const r = await createSource(WS, { kind: "notes", title: "Reference add", body: "Rosa said so.", file_url: `  ${LINK}  ` }, [{ kind: "process", processId: P }]);
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect(r.source.file_url).toBe(LINK);
    expect(await stored(r.source.id)).toEqual({ file_url: LINK, body: "Rosa said so." });
  });

  it("takes a source with no link, and refuses one that isn't an http(s) address", async () => {
    const none = await createSource(WS, { kind: "notes", title: "Reference none", body: null }, [{ kind: "process", processId: P }]);
    expect(none.status === "ok" && none.source.file_url).toBeNull();
    for (const bad of ["drive.google.com/file/1", "ftp://example.com/x", "javascript:alert(1)", `https://example.com/${"a".repeat(2000)}`]) {
      const r = await createSource(WS, { kind: "notes", title: "Reference bad", file_url: bad }, [{ kind: "process", processId: P }]);
      expect(r.status).toBe("error");
    }
    expect((await tdb.client.query("select 1 from sources where title = 'Reference bad'")).rowCount).toBe(0);
  });
});

describe("saving the link afterwards", () => {
  it("sets it, replaces it and clears it, one field at a time", async () => {
    expect(await saveSourceField(SRC, "file_url", null, LINK)).toEqual({ status: "saved", value: LINK });
    expect((await stored()).file_url).toBe(LINK);
    const next = "https://www.notion.so/team/Interview-1";
    expect(await saveSourceField(SRC, "file_url", LINK, next)).toEqual({ status: "saved", value: next });
    expect(await saveSourceField(SRC, "file_url", next, "")).toEqual({ status: "saved", value: null });
    expect(await stored()).toEqual({ file_url: null, body: "before" });
  });

  it("notices a change made by someone else, and refuses a bad link", async () => {
    await tdb.client.query("update sources set file_url = $2 where id = $1", [SRC, LINK]);
    expect(await saveSourceField(SRC, "file_url", null, "https://example.com/mine")).toEqual({ status: "conflict", theirs: LINK });
    expect(await saveSourceField(SRC, "file_url", LINK, "not a link")).toEqual({ status: "error", message: "That value isn't valid." });
    expect((await stored()).file_url).toBe(LINK);
  });

  it("is for editors: a viewer's change is refused and nothing changes", async () => {
    signInAs({ tdb }, viewer);
    expect((await saveSourceField(SRC, "file_url", null, LINK)).status).not.toBe("saved");
    expect((await stored()).file_url).toBeNull();
  });
});

describe("deleting a source", () => {
  it("deletes the source, link and all (an editor); a viewer can't", async () => {
    await tdb.client.query("update sources set file_url = $2 where id = $1", [SRC, LINK]);
    signInAs({ tdb }, viewer);
    expect(await deleteSource(SRC)).toEqual({ status: "error", message: "You don't have permission to change sources here." });
    signInAs({ tdb }, editor);
    expect(await deleteSource(SRC)).toEqual({ status: "ok" });
    expect((await tdb.client.query("select 1 from sources where id = $1", [SRC])).rowCount).toBe(0);
  });

  it("asks for a signed-in person", async () => {
    signOut({ tdb });
    expect((await deleteSource(SRC)).status).toBe("error");
    expect((await tdb.client.query("select 1 from sources where id = $1", [SRC])).rowCount).toBe(1);
  });
});
