import { chromium, type Browser, type Page } from "playwright-core";
import { mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadCapacitySetup, loadIssuesForReader, loadLiveCompanyPart, loadLiveParts, loadLiveProcessBySlug, loadSolutionIssues, loadSolutions } from "@transpera-flow/db";
import { loadCapacityExample } from "../../../packages/db/src/fixtures/capacity-example";
import { addExampleIssues } from "../../../packages/db/src/fixtures/capacity-example-issues";
import { createTestDb, createUser, type TestDb } from "../../../packages/db/test/harness";
import { bundleHarness } from "./build-harness";
import type { Q16Data } from "./q16-harness/entry";

// Q16, the Sandbox as the company map, in a real browser on the example agency (with its solutions) in a throwaway database with the real migrations: the
// real company map canvas (lanes, category tags) in a "Company map" card with one line above it; a click on a process card opens the version popover
// (Today, each solution with its status); picking one gives the card a badge and outline, a chip and a run on it; Reset to today; a solution that holds an
// automation (D53) runs it from the month it is picked; the levers have no automation section; `?solution=` still picks a version when the page opens; and nothing sideways at 400 px.
// With Q16_SHOTS=<dir> it also saves the screenshots (1440 px light and dark and 400 px; a version popover and a swapped process).

let tdb: TestDb;
let browser: Browser;
let script: string;
let workers: Record<string, string>;
let css = "";
let data: Q16Data;

const META = { "import.meta.url": JSON.stringify("http://harness.test/src/lib/x/") };
const shots = process.env.Q16_SHOTS;

async function appCss(): Promise<string> {
  const require = createRequire(import.meta.url);
  const here = dirname(require.resolve("@tailwindcss/postcss"));
  type Process = { process(css: string, o: { from: string }): Promise<{ css: string }> };
  const postcss = require(require.resolve("postcss", { paths: [here] })) as (plugins: unknown[]) => Process;
  const tailwind = require("@tailwindcss/postcss") as (o: { base: string }) => unknown;
  const file = fileURLToPath(new URL("../src/app/globals.css", import.meta.url));
  return (await postcss([tailwind({ base: fileURLToPath(new URL("..", import.meta.url)) })]).process(readFileSync(file, "utf8"), { from: file })).css;
}

beforeAll(async () => {
  [script, workers, css] = await Promise.all([
    bundleHarness(new URL("./q16-harness/entry.tsx", import.meta.url), META),
    Promise.all(["simulate.worker.ts"].map(async (f) => [f, await bundleHarness(new URL(`../src/workers/${f}`, import.meta.url))] as const)).then(Object.fromEntries),
    appCss(),
  ]);
  tdb = await createTestDb({ seed: false });
  const admin = await createUser(tdb, "admin@q16.example.com", { agency_admin: true });
  const ws = (await tdb.client.query("insert into workspaces (name, slug) values ('Example agency', 'q16') returning id")).rows[0].id as string;
  await tdb.client.query("update workspaces set settings = coalesce(settings, '{}'::jsonb) || '{\"currency\":\"GBP\"}'::jsonb where id = $1", [ws]);
  await tdb.client.query("begin");
  await loadCapacityExample(tdb.client, ws, "2026-11-02");
  const added = await addExampleIssues(tdb.client, ws);
  expect(added.applied).toBe(true);
  await tdb.client.query("commit");
  const db = tdb.dbAs({ ...admin.claims, role: "authenticated" });
  const [live, parts, company, setup, issues, solutions, solutionLinks] = await Promise.all([
    loadLiveProcessBySlug(db, "q16"),
    loadLiveParts(db, ws),
    loadLiveCompanyPart(db, ws),
    loadCapacitySetup(db, ws),
    loadIssuesForReader(db, ws),
    loadSolutions(db, ws),
    loadSolutionIssues(db, ws),
  ]);
  const [departments, services, links] = await Promise.all([
    db.selectFrom("departments").select(["id", "name", "sort"]).where("workspace_id", "=", ws).orderBy("sort").execute(),
    db.selectFrom("services").select(["id", "department_id", "tier_id"]).where("workspace_id", "=", ws).where("tier_id", "is not", null).execute(),
    db.selectFrom("service_servicing").select(["process_id", "service_id"]).where("workspace_id", "=", ws).execute(),
  ]);
  data = JSON.parse(JSON.stringify({ live, parts, company, setup, issues, solutions, solutionLinks, laneInput: { departments, services, links } })) as Q16Data;
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
}, 300_000);

