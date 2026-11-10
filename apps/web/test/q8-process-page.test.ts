import { mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadCapacitySetup, loadIssuesForReader, loadProcessBySlug, loadSolutionIssues, loadSolutions, type ProcessBundle } from "@transpera-flow/db";
import { loadCapacityExample } from "../../../packages/db/src/fixtures/capacity-example";
import { addExampleIssues, EXAMPLE_MARKER_PROCESS } from "../../../packages/db/src/fixtures/capacity-example-issues";
import { createTestDb, createUser, type TestDb } from "../../../packages/db/test/harness";
import { departmentField } from "@/lib/process-page/department";
import { tierSetupFrom } from "@/lib/tier-setup";
import { bundleHarness } from "./build-harness";

// Q8, the process page as a workbench, in a real browser on the example agency's "Performance: Pacing and hygiene, per channel" process:
// the toolbar (title, pills, the key numbers, pencil popover, History, Edit, Export), the map edge to edge (Key popover, playback docked
// under it), and the inspector's tabs: Step, Facts (What the process shows) and Issues (rows, and the empty state). Nothing sideways at 400 px.
// With Q8_SHOTS=<dir> it also saves the screenshots (with and without issues; 1440 px light and dark, 400 px light).

const META = { "import.meta.url": JSON.stringify("http://harness.test/src/lib/x/") };
const shots = process.env.Q8_SHOTS;

async function appCss(): Promise<string> {
  const require = createRequire(import.meta.url);
  const here = dirname(require.resolve("@tailwindcss/postcss"));
  type Process = { process(css: string, o: { from: string }): Promise<{ css: string }> };
  const postcss = require(require.resolve("postcss", { paths: [here] })) as (plugins: unknown[]) => Process;
  const tailwind = require("@tailwindcss/postcss") as (o: { base: string }) => unknown;
  const file = fileURLToPath(new URL("../src/app/globals.css", import.meta.url));
  return (await postcss([tailwind({ base: fileURLToPath(new URL("..", import.meta.url)) })]).process(readFileSync(file, "utf8"), { from: file })).css;
}

let browser: Browser;
let tdb: TestDb;
let script: string;
let css: string;
let workers: Record<string, string>;
let data: unknown;
let processName = "";

beforeAll(async () => {
  tdb = await createTestDb({ supabaseDefaultPrivileges: true });
  const owner = await createUser(tdb, "owner@q8.example.com", { agency_admin: true });
  const ws = (await tdb.client.query("insert into workspaces (name, slug) values ('Example agency', 'example') returning id")).rows[0].id as string;
  await tdb.client.query("begin");
  await loadCapacityExample(tdb.client, ws, "2026-11-02");
  const added = await addExampleIssues(tdb.client, ws);
  expect(added.applied).toBe(true);
  await tdb.client.query("commit");
  const db = tdb.dbAs({ sub: owner.id, role: "authenticated", app_metadata: { agency_admin: true } });
  const pick = (await tdb.client.query("select id from processes where workspace_id = $1 and name = $2", [ws, EXAMPLE_MARKER_PROCESS])).rows[0].id as string;
  const bundle = (await loadProcessBySlug(db, "example", { draft: false, processId: pick }))!.live as ProcessBundle;
  processName = bundle.process.name;
  const [departments, services, links] = await Promise.all([
    db.selectFrom("departments").select(["id", "name", "sort"]).where("workspace_id", "=", ws).orderBy("sort").execute(),
    db.selectFrom("services").select(["id", "department_id", "tier_id"]).where("workspace_id", "=", ws).where("tier_id", "is not", null).execute(),
    db.selectFrom("service_servicing").select(["process_id", "service_id"]).where("workspace_id", "=", ws).execute(),
  ]);
  const [solutions, solutionLinks] = await Promise.all([loadSolutions(db, ws, pick), loadSolutionIssues(db, ws)]);
  data = {
    bundle,
    tierSetup: tierSetupFrom(await loadCapacitySetup(db, ws)),
    issues: await loadIssuesForReader(db, ws),
    solutions: { solutions, links: solutionLinks.filter((l) => solutions.some((s) => s.id === l.solution_id)) },
    department: departmentField(bundle.process, { departments, services, links }),
  };
  [script, css, workers] = await Promise.all([
    bundleHarness(new URL("./q8-process-page-harness/entry.tsx", import.meta.url), META),
    appCss(),
    Promise.all(["simulate.worker.ts", "absence.worker.ts", "issue-costs.worker.ts", "shadow-price.worker.ts"].map(async (f) => [f, await bundleHarness(new URL(`../src/workers/${f}`, import.meta.url))] as const)).then(Object.fromEntries),
  ]);
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
}, 300_000);

