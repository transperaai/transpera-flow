import { beforeEach, describe, expect, it, vi } from "vitest";

// The server half of a source's file (issue #182, B19 2/2): `attachSourceFile` takes only a path in the source's own
// workspace folder, reads the upload back from Storage as the signed-in user and checks it by name and content (never by the
// type the browser declared), keeps its text, deletes a refused upload and the file it replaces; `sourceFileLink` is always a
// download; deleting a source deletes its file. Supabase is faked here: the policies themselves are tested in
// packages/db/test/source-files.test.ts.

const WS = "a0000000-0000-4000-8000-000000000001";
const SRC = "c0000000-0000-4000-8000-000000000003";
const U = "b0000000-0000-4000-8000-000000000002";

const fake = vi.hoisted(() => ({
  source: null as null | { id: string; workspace_id: string; file_path: string | null },
  object: null as null | Blob,
  updated: [] as unknown[],
  removed: [] as string[][],
  signed: [] as unknown[][],
  updateRows: 1,
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getClaims: async () => ({ data: { claims: { sub: "u1" } } }) },
    from: () => {
      let mode: "select" | "update" | "delete" = "select";
      let cols = "";
      const chain = {
        select: (c?: string) => {
          if (mode === "select") cols = c ?? "";
          return chain;
        },
        update: (v: unknown) => {
          mode = "update";
          fake.updated.push(v);
          return chain;
        },
        delete: () => {
          mode = "delete";
          return chain;
        },
        eq: () => chain,
        maybeSingle: async () => {
          if (cols.includes("file_name")) {
            const s = fake.source as { file_path: string | null } | null;
            return { data: s?.file_path ? { file_path: s.file_path, file_name: "Q3 notes.txt", file_type: "txt", file_size: 12 } : null, error: null };
          }
          return { data: fake.source, error: null };
        },
        then: (resolve: (v: unknown) => void) =>
          resolve(
            mode === "update"
              ? { data: Array.from({ length: fake.updateRows }, () => ({ id: SRC })), error: null }
              : mode === "delete"
                ? { data: [{ id: SRC, file_path: fake.source?.file_path ?? null }], error: null }
                : { data: [], error: null },
          ),
      };
      return chain;
    },
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

beforeEach(() => {
  fake.source = { id: SRC, workspace_id: WS, file_path: null };
  fake.object = null;
  fake.updated = [];
  fake.removed = [];
  fake.signed = [];
  fake.updateRows = 1;
});

describe("attachSourceFile", () => {
  it("keeps a checked file and its text on the source", async () => {
    fake.object = new Blob(["Maya: twice a week."], { type: "text/html" });
    const path = `${WS}/${SRC}/${U}/Q3 notes.txt`;
    expect(await attachSourceFile(SRC, path, "Q3 notes.txt")).toEqual({
      status: "ok",
      file: { path, name: "Q3 notes.txt", type: "txt", size: 19 },
      body: "Maya: twice a week.",
    });
    expect(fake.updated).toEqual([{ file_path: path, file_name: "Q3 notes.txt", file_type: "txt", file_size: 19, body: "Maya: twice a week." }]);
    expect(fake.removed).toEqual([]);
  });

  it("takes only a new path in the source's own folder of its workspace, made the app's way", async () => {
    fake.object = new Blob(["hi"]);
    for (const path of [`b1111111-0000-4000-8000-000000000001/${U}/a.txt`, `${WS}/a.txt`, `${WS}/${SRC}/${U}/page.html`, `${WS}/${SRC}/${U}/../x.txt`]) {
      expect(await attachSourceFile(SRC, path, "a.txt"), path).toEqual({ status: "error", message: "That source isn't valid." });
    }
    // Not the file it already keeps.
    fake.source = { id: SRC, workspace_id: WS, file_path: `${WS}/${SRC}/${U}/a.txt` };
    expect(await attachSourceFile(SRC, `${WS}/${SRC}/${U}/a.txt`, "a.txt")).toEqual({ status: "error", message: "That source isn't valid." });
    expect(fake.updated).toEqual([]);
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
    expect(fake.updated).toEqual([]);
  });

  it("refuses one over 10 MB, and deletes it", async () => {
    fake.object = new Blob([new Uint8Array(10 * 1024 * 1024 + 1).fill(0x61)]);
    const path = `${WS}/${SRC}/${U}/big.csv`;
    expect(await attachSourceFile(SRC, path, "big.csv")).toEqual({ status: "error", message: "That file is over 10 MB. Split it, or keep it elsewhere and add a link to it." });
    expect(fake.removed).toEqual([[path]]);
  });

  it("deletes the upload when the source can't be changed (a viewer), and the old file once a new one is kept", async () => {
    fake.object = new Blob(["new text"]);
    fake.updateRows = 0;
    const path = `${WS}/${SRC}/${U}/v2.md`;
    expect(await attachSourceFile(SRC, path, "v2.md")).toEqual({ status: "error", message: "You don't have permission to change sources here." });
    expect(fake.removed).toEqual([[path]]);
    fake.removed = [];
    fake.updateRows = 1;
    fake.source = { id: SRC, workspace_id: WS, file_path: `${WS}/${SRC}/${U}/v1.md` };
    expect((await attachSourceFile(SRC, path, "v2.md")).status).toBe("ok");
    expect(fake.removed).toEqual([[`${WS}/${SRC}/${U}/v1.md`]]);
  });
});

describe("downloading and deleting", () => {
  it("gives a short-lived link that always downloads, under the file's own name", async () => {
    fake.source = { id: SRC, workspace_id: WS, file_path: `${WS}/${SRC}/${U}/Q3 notes.txt` };
    expect(await sourceFileLink(SRC)).toEqual({ status: "ok", url: "https://storage.example/signed" });
    expect(fake.signed).toEqual([[`${WS}/${SRC}/${U}/Q3 notes.txt`, 60, { download: "Q3 notes.txt" }]]);
    fake.source = { id: SRC, workspace_id: WS, file_path: null };
    expect(await sourceFileLink(SRC)).toEqual({ status: "error", message: "This source has no file." });
  });

  it("deletes a source's file with it", async () => {
    fake.source = { id: SRC, workspace_id: WS, file_path: `${WS}/${SRC}/${U}/Q3 notes.txt` };
    expect(await deleteSource(SRC)).toEqual({ status: "ok" });
    expect(fake.removed).toEqual([[`${WS}/${SRC}/${U}/Q3 notes.txt`]]);
  });
});
