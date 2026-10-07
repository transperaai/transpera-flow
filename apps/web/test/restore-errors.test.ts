import { describe, expect, it } from "vitest";
import { BUSY_MESSAGE, FAILED_MESSAGE, GATEWAY_TOO_BIG_MESSAGE, LOST_CONNECTION_MESSAGE, NOT_EMPTY_MESSAGE, ROLE_MESSAGE, SLOW_START_MESSAGE, TOO_BIG_MESSAGE, restoreFailure, sectionInWords } from "@/lib/restore/errors";
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

  // #228.
  it("names the per-person times when their section fails", () => {
    expect(sectionInWords("person_capacity_factors")).toBe("the per-person times");
    const f = restoreFailure({ code: "23514", hint: "section:person_capacity_factors", message: "import_workspace_bundle: person_capacity_factors could not be restored: save_capacity_factor: a factor is from 0.5 to 2" });
    expect(f.status).toBe(422);
    expect(f.message).toMatch(/^Couldn't restore the per-person times: .* Nothing was restored\.$/);
    // The database's own words about a column or constraint are never echoed.
    const sql = restoreFailure({ code: "23514", hint: "section:person_capacity_factors", message: 'import_workspace_bundle: person_capacity_factors could not be restored: new row for relation "person_capacity_factors" violates check constraint "person_capacity_factors_factor_check"' });
    expect(sql.message).toBe("Couldn't restore the per-person times: a row didn't fit this workspace's rules. Nothing was restored.");
  });

  // B21 (#203).
  it("maps the busy hint (a restore already running) to 409 and its message, before any other hint", () => {
    expect(restoreFailure({ code: "55P03", hint: "busy", message: "A restore into this workspace is already running." })).toEqual({ status: 409, message: BUSY_MESSAGE });
    expect(BUSY_MESSAGE).toBe("A restore into this workspace is already running. Wait a minute, then reload this page.");
    // Whatever else the error says.
    expect(restoreFailure({ code: "57014", hint: "busy", message: "canceling statement due to statement timeout" }, 413)).toEqual({ status: 409, message: BUSY_MESSAGE });
  });

  it("maps an HTTP 413 from the database call (the gateway refused the size) to the 'send to the database' message", () => {
    expect(restoreFailure({ code: null, message: "Request Entity Too Large" }, 413)).toEqual({ status: 413, message: "This backup is too big to send to the database in one go. Nothing was restored." });
    expect(restoreFailure({}, 413).message).toBe(GATEWAY_TOO_BIG_MESSAGE);
    // Any other status leaves the mapping as it was.
    expect(restoreFailure({ code: "57014", message: "canceling statement due to statement timeout" }, 500)).toEqual({ status: 504, message: TOO_BIG_MESSAGE });
    expect(restoreFailure({ code: "XX000", message: "x" }, null)).toEqual({ status: 500, message: FAILED_MESSAGE });
  });

  it("keeps a section failure's words when PostgREST answered 413 for it (class 54 errors), and only a code-less 413 is the gateway", () => {
    expect(restoreFailure({ code: "54000", hint: "section:roles", message: "import_workspace_bundle: roles could not be restored: x" }, 413)).toEqual({
      status: 422,
      message: "Couldn't restore the roles: x. Nothing was restored.",
    });
    expect(restoreFailure({ code: "", message: "Request Entity Too Large" }, 413).message).toBe(GATEWAY_TOO_BIG_MESSAGE);
  });

  it("says the connection was lost, not that nothing was restored, when no answer came back from the database (status 0, no code)", () => {
    expect(restoreFailure({ message: "TypeError: fetch failed", code: "" }, 0)).toEqual({ status: 502, message: LOST_CONNECTION_MESSAGE });
    expect(restoreFailure({ message: "fetch failed" }, 0).message).not.toContain("Nothing was restored");
    // An answer with a code from the database keeps its own mapping, whatever the status.
    expect(restoreFailure({ code: "XX000", message: "x" }, 0)).toEqual({ status: 500, message: FAILED_MESSAGE });
  });

  it("has the words for a restore the route didn't start", () => {
    expect(SLOW_START_MESSAGE).toBe("The server took too long to read the backup, so it didn't start the restore. Nothing was restored. Try again.");
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
