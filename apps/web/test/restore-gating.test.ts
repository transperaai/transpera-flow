import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Who is offered the restore (issue #39, B10 2b), read from the source in the style of export-gating.test.ts: the card on the
// empty Overview shows only to someone who can edit, in a workspace that is empty; the page refuses the rest in words.

const read = (f: string) => readFileSync(join(__dirname, "..", "src", f), "utf8");

describe("the restore card and page", () => {
  it("shows the card only to someone who can edit, in an empty workspace", () => {
    const overview = read("components/overview/workspace-overview.tsx");
    expect(overview).toContain("const canRestore = (await canEditWorkspace(head.id)) && (await workspaceIsEmpty(await createClient(), head.id));");
    expect(overview).toContain("{canRestore && (");
    expect(overview).toContain("Restore a backup");
    expect(overview).toContain("Fill this new workspace from a JSON backup another workspace exported.");
    expect(overview).toContain("Every process comes back as a draft of its latest published version. Publish each to see its numbers. Older versions, history and solutions stay in the file.");
    expect(overview).toContain("Restore northbeam-workspace-2026-10-05.json into a new workspace made for Northbeam.");
  });

  it("refuses the demo, a member or viewer, and a workspace that isn't empty, in the page's own words", () => {
    const page = read("app/w/[slug]/restore/page.tsx");
    expect(page).toContain("Restoring needs a connected workspace; the demo has none.");
    expect(page).toContain("if (!(await canEditWorkspace(head.id))) return refused(ROLE_MESSAGE);");
    expect(page).toContain("workspaceIsEmpty");
    expect(page.indexOf("canEditWorkspace(head.id)")).toBeLessThan(page.indexOf("workspaceIsEmpty("));
    const errors = read("lib/restore/errors.ts");
    expect(errors).toContain("Only owners, editors and agency admins can restore a backup.");
    expect(errors).toContain("Backups restore only into an empty workspace. Ask an agency admin to create a new workspace, then restore it there.");
  });

  it("says 'backup' and 'restore' on the page and the card, never 'bundle' or 'import'", () => {
    for (const f of ["components/restore/restore-backup.tsx", "components/restore/restore-notice.tsx", "app/w/[slug]/restore/page.tsx"]) {
      const text = read(f)
        .split("\n")
        .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*") && !l.trim().startsWith("/*"))
        .join("\n");
      const shown = [...text.matchAll(/>\s*([^<>{}\n]+?)\s*</g)].map((m) => m[1]).concat([...text.matchAll(/"([A-Z][^"]{12,})"/g)].map((m) => m[1]));
      for (const s of shown) expect(s, f).not.toMatch(/\b(bundle|import)\b/i);
    }
  });
});
