import { mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadIssueEvents, loadIssuesForReader, loadProcessBySlug, loadSolutionIssues, loadSolutions, loadSources, type IssueEventRow, type ProcessBundle } from "@transpera-flow/db";
import { loadCapacityExample } from "../../../packages/db/src/fixtures/capacity-example";
import { addExampleIssues } from "../../../packages/db/src/fixtures/capacity-example-issues";
import { createTestDb, createUser, type TestDb } from "../../../packages/db/test/harness";
import { bundleHarness } from "./build-harness";

// Q10, the Issue page on the page kit, in a real browser on the example agency's issues #6 (vetting, with a solution that Works) and #8
// (Ad QA, resolved by an Adopted solution): the header card (title, pills, status dropdown, owners popover, buttons), the map, What's wrong
// edited in place, Solutions tried with a status pill each, and the History timeline. Server Actions are stand-ins that note each call,
// so the checks see what the page asked the server to do. Nothing sideways at 400 px.
// With Q10_SHOTS=<dir> it also saves the screenshots (issues #6 and #8 at 1440 px light and dark and at 400 px, and the solution header).

const META = { "import.meta.url": JSON.stringify("http://harness.test/src/lib/x/") };
const shots = process.env.Q10_SHOTS;

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
let vettingSolutionId = "";
let adQaSolutionId = "";

beforeAll(async () => {
  tdb = await createTestDb({ supabaseDefaultPrivileges: true });
  const owner = await createUser(tdb, "owner@q10.example.com", { agency_admin: true });
  const ws = (await tdb.client.query("insert into workspaces (name, slug) values ('Example agency', 'example') returning id")).rows[0].id as string;
  await tdb.client.query("begin");
  await loadCapacityExample(tdb.client, ws, "2026-11-02");
  const added = await addExampleIssues(tdb.client, ws);
  expect(added.applied).toBe(true);
  await tdb.client.query("commit");
  const db = tdb.dbAs({ sub: owner.id, role: "authenticated", app_metadata: { agency_admin: true } });
  const issues = await loadIssuesForReader(db, ws);
  const processIds = [...new Set(issues.flatMap((i) => i.links.flatMap((l) => (l.process_id ? [l.process_id] : []))))];
  const bundles: Record<string, ProcessBundle> = {};
  for (const id of processIds) bundles[id] = (await loadProcessBySlug(db, "example", { draft: false, processId: id }))!.live as ProcessBundle;
  const events: Record<string, IssueEventRow[]> = {};
  for (const i of issues) events[i.id] = await loadIssueEvents(db, ws, i.id);
  const [solutions, links] = await Promise.all([loadSolutions(db, ws), loadSolutionIssues(db, ws)]);
  vettingSolutionId = solutions.find((s) => s.name === "Vetting by a second person")!.id;
  adQaSolutionId = solutions.find((s) => s.name === "Ad QA only on new campaigns")!.id;
  data = {
    bundles,
    processes: (await tdb.client.query("select id, name from processes where workspace_id = $1 and not is_company", [ws])).rows,
    issues,
    events,
    solutions: { solutions, links },
    sources: await loadSources(db, ws),
    workspaceId: ws,
  };
  [script, css, workers] = await Promise.all([
    bundleHarness(new URL("./q10-issue-page-harness/entry.tsx", import.meta.url), META),
    appCss(),
    Promise.all(["simulate.worker.ts", "absence.worker.ts", "issue-costs.worker.ts", "shadow-price.worker.ts"].map(async (f) => [f, await bundleHarness(new URL(`../src/workers/${f}`, import.meta.url))] as const)).then(Object.fromEntries),
  ]);
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
}, 300_000);

afterAll(async () => {
  await browser?.close();
  await tdb?.close();
});

