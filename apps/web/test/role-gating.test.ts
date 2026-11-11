import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Members and viewers look, Agency admins change (issue #30, B1 part 1). The database refuses every write from the others
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
    ["the Sandbox", PAGE("sandbox")],
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

  it("Solutions: New solution only with canEdit, and Open in editor and Delete solution on the solution page too", () => {
    expect(read("components/solutions/solutions-list.tsx")).toContain("actions={canEdit ? <NewSolutionButton");
    expect(read(PAGE("solutions"))).toContain("canEdit={canEdit}");
    const page = read("components/solutions/solution-page.tsx");
    expect(page).toContain('const canEdit = props.mode !== "readonly";');
    // On a phone the block is hidden too (issue #44): the class carries EDIT_ONLY. Open in editor and Delete sit behind canEdit (no Adopt, D55).
    expect(page).toMatch(/canEdit && \(\s*<span className=\{cn\("flex flex-wrap items-center gap-2", EDIT_ONLY\)\} data-edit-entry>\s*<Button asChild variant="outline">\s*<Link href=\{editorHref\}[\s\S]*?<DeleteSolution/);
  });

  it("the Block library: no New block link without canEdit", () => {
    expect(read(PAGE("blocks"))).toContain("const editBase = canEdit && first ?");
  });

  it("the process page offers New solution and Build solution only to those who can edit", () => {
    expect(read("components/process-page.tsx")).toContain('const canBuild = !isReadOnly(mode) && viewingVersion === null && !!solutions?.base;');
    expect(read("components/solutions/process-solutions.tsx")).toMatch(/\{canEdit && \(/);
  });

  it("the issue page: Edit, Resolve, Reopen, Try a new solution and Link a source only with canEdit", () => {
    const page = read("components/issues/issue-page.tsx");
    expect(page).toContain('const canEdit = !isReadOnly(mode);');
    expect(page).toMatch(/canEdit \? \(\s*<span className=\{`flex flex-wrap items-center gap-2 \$\{EDIT_ONLY\}`\} data-edit-entry>\s*(\{props\.share\}\s*)?<Button type="button" variant="outline" onClick=\{\(\) => setEdit\(true\)\}>/);
    // "+ Try a new solution" and "Link an existing solution" are offered to editors, on an issue still open.
    expect(page).toMatch(/canEdit && open \? \(/);
  });
});

describe("the Editor and the Settings", () => {
  it("the Editor sends everyone without canEdit back to the page", () => {
    expect(read("components/editor/workspace-editor-page.tsx")).toContain("if (!canEdit || live.process.archived_at) redirect(`${base}?notice=${live.process.archived_at ? EDIT_NOTICE.archived : EDIT_NOTICE.readOnly}`);");
  });

  it("Settings: the details are owner-only (canManage), everything else follows canEdit", () => {
    const page = read(PAGE("settings"));
    expect(page).toContain("canManage={data.canManage}");
    expect(page).toContain('mode={data.canEdit ? "live" : "readonly"}');
    const data = read("lib/data.ts");
    expect(data).toContain('rpc(db, "can_edit_workspace", { ws }),');
    expect(data).toContain('rpc(db, "can_manage_workspace", { ws }),');
    expect(data).toContain("canEdit: canEdit === true,");
    expect(data).toContain("canManage: canManage === true,");
    for (const file of ["roles", "services", "demand", "people"]) {
      expect(read(`app/w/[slug]/settings/${file}-settings.tsx`), file).toMatch(/canEdit/);
    }
  });

  it("Set up (Tiers & clients, People & roles): everyone reads, the loader says who may change, and the tables show text, not inputs, without it", () => {
    // Both are sections of the one Settings page, which loads the setup for everyone and 404s without it.
    const page = read(PAGE("settings"));
    expect(page).toContain("loadCapacitySetup(");
    expect(page).toContain("if (!setup) notFound();");
    expect(page).toContain("<TiersAndClients setup={setup} data={data} roster={roster} />");
    expect(page).toContain("<PeopleAndRoles setup={setup} data={data} />");
    const loader = read("../../../packages/db/src/capacity-setup.ts");
    expect(loader).toContain('rpc(db, "can_edit_workspace", { ws: workspaceId })');
    expect(loader).toContain('rpc(db, "can_see_people", { ws: workspaceId })');
    // Every table cell takes `canEdit` from the loaded setup: a Viewer gets text.
    expect(read("components/setup/cells.tsx")).toMatch(/canEdit \?/);
    for (const file of ["tiers-clients", "people-roles"]) expect(read(`components/setup/${file}.tsx`), file).toContain("setup.canEdit");
    // Pay: the salary column only exists for whoever can see pay.
    expect(read("components/setup/people-roles.tsx")).toContain("const showSalary = !setup.payHidden;");
    expect(read("components/setup/people-roles.tsx")).toMatch(/\{showSalary && \(\s*<ColHead/);
    // The actions need a signed-in user and run through row-level security.
    expect(read("app/w/[slug]/settings/setup-actions.ts")).toContain("if (!(await signedIn())) return");
  });

  it("the People page changes nothing: it has no action to call", () => {
    expect(read("components/people-page.tsx")).not.toMatch(/from "@\/app\/w\//);
    expect(read(PAGE("people"))).not.toMatch(/-actions"|\/actions"/);
  });

  it("Access is for owners and agency admins: the section is left out without can_manage_workspace and the link is hidden", () => {
    const access = read("lib/access-data.ts");
    expect(access).toContain('rpc(db, "can_manage_workspace", { ws }),');
    expect(access).toContain("if (!canManage) return null;");
    // The Settings page loads Access only for a manager, and renders the section only when the loader answered (it is null otherwise).
    const page = read(PAGE("settings"));
    expect(page).toContain("data.canManage ? Promise.all([loadAccessSettings(slug),");
    expect(page).toContain("{accessSettings && <AccessSection ");
    // The old address has no page of its own: it redirects to the section, which a non-manager doesn't get.
    expect(existsSync(join(__dirname, "..", "src", PAGE("settings/access")))).toBe(false);
    // The link is in the Settings sub-nav, for managers only: the page passes whether this person manages the workspace.
    const nav = read("components/settings/settings-nav.tsx");
    expect(nav).toContain('{ label: "Access", section: "access", managersOnly: true }');
    expect(nav).toContain('filter((s) => canManage || !("managersOnly" in s))');
    expect(page).toContain("canManage={data.canManage}");
  });
});
