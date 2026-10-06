import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SHARE_NON_TEXT_KEYS } from "../src/share";

describe("share links: the leak check's helpers and lists", () => {
  const migrationText = readFileSync(join(__dirname, "..", "supabase/migrations/20261220000000_share_links.sql"), "utf8");

  it("preflight 1, the post-apply checks and the rollback cover every helper the migration creates", () => {
    const created = [...migrationText.matchAll(/^create function (?:private|public)\.(\w+)\(/gm)].map((m) => m[1]!);
    expect(created).toEqual(expect.arrayContaining(["share_norm", "share_unpct", "share_strings", "share_name_tokens"]));
    const header = migrationText.slice(0, migrationText.indexOf("-- Production data:"));
    for (const fn of ["share_norm(text)", "share_unpct(text)", "share_strings(jsonb)", "share_name_tokens(uuid, text)"]) {
      expect(header, fn).toContain(`to_regprocedure('private.${fn}')`);
      expect(header, fn).toContain(`'private.${fn}'`);
      expect(header, fn).toContain(`drop function if exists private.${fn};`);
    }
    expect(header).toContain("Expect null x9");
  });

  it("the post-apply smoke test names a person under a free-text key (title), not under a key that is no text", () => {
    const smoke = /the same with "(\w+)":"<a real person's full name>"/.exec(migrationText);
    expect(smoke?.[1]).toBe("title");
    expect(SHARE_NON_TEXT_KEYS).not.toContain(smoke![1]!);
  });

  it("the database's list of keys that are no text is the app's", () => {
    const m = /non_text_keys constant text\[\] := array\[([^\]]*)\]/.exec(migrationText)!;
    const inDb = [...m[1]!.matchAll(/'([^']+)'/g)].map((x) => x[1]!);
    expect([...inDb].sort()).toEqual([...SHARE_NON_TEXT_KEYS].sort());
  });
});

// The share-links migration's place in the apply order is written in three places (the migration's header, the apply file's
// header, docs/production-migrations.md). They must say the same thing, and it must be true of the files on disk.
const root = join(__dirname, "..");
const VERSION = "20261220000000";
const migration = readFileSync(join(root, `supabase/migrations/${VERSION}_share_links.sql`), "utf8");
const apply = readFileSync(join(root, `scripts/apply/${VERSION}_share_links.sql`), "utf8");
const ledger = readFileSync(join(root, "../../docs/production-migrations.md"), "utf8");
const versions = readdirSync(join(root, "supabase/migrations")).map((f) => f.slice(0, 14)).sort();

describe("share links: row 64 of the production ledger", () => {
  it("it is on disk once, and nothing on disk is between it and the 20261219000000 it is applied after", () => {
    // Rows 61 (B21), 62 (C1) and 63 (B7, 20261219000000) are other tickets': this one is applied after them. Row 64 is applied, so
    // later migrations (row 66, 20261222000000) may follow it.
    expect(versions.filter((v) => v === VERSION)).toEqual([VERSION]);
    expect(versions.filter((v) => v > "20261219000000" && v < VERSION)).toEqual([]);
  });

  it("preflight 0 expects the latest applied migration to be the one before it, and nothing at or past its own", () => {
    for (const text of [migration, apply]) {
      expect(text).toContain(`the latest to be ${"20261219000000"} and nothing >= '${VERSION}'`);
      expect(text).toContain("where version >= '20261215000000'");
      expect(text).not.toContain("the latest to be 20261212000000");
    }
  });

  it("the headers name the row and the migration before it", () => {
    expect(migration).toContain("after 20261219000000 (B7, row 63");
    expect(apply).toContain("this is row 64");
    expect(apply).toContain("row 63 (20261219000000");
  });

  it("the ledger has row 64 for this version, and no other row uses 64 or this version", () => {
    // Applied or not: the row's status column changes when it is applied to production.
    expect(ledger).toMatch(new RegExp(`\\| 64 \\| ${VERSION} \\| share_links \\| `));
    expect(ledger.match(/^\| 64 \|/gm)).toHaveLength(1);
    // Row 60 is B5's and 61 to 63 belong to others: this one must not reuse them.
    expect(ledger).not.toMatch(new RegExp(`^\\| (60|61|62|63) \\| ${VERSION}`, "m"));
  });
});
