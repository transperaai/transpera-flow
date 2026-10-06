import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The share-links migration's place in the apply order is written in three places (the migration's header, the apply file's
// header, docs/production-migrations.md). They must say the same thing, and it must be true of the files on disk.
const root = join(__dirname, "..");
const VERSION = "20261218000000";
const migration = readFileSync(join(root, `supabase/migrations/${VERSION}_share_links.sql`), "utf8");
const apply = readFileSync(join(root, `scripts/apply/${VERSION}_share_links.sql`), "utf8");
const ledger = readFileSync(join(root, "../../docs/production-migrations.md"), "utf8");
const versions = readdirSync(join(root, "supabase/migrations")).map((f) => f.slice(0, 14)).sort();

describe("share links: row 63 of the production ledger", () => {
  it("nothing on disk is at or past it but itself, and nothing on disk is past the 20261216000000 it is applied after", () => {
    // Rows 61 (B21) and 62 (C1, 20261216000000) are other tickets', not on this branch: this one is applied after them.
    expect(versions.filter((v) => v >= VERSION)).toEqual([VERSION]);
    expect(versions.filter((v) => v > "20261216000000" && v < VERSION)).toEqual([]);
  });

  it("preflight 0 expects the latest applied migration to be the one before it, and nothing at or past its own", () => {
    for (const text of [migration, apply]) {
      expect(text).toContain(`the latest to be ${"20261216000000"} and nothing >= '${VERSION}'`);
      expect(text).toContain("where version >= '20261212000000'");
      expect(text).not.toContain("the latest to be 20261212000000");
    }
  });

  it("the headers name the row and the migration before it", () => {
    expect(migration).toContain("after 20261216000000 (C1, row 62");
    expect(apply).toContain("this is row 63");
    expect(apply).toContain("row 62 (20261216000000");
  });

  it("the ledger has row 63 for this version, not applied, and no other row uses 63 or this version", () => {
    expect(ledger).toMatch(new RegExp(`\\| 63 \\| ${VERSION} \\| share_links \\| NOT applied`));
    expect(ledger.match(/^\| 63 \|/gm)).toHaveLength(1);
    // Row 60 is B5's and 61 and 62 belong to others: this one must not reuse them.
    expect(ledger).not.toMatch(new RegExp(`^\\| (60|61|62) \\| ${VERSION}`, "m"));
  });
});
