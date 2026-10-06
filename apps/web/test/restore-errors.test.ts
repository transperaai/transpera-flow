import { describe, expect, it } from "vitest";
import { FAILED_MESSAGE, NOT_EMPTY_MESSAGE, ROLE_MESSAGE, TOO_BIG_MESSAGE, restoreFailure, sectionInWords } from "@/lib/restore/errors";
import { noticeCookieValue, parseRestoreNotice, restoredMessage } from "@/lib/restore/notice";

// The restore route's error mapper and the notice it leaves (issue #39, B10 2b).

describe("restoreFailure", () => {
  it("maps 42501 to the role message", () => {
    expect(restoreFailure({ code: "42501", message: "Backups are restored in the app." })).toEqual({ status: 403, message: ROLE_MESSAGE });
  });

  it("maps the not_empty hint to the not-empty message, whatever the code", () => {
    expect(restoreFailure({ code: "23514", hint: "not_empty", message: "This workspace isn't empty: it already has roles." })).toEqual({ status: 409, message: NOT_EMPTY_MESSAGE });
  });

  it("maps a section failure to the section in words and the database's sentence, when it reads as one", () => {
    const f = restoreFailure({ code: "55000", hint: "section:archive", message: "import_workspace_bundle: archive could not be restored: Sales is archived. Restore it first" });
    expect(f).toEqual({ status: 422, message: "Couldn't restore the archived processes: Sales is archived. Restore it first. Nothing was restored." });
  });

  it("never echoes SQL: a statement, relation, column or constraint becomes a plain sentence", () => {
    for (const message of [
      'import_workspace_bundle: roles could not be restored: invalid input syntax for type timestamp with time zone: "{}"',
      'import_workspace_bundle: blocks could not be restored: new row for relation "blocks" violates check constraint "blocks_type_check"',
      "import_workspace_bundle: clients could not be restored: insert into public.clients values ($1)",
      "import_workspace_bundle: clients could not be restored: ",
    ]) {
      const f = restoreFailure({ code: "23514", hint: "section:blocks", message });
      expect(f.message).toMatch(/^Couldn't restore the (blocks|roles|clients): a row didn't fit this workspace's rules\. Nothing was restored\.$/);
    }
  });

  it("maps a statement timeout (57014) to the too-big message", () => {
    expect(restoreFailure({ code: "57014", message: "canceling statement due to statement timeout" })).toEqual({ status: 504, message: TOO_BIG_MESSAGE });
  });

  it("answers anything else with the plain failure, and says nothing about it", () => {
    expect(restoreFailure({ code: "XX000", message: "select * from secret_table" })).toEqual({ status: 500, message: FAILED_MESSAGE });
    expect(restoreFailure({})).toEqual({ status: 500, message: FAILED_MESSAGE });
  });

  it("has words for every section the function writes, and a fallback", () => {
    for (const s of ["settings", "roles", "processes", "steps", "issues", "source_links", "proposals", "archive", "log"]) expect(sectionInWords(s)).not.toBe("part of the backup");
    expect(sectionInWords("nonsense")).toBe("part of the backup");
  });
});

describe("the notice a restore leaves", () => {
  it("says how many processes came back as drafts, and when settings wait for an owner", () => {
    expect(restoredMessage(5, "applied")).toBe("Restored 5 processes as drafts. Publish each one to see its numbers.");
    expect(restoredMessage(1, "none")).toBe("Restored 1 process as drafts. Publish each one to see its numbers.");
    expect(restoredMessage(2, "suggested")).toMatch(/waiting for an owner to accept/);
  });

  it("round-trips through the cookie value, and ignores anything else", () => {
    expect(parseRestoreNotice(noticeCookieValue("Hello; world"))).toBe("Hello; world");
    expect(parseRestoreNotice("nonsense")).toBeNull();
    expect(parseRestoreNotice(encodeURIComponent("[1]"))).toBeNull();
    expect(parseRestoreNotice(encodeURIComponent('{"message": 4}'))).toBeNull();
  });
});