afterAll(async () => {
  await browser?.close();
  await tdb?.close();
});

async function mount(o: { editor: boolean; issues: boolean; width?: number; scheme?: "light" | "dark" }): Promise<{ page: Page; errors: string[] }> {
  const page = await browser.newPage({ viewport: { width: o.width ?? 1440, height: 1000 }, colorScheme: o.scheme ?? "light" });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  // A bare page is not a secure context, which is where the browser offers crypto.randomUUID (the issues state uses it for a reader's ids).
  const polyfill = () => {
    if (!crypto.randomUUID) (crypto as { randomUUID: () => string }).randomUUID = () => "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) => (Number(c) ^ (crypto.getRandomValues(new Uint8Array(1))[0]! & (15 >> (Number(c) / 4)))).toString(16));
  };
  await page.setContent(`<style>${css}</style><div id="root"></div>`);
  await page.evaluate(polyfill);
  await page.evaluate(([w, d]) => ((window.workerScripts = w as never), (window.q8Data = d as never)), [workers, data] as const);
  await page.addScriptTag({ content: script });
  await page.evaluate((m) => window.mountQ8(m), { editor: o.editor, issues: o.issues });
  await page.waitForSelector("[data-supporting-headline]:not(:has(span))", { timeout: 240_000 });
  await page.waitForSelector("#issues", { state: "attached" });
  await page.evaluate(() => document.fonts.ready);
  // Let the map frame itself.
  await page.waitForTimeout(800);
  return { page, errors };
}

