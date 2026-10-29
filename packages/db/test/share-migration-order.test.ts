import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SHARE_NON_TEXT_KEYS } from "../src/share";

describe("share links: the leak check's helpers and lists", () => {
  const migrationText = readFileSync(join(__dirname, "..", "migrations/20261220000000_share_links.sql"), "utf8");

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

  it("the database's list of keys that are no text is the app's (B4's migration replaced the function with one more key, hiddenLevers)", () => {
    // The newest definition of `private.share_snapshot_problem` is the one that counts: B4's (20261221000000) copies B3's and adds a
    // key; the money-rule follow-up (20261224500000) copies B4's and keeps its list; the strip follow-up (20270104000000) copies the
    // money rule's and drops the keys of the AI and findings tables (dropped in 20270101000000); the step-purpose migration (20270114000000,
    // sandbox phase 4) copies that and adds one key, `purpose`.
    const read = (f: string) => readFileSync(join(__dirname, "..", "migrations", f), "utf8");
    const lists = [migrationText, read("20261221000000_play_links.sql"), read("20261224500000_share_money_rule.sql"), read("20270104000000_strip_followups.sql"), read("20270114000000_step_purpose.sql"), read("20270116000000_scenario_share_links.sql"), read("20270117000000_sandbox_p5b_fix.sql")].map((text) => {
      const m = /^  non_text_keys constant text\[\] := array\[([^\]]*)\]/m.exec(text)!;
      return [...m[1]!.matchAll(/'([^']+)'/g)].map((x) => x[1]!);
    });
    // The newest (the scenario-link migration's, sandbox phase 5b) is the app's. The step-purpose migration's is the app's without the six keys that
    // migration added (`from`, `lever`, `parent_id`, `scenarioId`, `startDate`, `target`). The strip follow-up's is the app's without `purpose`; the money rule's is that
    // plus the AI and findings keys; B4's is that plus the two keys the money rule made free text (color, plan); B3's is B4's without the one key B4 added.
    const scenarioKeys = ["from", "lever", "parent_id", "scenarioId", "startDate", "target"];
    const app = SHARE_NON_TEXT_KEYS.filter((k) => k !== "purpose" && !scenarioKeys.includes(k));
    const aiAndFindings = ["ai_key", "analysis_id", "decided_at", "decided_by", "input_hash", "key", "market_pending_at", "model", "model_hash", "origin", "proposed_via", "rating", "run_id", "started_at", "updated_by", "user_id"];
    const dropped = ["color", "plan"];
    for (const k of aiAndFindings) expect(SHARE_NON_TEXT_KEYS, k).not.toContain(k);
    // The 5b review fix (20270117000000) copies the scenario-link migration's body and keeps its list.
    expect([...lists[6]!].sort()).toEqual([...SHARE_NON_TEXT_KEYS].sort());
    expect([...lists[5]!].sort()).toEqual([...SHARE_NON_TEXT_KEYS].sort());
    expect([...lists[4]!].sort()).toEqual([...app, "purpose"].sort());
    expect([...lists[3]!].sort()).toEqual([...app].sort());
    expect([...lists[2]!].sort()).toEqual([...app, ...aiAndFindings].sort());
    expect([...lists[1]!].sort()).toEqual([...app, ...aiAndFindings, ...dropped].sort());
    expect([...lists[0]!].sort()).toEqual([...app.filter((k) => k !== "hiddenLevers"), ...aiAndFindings, ...dropped].sort());
  });
});

// The share-links migration's place in the apply order is written in three places (the migration's header, the apply file's
// header, docs/production-migrations.md). They must say the same thing, and it must be true of the files on disk.
const root = join(__dirname, "..");
const VERSION = "20261220000000";
const migration = readFileSync(join(root, `migrations/${VERSION}_share_links.sql`), "utf8");
const apply = readFileSync(join(root, `scripts/apply/${VERSION}_share_links.sql`), "utf8");
const ledger = readFileSync(join(root, "../../docs/production-migrations.md"), "utf8");
const versions = readdirSync(join(root, "migrations")).map((f) => f.slice(0, 14)).sort();

describe("share links: row 64 of the production ledger", () => {
  it("it is on disk once, and nothing on disk is between it and the 20261219000000 it is applied after", () => {
    // Rows 61 (B21), 62 (C1) and 63 (B7, 20261219000000) are other tickets': this one is applied after them. Row 64 is applied, so
    // later migrations (row 65, 20261220500000) may follow it.
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
