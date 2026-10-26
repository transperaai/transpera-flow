import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NORTHBEAM_WORKSPACE_ID } from "@transpera-flow/db";
import { createTestDb, type TestDb } from "../../../packages/db/test/harness";
import { addMember, signInAs, type TestUser } from "./action-harness";

// The server half of a source's file (issue #182, B19 2/2): `attachSourceFile` takes only a path in the source's own
// workspace folder, reads the upload back from Storage as the signed-in user and checks it by name and content (never by the
// type the browser declared), keeps its text, deletes a refused upload and the file it replaces; `sourceFileLink` is always a
// download; deleting a source deletes its file. The source rows are in a real database (RLS applies, a viewer's update changes
// nothing); Storage is faked here until step 4 drops it: the policies themselves are tested in packages/db/test/source-files.test.ts.

const WS = NORTHBEAM_WORKSPACE_ID;
const U = "b0000000-0000-4000-8000-000000000002";

const fake = vi.hoisted(() => ({
  object: null as null | Blob,
  removed: [] as string[][],
  signed: [] as unknown[][],
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth/session", async () => (await import("./action-harness")).sessionMock);
// Storage only (step 4): the database calls go to the real database.
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    storage: {
      from: () => ({
        download: async () => (fake.object ? { data: fake.object, error: null } : { data: null, error: { message: "not found" } }),
        remove: async (paths: string[]) => {
          fake.removed.push(paths);
          return { data: [], error: null };
        },
        createSignedUrl: async (...args: unknown[]) => {
          fake.signed.push(args);
          return { data: { signedUrl: "https://storage.example/signed" }, error: null };
        },
      }),
    },
  }),
}));

const { attachSourceFile, deleteSource, sourceFileLink } = await import("@/app/w/[slug]/source-actions");

let tdb: TestDb;
let editor: TestUser;
let viewer: TestUser;
let SRC: string;

beforeAll(async () => {
  tdb = await createTestDb();
  editor = await addMember(tdb, WS, "editor");
  viewer = await addMember(tdb, WS, "viewer");
}, 120_000);

afterAll(async () => {
  await tdb?.close();
});

beforeEach(async () => {
  await tdb.client.query("delete from sources where title = 'File source'");
  SRC = (await tdb.client.query("insert into sources (workspace_id, kind, title, body) values ($1, 'notes', 'File source', 'before') returning id", [WS])).rows[0].id;
  fake.object = null;
  fake.removed = [];
  fake.signed = [];
  signInAs({ tdb }, editor);
});

const stored = async () => (await tdb.client.query("select file_path, file_name, file_type, file_size, body from sources where id = $1", [SRC])).rows[0];
/** The browser's upload to Storage, as the database sees it: an object in the bucket owned by the uploader (a source keeps only such a file). */
const upload = (path: string, owner: TestUser) =>
  tdb.client.query("insert into storage.objects (bucket_id, name, owner, owner_id, metadata) values ('sources', $1, $2::uuid, $2, '{\"size\": 12}') on conflict do nothing", [path, owner.id]);
const keepFile = (path: string) =>
  tdb.client.query("update sources set file_path = $2, file_name = 'Q3 notes.txt', file_type = 'txt', file_size = 12 where id = $1", [SRC, path]);