describe("the process page as a workbench", () => {
  it("an editor sees the toolbar, the map, the What the process shows tab and the issues rows", async () => {
    const { page, errors } = await mount({ editor: true, issues: true });
    // Header: the title, the pills, History, Edit, Export.
    const header = page.locator("[data-testid=about-process]");
    expect(await header.locator("h1").innerText()).toBe(processName);
    expect(await header.locator("[data-process-tag]").count()).toBe(2);
    expect(await header.innerText()).toMatch(/Live\s+Version 3/);
    expect(await header.locator("[data-process-numbers]").innerText()).toMatch(/^\d+ steps? · \d+ roles? · [\d,.]+ h a month/);
    for (const name of ["History", "Edit", "Export"]) expect(await header.getByRole(name === "Export" ? "button" : "link", { name }).count()).toBe(1);
    // The pencil opens the Type and Department selects.
    await header.getByRole("button", { name: "Edit type and department" }).click();
    const pop = page.locator("[data-slot=popover-content][data-state=open]");
    expect(await pop.locator("select[data-process-category] option").count()).toBe(5);
    expect(await pop.innerText()).toContain("Department");
    await page.keyboard.press("Escape");
    // The map: its label, Swimlanes, the Key popover, Fit on the map itself, and the playback bar docked under it. It fills the page under the toolbar.
    const map = page.locator("#map");
    expect(await map.getByRole("heading", { name: "Process map" }).count()).toBe(1);
    for (const name of ["Swimlanes", "Key", "Fit the map to view"]) expect(await map.getByRole("button", { name, exact: true }).count()).toBe(1);
    expect(await map.locator("[data-playback-strip] [role=group][aria-label=Playback]").count()).toBe(1);
    await map.getByRole("button", { name: "Key" }).click();
    expect(await page.locator("[data-slot=popover-content][data-state=open]").innerText()).toContain("Operational risk");
    await page.keyboard.press("Escape");
    const box = await map.boundingBox();
    expect(box!.height).toBeGreaterThan(600);
    // The inspector opens on Facts, What the process shows: the headline, then the panels. No card stack under the map.
    expect(await page.getByRole("tab", { name: "Facts" }).getAttribute("aria-selected")).toBe("true");
    const run = page.locator("#run");
    for (const panel of ["facts", "hours-by-role", "heaviest-steps", "time-split", "key-person"]) expect(await run.locator(`[data-panel=${panel}]`).count()).toBe(1);
    // Heaviest steps as one strip, the time split as three totals, key-person risk grouped by person under its worst case.
    await run.locator("[data-hours-strip]").waitFor();
    expect(await run.locator("[data-time-total]").count()).toBe(3);
    expect(await run.locator("[data-panel=heaviest-steps] [data-lead]").innerText()).toMatch(/of the [\d,.]+ h a month\.$/);
    // A click on a step shows its detail in the Step tab, not over the map.
    const task = await page.evaluate(() => window.q8Data.bundle.steps.find((st) => st.kind === "task" && !st.parent_step_id && !st.child_process_id)!.id);
    await map.locator(`.react-flow__node[data-id="${task}"]`).click();
    await page.locator("#inspector [data-step-detail]").waitFor();
    expect(await page.getByRole("tab", { name: "Step" }).getAttribute("aria-selected")).toBe("true");
    expect(await map.locator("[data-step-detail]").count()).toBe(0);
    // Issues: counts, a Log an issue button, and rows that open the issue page.
    await page.getByRole("tab", { name: "Issues" }).click();
    const issues = page.locator("#issues");
    expect(await issues.locator("[data-issue-counts]").innerText()).toMatch(/\d+ open · \d+ in progress · \d+ resolved/);
    expect(await issues.getByRole("button", { name: "Log an issue" }).count()).toBe(1);
    const rows = issues.locator("li[data-issue]");
    expect(await rows.count()).toBeGreaterThan(0);
    expect(await rows.first().locator("a[href^='/w/example/issues/']").count()).toBe(1);
    // Issues belong to the process: no step on a row. Current issues first, then the solved ones as the solution that solved them.
    expect(await issues.locator("[data-issue-step]").count()).toBe(0);
    expect(await issues.locator("[data-issue-group=current] h3").innerText()).toMatch(/^Current issues/);
    // Every resolved issue sits under Solved; one solved by a solution opens that solution, with "Solved <issue>" under it.
    const resolved = Number((await issues.locator("[data-issue-counts]").innerText()).match(/(\d+) resolved/)![1]);
    expect(await issues.locator("[data-issue-group=solved] > ul > li").count()).toBe(resolved);
    const bySolution = issues.locator("[data-issue-group=solved] li[data-solved=solution]");
    for (let i = 0; i < (await bySolution.count()); i++) {
      expect(await bySolution.nth(i).locator("a[href^='/w/example/solutions/']").count()).toBe(1);
      expect(await bySolution.nth(i).locator("[data-solved-issue]").innerText()).toMatch(/^Solved /);
    }
    expect(errors).toEqual([]);
    await page.close();
  }, 300_000);

  it("a reader sees the pills and the rows, with no pencil, Edit or Log an issue", async () => {
    const { page, errors } = await mount({ editor: false, issues: true });
    const header = page.locator("[data-testid=about-process]");
    expect(await header.locator("[data-process-tag]").count()).toBe(2);
    expect(await header.locator("[data-process-edit]").count()).toBe(0);
    expect(await header.getByRole("link", { name: "Edit" }).count()).toBe(0);
    expect(await page.locator("#issues").getByRole("button", { name: "Log an issue" }).count()).toBe(0);
    expect(errors).toEqual([]);
    await page.close();
  }, 300_000);

  it("with no issues the card says what goes there, with an icon and the button", async () => {
    const { page } = await mount({ editor: true, issues: false });
    await page.getByRole("tab", { name: "Issues" }).click();
    const empty = page.locator("#issues [data-issues-empty]");
    expect(await empty.innerText()).toContain("Log the problems you find on this map, then link solutions to them.");
    expect(await empty.locator("svg").count()).toBe(1);
    expect(await empty.getByRole("button", { name: "Log an issue" }).count()).toBe(1);
    await page.close();
  }, 300_000);

  it("nothing scrolls sideways at 400 px", async () => {
    const { page } = await mount({ editor: true, issues: true, width: 400 });
    const widths = await page.evaluate(() => ({ page: document.documentElement.scrollWidth, view: document.documentElement.clientWidth }));
    expect(widths.page).toBeLessThanOrEqual(widths.view);
    await page.close();
  }, 300_000);

  it.skipIf(!shots)("saves the screenshots", async () => {
    mkdirSync(shots!, { recursive: true });
    for (const issues of [true, false]) {
      for (const [width, scheme] of [
        [1440, "light"],
        [1440, "dark"],
        [400, "light"],
      ] as const) {
        const { page } = await mount({ editor: true, issues, width, scheme });
        // The workbench fills the viewport from md up; a phone's stacked page is taken whole.
        if (width < 768) await page.setViewportSize({ width, height: await page.evaluate(() => document.documentElement.scrollHeight) });
        await page.waitForTimeout(500);
        await page.screenshot({ path: `${shots}/process-page-${issues ? "with" : "no"}-issues-${scheme}-${width}.png` });
        await page.close();
      }
    }
  }, 600_000);
});