async function open(o: { call: string; arg: object; width?: number; scheme?: "light" | "dark"; ready: string }): Promise<{ page: Page; errors: string[] }> {
  const page = await browser.newPage({ viewport: { width: o.width ?? 1440, height: 1000 }, colorScheme: o.scheme ?? "light" });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const polyfill = () => {
    if (!crypto.randomUUID) (crypto as { randomUUID: () => string }).randomUUID = () => "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) => (Number(c) ^ (crypto.getRandomValues(new Uint8Array(1))[0]! & (15 >> (Number(c) / 4)))).toString(16));
  };
  await page.setContent(`<style>${css}</style><div id="root"></div>`);
  await page.evaluate(polyfill);
  await page.evaluate(([w, d]) => ((window.workerScripts = w as never), (window.q10Data = d as never)), [workers, data] as const);
  await page.addScriptTag({ content: script });
  await page.evaluate(([call, arg]) => (window as never as Record<string, (a: unknown) => void>)[call as string]!(arg), [o.call, o.arg] as const);
  await page.waitForSelector(o.ready, { timeout: 120_000 });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(800);
  return { page, errors };
}

const issuePage = (number: number, o: { editor?: boolean; noSolutions?: boolean; width?: number; scheme?: "light" | "dark" } = {}) =>
  open({ call: "mountIssue", arg: { number, editor: o.editor ?? true, noSolutions: o.noSolutions }, width: o.width, scheme: o.scheme, ready: "[data-testid=issue-header]" });

const calls = (page: Page) => page.evaluate(() => window.__serverActions ?? []);