afterAll(async () => {
  await browser?.close();
  await tdb?.close();
});

async function mount(o: { width?: number; scheme?: "light" | "dark"; solution?: string } = {}): Promise<{ page: Page; errors: string[] }> {
  const page = await browser.newPage({ viewport: { width: o.width ?? 1440, height: 1000 }, colorScheme: o.scheme ?? "light" });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.setContent(`<style>${css}</style><div id="root"></div>`);
  await page.evaluate((w) => (window.workerScripts = w), workers);
  await page.addScriptTag({ content: script });
  await page.evaluate(([d, opt]) => window.mountQ16(d as Q16Data, opt as { solution?: string }), [data, { solution: o.solution }] as const);
  await page.waitForSelector("[data-company-map] .react-flow__node-group", { timeout: 120_000 });
  await page.waitForSelector("[data-play-heatmap]", { timeout: 60_000 }).catch(async (e: Error) => {
    // Say what the page shows instead of a bare timeout.
    const seen = await page.evaluate(() => [document.querySelector("[data-model-error]")?.textContent, document.querySelector("[data-run-error]")?.textContent, document.querySelector("[data-run-status]")?.textContent].join(" | "), []).catch(() => "");
    throw new Error(`${e.message}\n${seen}\n${errors.join("\n")}`);
  });
  // Every card measured and the map framed.
  await page.waitForTimeout(700);
  return { page, errors };
}

const settled = async (page: Page) => {
  await page.waitForTimeout(500);
  await page.waitForFunction(() => !/Working it out/.test(document.querySelector("[data-run-status]")?.textContent ?? ""), null, { timeout: 120_000 });
};

/** A process card that has a solution: its card, its id and the solution's name. */
function withSolution() {
  const s = data.solutions[0]!;
  const p = data.parts.find((x) => x.process.id === s.process_id)!;
  return { solution: s, processId: p.process.id, processName: p.process.name };
}

const card = (page: Page, processId: string) => page.locator(`[data-company-map] .react-flow__node-group[data-id="${processId}"]`);