describe("attachSourceFile", () => {
  it("keeps a checked file and its text on the source", async () => {
    fake.object = new Blob(["Maya: twice a week."], { type: "text/html" });
    const path = `${WS}/${SRC}/${U}/Q3 notes.txt`;
    await upload(path, editor);
    expect(await attachSourceFile(SRC, path, "Q3 notes.txt")).toEqual({
      status: "ok",
      file: { path, name: "Q3 notes.txt", type: "txt", size: 19 },
      body: "Maya: twice a week.",
    });
    expect(await stored()).toEqual({ file_path: path, file_name: "Q3 notes.txt", file_type: "txt", file_size: 19, body: "Maya: twice a week." });
    expect(fake.removed).toEqual([]);
  });

  it("takes only a new path in the source's own folder of its workspace, made the app's way", async () => {
    fake.object = new Blob(["hi"]);
    for (const path of [`b1111111-0000-4000-8000-000000000001/${U}/a.txt`, `${WS}/a.txt`, `${WS}/${SRC}/${U}/page.html`, `${WS}/${SRC}/${U}/../x.txt`]) {
      expect(await attachSourceFile(SRC, path, "a.txt"), path).toEqual({ status: "error", message: "That source isn't valid." });
    }
    // Not the file it already keeps.
    await keepFile(`${WS}/${SRC}/${U}/a.txt`);
    expect(await attachSourceFile(SRC, `${WS}/${SRC}/${U}/a.txt`, "a.txt")).toEqual({ status: "error", message: "That source isn't valid." });
    expect((await stored()).file_path).toBe(`${WS}/${SRC}/${U}/a.txt`);
    expect(fake.removed).toEqual([]);
  });

  it("deletes the upload when it can't be read back", async () => {
    const path = `${WS}/${SRC}/${U}/notes.txt`;
    expect(await attachSourceFile(SRC, path, "notes.txt")).toEqual({ status: "error", message: "Couldn't read the uploaded file. Upload it again." });
    expect(fake.removed).toEqual([[path]]);
  });

  it("refuses an upload that isn't what its name says, and deletes it", async () => {
    fake.object = new Blob(["%PDF-1.4 not text"], { type: "text/plain" });
    const path = `${WS}/${SRC}/${U}/notes.txt`;
    expect(await attachSourceFile(SRC, path, "notes.txt")).toEqual({ status: "error", message: "That file isn't really a .txt file. Save it as one and upload it again." });
    expect(fake.removed).toEqual([[path]]);
    expect(await stored()).toMatchObject({ file_path: null, body: "before" });
  });

  it("refuses one over 10 MB, and deletes it", async () => {
    fake.object = new Blob([new Uint8Array(10 * 1024 * 1024 + 1).fill(0x61)]);
    const path = `${WS}/${SRC}/${U}/big.csv`;
    expect(await attachSourceFile(SRC, path, "big.csv")).toEqual({ status: "error", message: "That file is over 10 MB. Split it, or keep it elsewhere and add a link to it." });
    expect(fake.removed).toEqual([[path]]);
  });

  it("deletes the upload when the source can't be changed (a viewer), and the old file once a new one is kept", async () => {
    fake.object = new Blob(["new text"]);
    const path = `${WS}/${SRC}/${U}/v2.md`;
    const mine = `${WS}/${SRC}/${U}/v2e.md`;
    await upload(path, viewer);
    await upload(mine, editor);
    // A viewer's update matches no row.
    signInAs({ tdb }, viewer);
    expect(await attachSourceFile(SRC, path, "v2.md")).toEqual({ status: "error", message: "You don't have permission to change sources here." });
    expect(fake.removed).toEqual([[path]]);
    expect((await stored()).file_path).toBeNull();
    fake.removed = [];
    signInAs({ tdb }, editor);
    await keepFile(`${WS}/${SRC}/${U}/v1.md`);
    expect((await attachSourceFile(SRC, mine, "v2.md")).status).toBe("ok");
    expect(fake.removed).toEqual([[`${WS}/${SRC}/${U}/v1.md`]]);
    expect((await stored()).file_path).toBe(mine);
  });
});

describe("downloading and deleting", () => {
  it("gives a short-lived link that always downloads, under the file's own name", async () => {
    await keepFile(`${WS}/${SRC}/${U}/Q3 notes.txt`);
    expect(await sourceFileLink(SRC)).toEqual({ status: "ok", url: "https://storage.example/signed" });
    expect(fake.signed).toEqual([[`${WS}/${SRC}/${U}/Q3 notes.txt`, 60, { download: "Q3 notes.txt" }]]);
    await tdb.client.query("update sources set file_path = null, file_name = null, file_type = null, file_size = null where id = $1", [SRC]);
    expect(await sourceFileLink(SRC)).toEqual({ status: "error", message: "This source has no file." });
  });

  it("deletes a source's file with it", async () => {
    await keepFile(`${WS}/${SRC}/${U}/Q3 notes.txt`);
    expect(await deleteSource(SRC)).toEqual({ status: "ok" });
    expect(fake.removed).toEqual([[`${WS}/${SRC}/${U}/Q3 notes.txt`]]);
    expect((await tdb.client.query("select 1 from sources where id = $1", [SRC])).rowCount).toBe(0);
  });
});
