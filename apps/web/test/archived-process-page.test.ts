import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// An archived process opens read only (issue #182, B19 2/2): its page shows the banner (archived-banner, tested in a browser in
// process-admin-browser.test.ts) and no Edit, the Editor sends everyone back to the page, and History offers no Restore or
// Duplicate. The database refuses every change anyway (packages/db/test/process-archive.test.ts); these keep the app from offering them.

const read = (f: string) => readFileSync(join(__dirname, "..", "src", f), "utf8");

describe("an archived process's screens", () => {
  it("the process page is read only, with the banner and no Edit", () => {
    const page = read("components/workspace-process-page.tsx");
    expect(page).toContain('mode={canEdit && !earlier && !archivedAt ? "live" : "readonly"}');
    expect(page).toContain("editHref={canEdit && !archivedAt ?");
    expect(page).toContain("notice={archivedAt ? <ArchivedBanner");
    expect(page).toContain("restore={canEdit ? restoreProcess.bind(null, live.process.id) : undefined}");
  });

  it("the Editor goes back to the page, and History offers no Restore or Duplicate", () => {
    expect(read("components/editor/workspace-editor-page.tsx")).toContain("if (!canEdit || live.process.archived_at) redirect(base);");
    expect(read("app/w/[slug]/p/[processId]/history/page.tsx")).toContain("actions={canEdit && !history.archived ?");
  });
});