describe("the Sandbox as the company map", { timeout: 300_000 }, () => {
  it("shows the company map first, full width, with lanes and tags, then the levers, then the results", async () => {
    const { page, errors } = await mount();
    expect(await page.locator("[data-play-map] [data-lane]").count()).toBeGreaterThan(1);
    expect(await page.locator("[data-play-map] [data-process-tag]").count()).toBeGreaterThan(1);
    expect(await page.locator("[data-play-map] h2").first().innerText()).toContain("Company map");
    expect(await page.locator("[data-version-summary]").innerText()).toBe("Every process on today's version.");
    expect(await page.locator("[data-play-processes], [data-step-row], [data-block], [data-version]").count()).toBe(0);
    const body = await page.locator("body").innerText();
    expect(body).not.toMatch(/No solutions for this process|No blocks yet/);
    const layout = await page.evaluate(() => {
      const box = (s: string) => document.querySelector(s)!.getBoundingClientRect();
      const map = box("[data-company-map]");
      return {
        stacked: map.bottom <= box("[data-play-levers-column]").top && box("[data-play-levers-column]").bottom <= box("[data-play-results]").top,
        widths: [map.width, box("[data-play-levers-column]").width, box("[data-play-results]").width].map(Math.round),
        mapHeight: map.height,
        canvasHeight: document.querySelector("[data-company-map] [data-process-map]")!.getBoundingClientRect().height,
      };
    });
    // One scrolling page: the map on top, full width and about two thirds of the window tall (the canvas filling it), then the levers band, then the results.
    expect(layout.stacked).toBe(true);
    expect(Math.max(...layout.widths) - Math.min(...layout.widths)).toBeLessThanOrEqual(1);
    expect(layout.mapHeight).toBeGreaterThanOrEqual(600);
    expect(layout.canvasHeight).toBeGreaterThan(layout.mapHeight - 20);
    expect(errors).toEqual([]);
    await page.close();
  });

  it("clicking a process lists Today and its solutions; picking one badges the card, adds a chip and runs it; Reset to today undoes it", async () => {
    const { page, errors } = await mount();
    const { solution, processId, processName } = withSolution();
    await card(page, processId).click();
    const popover = page.locator(`[data-version-popover="${processId}"]`);
    await popover.waitFor();
    expect(await popover.locator("[data-version-option]").first().getAttribute("data-version-option")).toBe("today");
    expect(await popover.locator(`[data-version-option="${solution.id}"]`).innerText()).toContain(solution.name);
    expect(await popover.locator(`[data-version-option="${solution.id}"] [data-status]`).count()).toBe(1);
    await popover.locator(`[data-version-option="${solution.id}"]`).click();
    await page.locator(`[data-version-month="${processId}"]`).selectOption("2");
    await page.keyboard.press("Escape");
    await popover.waitFor({ state: "detached" });

    expect(await card(page, processId).getAttribute("data-new-version")).toBeNull();
    expect(await card(page, processId).locator("[data-new-version]").count()).toBe(1);
    expect(await card(page, processId).locator("[data-version-badge]").innerText()).toBe(`New version: ${solution.name}`);
    expect(await page.locator("[data-version-summary]").innerText()).toMatch(/^1 process on new versions/);
    expect(await page.locator(`[data-version-chip="${processId}"]`).innerText()).toContain(processName);
    await settled(page);
    expect(await page.locator("[data-sandbox-play]").getAttribute("data-moved")).toBe("true");
    expect(await page.locator("[data-run-error]").count()).toBe(0);

    await page.locator("[data-versions-reset]").click();
    expect(await card(page, processId).locator("[data-version-badge]").count()).toBe(0);
    expect(await page.locator("[data-version-chip]").count()).toBe(0);
    await settled(page);
    expect(await page.locator("[data-sandbox-play]").getAttribute("data-moved")).toBe("false");
    expect(errors).toEqual([]);
    await page.close();
  });

  it("a solution that holds an automation runs it from the month it is picked; the levers have no automation section", async () => {
    const { page, errors } = await mount();
    expect(await page.locator('[data-lever-group="automation"], [data-automation-switch], [data-changes-manage], [data-change-add]').count()).toBe(0);
    expect(await page.locator("[data-play-levers]").innerText()).not.toMatch(/Automation and augmentation/);
    const held = data.solutions.find((s) => s.step_changes.length > 0)!;
    expect(held.step_changes[0]!.name).toBeTruthy();
    await card(page, held.process_id).click();
    const popover = page.locator(`[data-version-popover="${held.process_id}"]`);
    await popover.waitFor();
    await popover.locator(`[data-version-option="${held.id}"]`).click();
    await page.locator(`[data-version-month="${held.process_id}"]`).selectOption("1");
    await page.keyboard.press("Escape");
    await settled(page);
    expect(await page.locator("[data-sandbox-play]").getAttribute("data-moved")).toBe("true");
    expect(await page.locator("[data-run-error]").count()).toBe(0);
    await page.locator("[data-versions-reset]").click();
    await settled(page);
    expect(await page.locator("[data-sandbox-play]").getAttribute("data-moved")).toBe("false");
    expect(errors).toEqual([]);
    await page.close();
  });

  it("?solution= still picks the solution as its process's version when the page opens", async () => {
    const { solution, processId } = withSolution();
    const { page, errors } = await mount({ solution: solution.id });
    expect(await card(page, processId).locator("[data-version-badge]").innerText()).toBe(`New version: ${solution.name}`);
    expect(await page.locator("[data-version-summary]").innerText()).toMatch(/^1 process on new versions/);
    expect(errors).toEqual([]);
    await page.close();
  });

  it("never scrolls sideways at 400 px", async () => {
    const { page } = await mount({ width: 400 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
    await page.close();
  });

  it.skipIf(!shots)("saves screenshots (1440 px light and dark, 400 px; the version popover and a swapped process)", async () => {
    mkdirSync(shots!, { recursive: true });
    const { solution, processId } = withSolution();
    for (const [width, scheme] of [[1440, "light"], [1440, "dark"], [400, "light"]] as const) {
      const { page } = await mount({ width, scheme });
      await card(page, processId).click();
      await page.locator(`[data-version-popover="${processId}"]`).waitFor();
      await page.waitForTimeout(300);
      await page.screenshot({ path: `${shots}/sandbox-popover-${scheme}-${width}.png` });
      await page.locator(`[data-version-option="${solution.id}"]`).click();
      await page.keyboard.press("Escape");
      await settled(page);
      await page.waitForSelector("[data-play-heatmap]", { timeout: 120_000 });
      await page.evaluate(() => (window.scrollTo(0, 0), document.fonts.ready));
      expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
      await page.waitForTimeout(500);
      await page.screenshot({ path: `${shots}/sandbox-swapped-${scheme}-${width}.png`, fullPage: true });
      await page.close();
    }
  });
});