describe("the Issue page as cards", () => {
  it("#6 has the breadcrumb above a flat header (title, pills, meta line, buttons) and a metadata rail", async () => {
    const { page, errors } = await issuePage(6);
    const header = page.locator("[data-testid=issue-header]");
    // The breadcrumb sits above the header, not inside it (layout A).
    expect(await header.locator("nav[aria-label=Breadcrumb]").count()).toBe(0);
    expect(await page.locator("nav[aria-label=Breadcrumb]").innerText()).toMatch(/^Issues\s*\/\s*#6$/);
    expect(await header.locator("h1").innerText()).toMatch(/^#6\s+Only Karl can vet link domains$/);
    expect(await header.locator("[data-status-menu]").count()).toBe(1);
    // The process and the dates sit in the details strip, not repeated in a meta line.
    expect(await header.locator("[data-meta-line]").count()).toBe(0);
    for (const name of ["Edit", "Resolve"]) expect(await header.getByRole("button", { name, exact: true }).count()).toBe(1);
    // One (i) for the buttons, not one hand-wrapped beside each.
    expect(await header.locator("[data-page-actions] [data-slot=help]").count()).toBe(1);
    // The strip: owners, its process only (no step pill, QA round 2), dates, sources and solutions. Rating and status are the header's pills.
    const rail = page.getByRole("complementary", { name: "Issue details" });
    expect(await rail.locator("dt").allTextContents()).toEqual(["Owner", "Process", "Created", "Last change", "Sources", "Solutions"]);
    expect(await rail.locator("a[data-issue-process]").count()).toBe(1);
    expect(await rail.locator("[data-process-tag]").count()).toBe(1);
    expect(await rail.locator("[data-owners]").count()).toBe(1);
    expect(errors).toEqual([]);
    await page.close();
  }, 300_000);

  it("the status pill is a dropdown that saves at once, and Resolved opens the Resolve dialog", async () => {
    const { page } = await issuePage(6);
    const header = page.locator("[data-testid=issue-header]");
    await header.locator("[data-status-menu]").click();
    const menu = page.locator("[data-status-options]");
    expect(await menu.locator("button").allInnerTexts()).toEqual(["Open", "Testing solutions", "Resolved", "Won't fix"]);
    await menu.locator("[data-option=open]").click();
    await page.waitForFunction(() => (window.__serverActions ?? []).some((c) => c.name === "saveIssueField"));
    const saved = (await calls(page)).find((c) => c.name === "saveIssueField")!;
    expect(saved.args.slice(1)).toEqual(["status", "testing", "open"]);
    await header.locator("[data-status-menu]").click();
    await page.locator("[data-status-options] [data-option=resolved]").click();
    await page.waitForSelector("[data-resolve-dialog]");
    expect(await page.locator("[data-resolve-dialog]").innerText()).toContain("A solution fixed it");
    await page.close();
  }, 300_000);

  it("a status save that fails says so on the page, with no unhandled rejection, and the pill keeps its value", async () => {
    const { page, errors } = await issuePage(6);
    // Every stand-in Server Action now throws, as a dropped connection would.
    await page.evaluate(() => ((window as never as { __serverActions: unknown }).__serverActions = { push: () => { throw new Error("offline"); } }));
    const header = page.locator("[data-testid=issue-header]");
    await header.locator("[data-status-menu]").click();
    await page.locator("[data-status-options] [data-option=open]").click();
    await page.waitForSelector("[data-page-error]");
    expect(await page.locator("[data-page-error]").innerText()).toBe("Couldn't save. Check your connection and try again.");
    expect(await header.locator("[data-status-menu]").innerText()).toContain("Testing solutions");
    expect(errors).toEqual([]);
    await page.close();
  }, 300_000);

  it("owners are edited in a popover", async () => {
    const { page } = await issuePage(6);
    await page.locator("[data-owners]").click();
    const menu = page.locator("[data-owners-menu]");
    expect(await menu.locator("input[type=checkbox]").count()).toBeGreaterThan(2);
    expect(await menu.locator("input:checked").count()).toBe(1);
    await page.close();
  }, 300_000);

  it("What's wrong is edited where it stands, through the per-field save", async () => {
    const { page } = await issuePage(6);
    const wrong = page.locator("#wrong");
    await wrong.locator("[data-evidence]").getByRole("button").first().click();
    await wrong.getByRole("textbox", { name: "What's wrong" }).fill("Only Karl vets. About 6 a week, 20 minutes each.");
    await wrong.getByRole("button", { name: "Save" }).click();
    await page.waitForFunction(() => (window.__serverActions ?? []).some((c) => c.name === "saveIssueField" && c.args[1] === "evidence"));
    const call = (await calls(page)).find((c) => c.args[1] === "evidence")!;
    expect(call.args[3]).toBe("Only Karl vets. About 6 a week, 20 minutes each.");
    expect(typeof call.args[2]).toBe("string");
    await page.close();
  }, 300_000);

  it("a reader sees the text and no edit controls", async () => {
    const { page } = await issuePage(6, { editor: false });
    expect(await page.locator("#wrong [data-readonly-text]").innerText()).toMatch(/Karl/);
    expect(await page.locator("#wrong [data-edit-entry], #wrong [data-add]").count()).toBe(0);
    expect(await page.locator("[data-owners]").evaluate((el) => el.tagName)).toBe("SPAN");
    expect(await page.locator("[data-testid=issue-header]").getByRole("button", { name: "Edit" }).count()).toBe(0);
    expect(await page.locator("#solutions [data-link-solution], #solutions [data-try-solution]").count()).toBe(0);
    expect(await page.locator("[data-status-menu]").count()).toBe(0);
    await page.close();
  }, 300_000);

  it("Solutions tried: a row per solution with its status pill, what it changes and its result; the buttons are for editors", async () => {
    const { page } = await issuePage(6);
    const section = page.locator("#solutions");
    expect(await section.getByRole("heading", { name: "Solutions tried" }).count()).toBe(1);
    const row = section.locator(`li[data-solution='${vettingSolutionId}']`);
    expect(await row.locator("[data-tried-name]").innerText()).toBe("Vetting by a second person");
    expect(await row.locator("[data-status-menu]").getAttribute("data-status")).toBe("works");
    expect(await row.locator("[data-status-menu]").innerText()).toContain("Works");
    expect(await row.locator("[data-tried-changes]").innerText()).toMatch(/Changes: /);
    // The person's own verdict only, no automatic one (QA round 2).
    expect(await row.locator("[data-tried-result]").innerText()).toMatch(/^(Your call: (Pass|Fail)|No verdict yet\.\s*Open to compare)$/);
    expect(await row.locator("a[href='/w/example/solutions/" + vettingSolutionId + "']").count()).toBeGreaterThan(0);
    expect(await section.locator("[data-try-solution]").innerText()).toBe("+ Try a new solution");
    expect(await section.locator("[data-try-solution]").getAttribute("href")).toMatch(/\/edit\?mode=solution&issue=/);
    expect(await section.locator("[data-link-solution]").innerText()).toBe("Link an existing solution");
    // The status saves at once.
    await row.locator("[data-status-menu]").click();
    await page.locator("[data-status-options] [data-option=adopted]").click();
    await page.waitForFunction(() => (window.__serverActions ?? []).some((c) => c.name === "saveSolutionStatus"));
    expect((await calls(page)).find((c) => c.name === "saveSolutionStatus")!.args).toEqual([vettingSolutionId, "works", "adopted"]);
    await page.close();
  }, 300_000);

  it("with no solution tried the card says what to do", async () => {
    const { page } = await issuePage(6, { noSolutions: true });
    expect(await page.locator("#solutions [data-empty=solutions]").innerText()).toContain("No solutions tried yet. Copy the map, change it, and compare it with today.");
    await page.close();
  }, 300_000);

  it("has no History card, and its sources sit in What's wrong (QA round 2)", async () => {
    const { page } = await issuePage(8);
    expect(await page.locator("#history, [data-timeline-entry]").count()).toBe(0);
    expect(await page.locator("#wrong [data-issue-sources]").count()).toBe(1);
    expect(await page.locator("aside #sources, aside #linked").count()).toBe(0);
    await page.close();
  }, 300_000);

  it("the Solution page header has the status dropdown, and a reader sees a plain pill", async () => {
    const editor = await open({ call: "mountSolution", arg: { id: adQaSolutionId, editor: true }, ready: "[data-testid=solution-header]" });
    const header = editor.page.locator("[data-testid=solution-header]");
    expect(await header.locator("h1").innerText()).toBe("Ad QA only on new campaigns");
    expect(await header.locator("[data-status-menu]").innerText()).toContain("Adopted");
    await header.locator("[data-status-menu]").click();
    expect(await editor.page.locator("[data-status-options] button").allInnerTexts()).toEqual(["Idea", "Testing", "Works", "Doesn't work", "Adopted"]);
    await editor.page.close();
    const reader = await open({ call: "mountSolution", arg: { id: adQaSolutionId, editor: false }, ready: "[data-testid=solution-header]" });
    expect(await reader.page.locator("[data-testid=solution-header] [data-status]").first().innerText()).toBe("Adopted");
    expect(await reader.page.locator("[data-testid=solution-header] [data-status-menu]").count()).toBe(0);
    await reader.page.close();
  }, 300_000);

  it("nothing scrolls sideways at 400 px", async () => {
    for (const n of [6, 8]) {
      const { page } = await issuePage(n, { width: 400 });
      const widths = await page.evaluate(() => ({ page: document.documentElement.scrollWidth, view: document.documentElement.clientWidth }));
      expect(widths.page).toBeLessThanOrEqual(widths.view);
      await page.close();
    }
  }, 300_000);

  it.skipIf(!shots)("saves the screenshots", async () => {
    mkdirSync(shots!, { recursive: true });
    for (const n of [6, 8]) {
      for (const [width, scheme] of [
        [1440, "light"],
        [1440, "dark"],
        [400, "light"],
      ] as const) {
        const { page } = await issuePage(n, { width, scheme });
        await page.setViewportSize({ width, height: await page.evaluate(() => document.documentElement.scrollHeight) });
        await page.waitForTimeout(500);
        await page.screenshot({ path: `${shots}/issue-${n}-${scheme}-${width}.png` });
        await page.close();
      }
    }
    for (const scheme of ["light", "dark"] as const) {
      const { page } = await open({ call: "mountSolution", arg: { id: adQaSolutionId, editor: true }, scheme, ready: "[data-testid=solution-header]" });
      await page.locator("[data-testid=solution-header]").screenshot({ path: `${shots}/solution-header-${scheme}-1440.png` });
      await page.close();
    }
    const { page } = await open({ call: "mountSolution", arg: { id: vettingSolutionId, editor: true }, width: 400, ready: "[data-testid=solution-header]" });
    await page.locator("[data-testid=solution-header]").screenshot({ path: `${shots}/solution-header-light-400.png` });
    await page.close();
  }, 600_000);
});
