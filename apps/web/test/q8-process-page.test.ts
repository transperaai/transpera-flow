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

// Q8, the process page on the Issue and Solution pages' detail template, in a real browser on the example agency's "Performance: Pacing
// and hygiene, per channel" process: the breadcrumb ending with the process switcher, the flat header (title, pills, the key numbers,
// pencil popover, History, Edit, Export), the map card (Key popover, playback in its toolbar, the step detail on the map), the sections
// under it (What the process shows, Issues and solutions: rows, and the empty state, Sources) and the metadata rail beside them from xl.
// Nothing sideways at 400 px. With Q8_SHOTS=<dir> it also saves full-page screenshots (with and without issues; 1440 px light and dark,
// 400 px light).

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
  const found = (await loadProcessBySlug(db, "example", { draft: false, processId: pick }))!;
  const bundle = found.live as ProcessBundle;
  processName = bundle.process.name;
  const [departments, services, links] = await Promise.all([
    db.selectFrom("departments").select(["id", "name", "sort"]).where("workspace_id", "=", ws).orderBy("sort").execute(),
    db.selectFrom("services").select(["id", "department_id", "tier_id"]).where("workspace_id", "=", ws).where("tier_id", "is not", null).execute(),
    db.selectFrom("service_servicing").select(["process_id", "service_id"]).where("workspace_id", "=", ws).execute(),
  ]);
  const [solutions, solutionLinks] = await Promise.all([loadSolutions(db, ws, pick), loadSolutionIssues(db, ws)]);
  data = {
    bundle,
    processes: found.processes,
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

describe("the process page on the detail template", () => {
  it("an editor sees the breadcrumb, the header, the map card, the sections and the rail", async () => {
    const { page, errors } = await mount({ editor: true, issues: true });
    // One h1, the process name in the header; the breadcrumb ends with the switcher, which opens every process.
    expect(await page.locator("h1").count()).toBe(1);
    const crumbs = page.locator("nav[aria-label=Breadcrumb]");
    expect(await crumbs.getByRole("link", { name: "Processes" }).getAttribute("href")).toBe("/w/example/processes");
    await crumbs.getByRole("button", { name: `Process: ${processName}. Switch process` }).click();
    const menu = page.locator("[data-slot=dropdown-menu-content][data-state=open]");
    expect(await menu.getByRole("menuitem").count()).toBeGreaterThan(2);
    expect(await menu.locator(`a[aria-current=page]`).innerText()).toContain(processName);
    await page.keyboard.press("Escape");
    // The open menu hides the rest of the page from the accessibility tree; wait until it has gone.
    await page.locator("[data-slot=dropdown-menu-content]").waitFor({ state: "detached" });
    // Header: the title, the pills, History, Edit (with the Editor's marker), Export. The numbers live in the strip below, once.
    const header = page.locator("[data-testid=about-process]");
    expect(await header.locator("h1").innerText()).toBe(processName);
    expect(await header.locator("[data-process-tag]").count()).toBe(2);
    expect(await header.innerText()).toMatch(/Live\s+Version 3/);
    expect(await header.locator("[data-process-numbers]").count()).toBe(0);
    for (const name of ["History", "Edit", "Export"]) expect(await header.getByRole(name === "Export" ? "button" : "link", { name }).count()).toBe(1);
    expect(await header.locator("a[data-edit-entry] [data-edit-marker]").count()).toBe(1);
    // The pencil opens the Type and Department selects.
    await header.getByRole("button", { name: "Edit type and department" }).click();
    const pop = page.locator("[data-slot=popover-content][data-state=open]");
    expect(await pop.locator("select[data-process-category] option").count()).toBe(5);
    expect(await pop.innerText()).toContain("Department");
    await page.keyboard.press("Escape");
    // No workbench: no tabs, no inspector.
    expect(await page.getByRole("tab").count()).toBe(0);
    expect(await page.locator("#inspector").count()).toBe(0);
    // The map card: its heading, then the map's one toolbar row with Swimlanes, the Key popover and playback inline; Fit on the map itself.
    const map = page.locator("#map");
    expect(await map.getByRole("heading", { name: "Process map" }).count()).toBe(1);
    for (const name of ["Swimlanes", "Key", "Fit the map to view"]) expect(await map.getByRole("button", { name, exact: true }).count()).toBe(1);
    expect(await map.locator("[data-map-toolbar] [data-playback-strip] [role=group][aria-label=Playback]").count()).toBe(1);
    await map.getByRole("button", { name: "Key" }).click();
    expect(await page.locator("[data-slot=popover-content][data-state=open]").innerText()).toContain("Operational risk");
    await page.keyboard.press("Escape");
    // The map is about 60% of the viewport tall (1000 px here), never under 28rem.
    const canvas = (await map.locator("[data-process-map]").boundingBox())!;
    expect(canvas.height).toBeGreaterThanOrEqual(595);
    expect(canvas.height).toBeLessThanOrEqual(605);
    // The details strip sits under the header, above the map card and as wide as it; it repeats nothing the header shows.
    const rail = page.locator("[data-process-rail]");
    const [railBox, mapBox] = [(await rail.boundingBox())!, (await map.boundingBox())!];
    expect(Math.abs(railBox.width - mapBox.width)).toBeLessThan(2);
    expect(railBox.y + railBox.height).toBeLessThanOrEqual(mapBox.y);
    const railText = await rail.innerText();
    for (const term of ["Steps", "Roles", "Hours a month", "Open issues", "Last published"]) expect(railText).toContain(term.toUpperCase());
    for (const term of ["Status", "Rating", "Category", "Department"]) expect(railText).not.toContain(term.toUpperCase());
    expect(await rail.locator("[data-process-hours]").innerText()).toMatch(/h|Simulating|Not simulated/);
    // Cost a month shows only where the run puts a cost on the hours (and pay isn't hidden); then it is a sum of money.
    for (const cost of await rail.locator("[data-process-cost]").allInnerTexts()) expect(cost).toMatch(/\d/);
    expect(railText).toContain("2 Nov");
    expect(await rail.locator("a[data-rail-issues]").getAttribute("href")).toBe("#issues");
    // The sections in order under the map: What the process shows, Issues and solutions, Sources.
    const order = await page.evaluate(() => ["map", "run", "issues", "sources"].map((id) => document.getElementById(id)!.getBoundingClientRect().top));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    // What the process shows: the headline, then the panels, each a section card.
    const run = page.locator("#run");
    for (const panel of ["facts", "hours-by-role", "heaviest-steps", "time-split", "key-person"]) expect(await run.locator(`[data-panel=${panel}][data-slot=card]`).count()).toBe(1);
    // Heaviest steps as one strip, the time split as three totals, key-person risk grouped by person under its worst case.
    await run.locator("[data-hours-strip]").waitFor();
    expect(await run.locator("[data-time-total]").count()).toBe(3);
    expect(await run.locator("[data-panel=heaviest-steps] [data-lead]").innerText()).toMatch(/of the [\d,.]+ h a month\.$/);
    // A click on a step shows its detail on the map, as the Issue page's map does.
    const task = await page.evaluate(() => window.q8Data.bundle.steps.find((st) => st.kind === "task" && !st.parent_step_id && !st.child_process_id)!.id);
    await map.locator(`.react-flow__node[data-id="${task}"]`).click();
    await map.locator(`[data-step-detail="${task}"][role=dialog]`).waitFor();
    expect(await page.locator("[data-step-detail]").count()).toBe(1);
    // Issues: counts, a Log an issue button, and rows that open the issue page; a section card, open on the page.
    const issues = page.locator("#issues");
    expect(await issues.getAttribute("data-slot")).toBe("card");
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
    // The rail's open issues are the current ones.
    const current = await issues.locator("[data-issue-group=current] > ul > li").count();
    expect(await rail.locator("a[data-rail-issues]").innerText()).toBe(current ? `${current} open` : "None open");
    // A link into the page scrolls to its section.
    await page.evaluate(() => (location.hash = "sources"));
    // (Sources is last, so the page scrolls as far as it goes: the card is in view, and the map has gone above.)
    await page.waitForFunction(() => {
      const r = document.getElementById("sources")!.getBoundingClientRect();
      return window.scrollY > 0 && r.top >= 0 && r.bottom <= window.innerHeight + 1;
    });
    expect(errors).toEqual([]);
    await page.close();
  }, 300_000);

  it("keeps the details strip above the map, as wide as it, at narrower widths too", async () => {
    const { page } = await mount({ editor: false, issues: true, width: 1100 });
    const [railBox, mapBox] = [(await page.locator("[data-process-rail]").boundingBox())!, (await page.locator("#map").boundingBox())!];
    expect(railBox.y + railBox.height).toBeLessThanOrEqual(mapBox.y);
    expect(Math.abs(railBox.width - mapBox.width)).toBeLessThan(2);
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
        await page.waitForTimeout(500);
        // The page scrolls, like the Issue page: taken whole.
        await page.screenshot({ path: `${shots}/process-page-${issues ? "with" : "no"}-issues-${scheme}-${width}.png`, fullPage: true });
        await page.close();
      }
    }
  }, 600_000);
});
