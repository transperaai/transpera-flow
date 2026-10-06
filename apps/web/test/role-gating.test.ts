import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Members and viewers look, owners and editors change (issue #30, B1 part 1). The database refuses every write from the others
// (packages/db/test/role-matrix.test.ts); these keep the app from offering what would be refused. Source text, in the style of
// archived-process-page.test.ts: each page in the audit passes `canEdit` (`can_edit_workspace`) into its `mode`, `editHref` or
// action props, so a page that lost its gate fails here rather than showing a button to a viewer.

const read = (f: string) => readFileSync(join(__dirname, "..", "src", f), "utf8");
const MODE = 'mode={canEdit ? "live" : "readonly"}';
const PAGE = (route: string) => `app/w/[slug]/${route}/page.tsx`;

describe("pages that pass canEdit into a read only mode", () => {
  it.each([
    ["Overview", "components/overview/workspace-overview.tsx"],
    ["Issues", PAGE("issues")],
    ["the issue page", PAGE("issues/[number]")],
    ["Solutions", PAGE("solutions")],
    ["the solution page", PAGE("solutions/[id]")],
    ["the Block library", PAGE("blocks")],
    ["Sources", PAGE("sources")],
    ["the Forecast", PAGE("forecast")],
    ["Settings → AI analysis", PAGE("settings/ai")],
    ["Settings → Levers", PAGE("settings/levers")],
    ["Settings → Historical data", PAGE("settings/calibration")],
  ])("%s", (_, file) => {
    const source = read(file);
    expect(source).toContain("canEditWorkspace");
    expect(source).toContain(MODE);
  });

  it("the process page: read only on an earlier version or an archived process, and no Edit link without canEdit", () => {
    const page = read("components/workspace-process-page.tsx");
    expect(page).toContain('mode={canEdit && !earlier && !archivedAt ? "live" : "readonly"}');
    expect(page).toContain("editHref={canEdit && !archivedAt ?");
    expect(page).toContain("create={canEdit ? createProcess.bind(null, live.workspace.id, slug) : undefined}");
  });

  it("the first-principles page: read only, no Run, no New process", () => {
    const page = read("components/workspace-first-principles-page.tsx");
    expect(page).toContain("const editing: FlowEditing = !canEdit");
    expect(page).toContain('mode: canEdit ? "live" : "readonly"');
    expect(page).toContain("canRun: canEdit && !unpublished");
    expect(page).toContain("create={canEdit ? createProcess.bind(null, live.workspace.id, slug) : undefined}");
  });

  it("the Overview offers Edit company map only through a link the gate withholds", () => {
    const page = read("components/overview/workspace-overview.tsx");
    expect(page).toContain("companyMapView(company, found, canEdit)");
    expect(page).toContain("companyEditHref={view.canEdit && company ?");
    expect(read("components/overview/overview.tsx")).toContain("{companyEditHref && (");
  });
});

describe("screens whose controls come in as props that are undefined without canEdit", () => {
  it("Processes: no New process, Upload, rename, re-type, archive or restore", () => {
    const page = read(PAGE("processes"));
    expect(page).toContain("create={canEdit ? createProcess.bind(null, workspace.id, slug) : undefined}");
    expect(page).toContain("upload={canEdit ? {");
    expect(page).toContain("admin={canEdit ? {");
    const view = read("components/processes/processes-page.tsx");
    expect(view).toContain("{upload && <UploadProcessButton");
    expect(view).toContain("{create && <NewProcessButton");
  });

  it("History: Restore and Duplicate only with canEdit, and never on an archived process", () => {
    expect(read(PAGE("p/[processId]/history"))).toContain("actions={canEdit && !history.archived ?");
    expect(read("components/history/history-view.tsx")).toContain("{actions && !v.live && (");
    expect(read("components/history/company-history-view.tsx")).toContain("{actions && !v.live && (");
  });

  it("Solutions: New solution only with canEdit, and Delete solution and New solution on the solution page too", () => {
    expect(read(PAGE("solutions"))).toContain("actions={canEdit ? <NewSolutionButton");
    const page = read("components/solutions/solution-page.tsx");
    expect(page).toContain('const canEdit = mode !== "readonly";');
    expect(page).toMatch(/\{canEdit && \(\s*<span className="flex flex-wrap items-center gap-2">\s*<DeleteSolution/);
  });

  it("the Block library: no New block link without canEdit", () => {
    expect(read(PAGE("blocks"))).toContain("const newHref = canEdit && first ?");
  });

  it("the process page offers New solution and Build solution only to those who can edit", () => {
    expect(read("components/process-page.tsx")).toContain('const canBuild = mode !== "readonly" && viewingVersion === null && !!solutions?.base;');
    expect(read("components/solutions/process-solutions.tsx")).toMatch(/\{canEdit && \(/);
  });

  it("the issue page: Edit, Resolve, Reopen, Build solution and Link a source only with canEdit", () => {
    const page = read("components/issues/issue-page.tsx");
    expect(page).toContain('const canEdit = mode !== "readonly";');
    expect(page).toMatch(/\{canEdit && \(\s*<div[^>]*>\s*<span[^>]*>\s*<Button type="button" variant="outline" onClick=\{\(\) => setEdit\(true\)\}>/);
  });

  it("Suggestions: Accept and Dismiss only with canEdit, and the page says who reviews", () => {
    const page = read(PAGE("suggestions"));
    expect(page.match(/canEdit=\{data\.canEdit\}/g)).toHaveLength(2);
    expect(page).toContain("You can view suggestions; editors and owners review them.");
    expect(read("components/suggestions-review.tsx")).toContain("{canEdit && selectable.length > 0 && (");
    expect(read("components/proposals-review.tsx")).toMatch(/\{canEdit && \(/);
  });
});

describe("the Editor and the Settings", () => {
  it("the Editor sends everyone without canEdit back to the page", () => {
    expect(read("components/editor/workspace-editor-page.tsx")).toContain("if (!canEdit || live.process.archived_at) redirect(base);");
  });

  it("Settings: the details are owner-only (canManage), everything else follows canEdit", () => {
    const page = read(PAGE("settings"));
    expect(page).toContain("canManage={data.canManage}");
    expect(page).toContain('mode={data.canEdit ? "live" : "readonly"}');
    expect(page).toContain("canEdit={data.canEdit}");
    const data = read("lib/data.ts");
    expect(data).toContain("canEdit: canEdit.data === true,");
    expect(data).toContain("canManage: canManage.data === true,");
    for (const file of ["roles", "services", "demand", "market", "people"]) {
      expect(read(`app/w/[slug]/settings/${file}-settings.tsx`), file).toMatch(/canEdit/);
    }
  });

  it("the People page changes nothing: it has no action to call", () => {
    expect(read("components/people-page.tsx")).not.toMatch(/from "@\/app\/w\//);
    expect(read(PAGE("people"))).not.toMatch(/-actions"|\/actions"/);
  });

  it("Access is for owners and agency admins: the page 404s without can_manage_workspace and the link is hidden", () => {
    expect(read("lib/access-data.ts")).toContain("if (!canManage.data) return null;");
    expect(read(PAGE("settings/access"))).toContain("if (!settings) notFound();");
    expect(read("lib/shell/nav.ts")).toContain("access: canManage");
  });
});
