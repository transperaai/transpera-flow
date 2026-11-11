import { chromium, type Browser, type Page } from "playwright-core";
import { mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bundleHarness } from "./build-harness";

// The real Overview page component in a real browser (issue #173, B15), its simulations in real Web Workers: how many runs
// it asks for. The company is simulated at the workspace's length and at the horizon, and changing the horizon runs the horizon again. The page is
// ./overview-page-harness bundled with esbuild (see ../build-harness.ts), each worker bundled on its own.

let browser: Browser;
let script: string;
let workers: Record<string, string>;
let css = "";

/** The app's real stylesheet (Tailwind compiled from globals.css), for the layout checks and screenshots. Test only. */
async function appCss(): Promise<string> {
  const require = createRequire(import.meta.url);
  const here = dirname(require.resolve("@tailwindcss/postcss"));
  type Process = { process(css: string, o: { from: string }): Promise<{ css: string }> };
  const postcss = require(require.resolve("postcss", { paths: [here] })) as (plugins: unknown[]) => Process;
  const tailwind = require("@tailwindcss/postcss") as (o: { base: string }) => unknown;
  const file = fileURLToPath(new URL("../src/app/globals.css", import.meta.url));
  return (await postcss([tailwind({ base: fileURLToPath(new URL("..", import.meta.url)) })]).process(readFileSync(file, "utf8"), { from: file })).css;
}

// The bundle has no `import.meta.url`: give it one under which `../../workers/<name>.ts` names the worker file.
const META = { "import.meta.url": JSON.stringify("http://harness.test/src/lib/x/") };

beforeAll(async () => {
  [script, workers, css] = await Promise.all([
    bundleHarness(new URL("./overview-page-harness/entry.tsx", import.meta.url), META),
    Promise.all(["simulate.worker.ts", "absence.worker.ts"].map(async (f) => [f, await bundleHarness(new URL(`../src/workers/${f}`, import.meta.url))] as const)).then(Object.fromEntries),
    appCss(),
  ]);
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
}, 120_000);

afterAll(async () => {
  await browser?.close();
});

async function mount({ width = 1300, capacity = false, styled = false }: { width?: number; capacity?: boolean; styled?: boolean } = {}): Promise<{ page: Page; errors: string[] }> {
  const page = await browser.newPage({ viewport: { width, height: 1400 } });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.setContent(`${styled ? `<style>${css}</style>` : ""}<div id="root"></div>`);
  await page.evaluate((w) => (window.workerScripts = w), workers);
  await page.addScriptTag({ content: script });
  await page.evaluate((c) => window.mountOverviewPage({ capacity: c }), capacity);
  return { page, errors };
}

const posts = (page: Page) => page.evaluate(() => [...window.workerPosts]);
const count = (list: string[], file: string) => list.filter((f) => f === file).length;

describe("the Overview page's runs", () => {
  it("simulates the horizon again when it changes, between 1, 3 and 6 months only", async () => {
    const { page, errors } = await mount();
    await page.waitForFunction(() => /Playing 3 months/.test(document.querySelector("[data-horizon-note]")?.textContent ?? ""), null, { timeout: 90_000 });
    // Q1 item 9: 1, 3 and 6 months, and a way on to the Sandbox.
    expect(await page.getByRole("group", { name: "Time horizon" }).getByRole("button").allInnerTexts()).toEqual(["1m", "3m", "6m"]);
    expect(await page.locator("[data-sandbox-link]").innerText()).toBe("Simulate further in the Sandbox");
    // Item 7/8: History opens the company map's history page directly, and looks like Export (outline, small).
    expect(await page.locator("[data-company-history]").getAttribute("href")).toBe("/w/x/p/company/history");
    const look = (sel: string) => page.locator(sel).evaluate((e) => e.className.split(/\s+/).sort().join(" "));
    expect(await look("[data-company-history]")).toEqual(await look("[data-export-menu]"));
    const before = await posts(page);
    const runsBefore = count(before, "simulate.worker.ts");
    expect(runsBefore).toBeGreaterThanOrEqual(1);
    expect(runsBefore).toBeLessThanOrEqual(2);

    await page.getByRole("button", { name: "6 months" }).click();
    await page.waitForFunction(() => /Playing 6 months/.test(document.querySelector("[data-horizon-note]")?.textContent ?? ""), null, { timeout: 90_000 });
    await page.waitForFunction(() => /over the next 6 months/.test(document.querySelector('[data-chart="time-split"]')?.textContent ?? ""), null, { timeout: 30_000 });
    // One more run, at the new horizon; the run the findings come from isn't asked for again.
    expect(count(await posts(page), "simulate.worker.ts")).toBe(runsBefore + 1);

    await page.getByRole("button", { name: "3 months" }).click();
    await page.waitForFunction(() => /Playing 3 months/.test(document.querySelector("[data-horizon-note]")?.textContent ?? ""), null, { timeout: 90_000 });
    await expect.poll(async () => count(await posts(page), "simulate.worker.ts"), { timeout: 30_000 }).toBe(runsBefore + 2);
    expect(errors).toEqual([]);
    await page.close();
  }, 240_000);
});

describe("the Overview's layout: a dashboard (docs/plans/ui-cleanup.md)", () => {
  const ready = async (page: Page) => {
    await page.waitForSelector("[data-busiest]", { timeout: 120_000 });
    await page.waitForSelector("[data-team-load]", { timeout: 120_000 });
    await page.waitForSelector("[data-time-achieves]", { timeout: 120_000 });
    await page.waitForSelector("[data-time-split]", { timeout: 120_000 });
  };

  for (const width of [1300, 1600, 400]) {
    it(`the headline tiles in one row, the company map the full width, then the cards sized by what they hold and the departments (${width}px)`, async () => {
      const { page, errors } = await mount({ width, capacity: true, styled: true });
      await ready(page);
      // No jump links and no section rules any more: the panels follow one another in a fixed order.
      expect(await page.locator("[data-jump-links]").count()).toBe(0);
      expect(await page.locator("[data-overview-section]").count()).toBe(0);
      const order = await page.locator("[data-section]").evaluateAll((els) => els.map((e) => e.getAttribute("data-section")));
      expect(order).toEqual(["company-map", "issues", "busiest", "team-load", "where-time-goes", "time-achieves", "time-split", "departments"]);
      // One row of headline tiles before the map: the whole business's three, people over their threshold and open issues.
      expect(await page.locator("[data-kpi-row] [data-whole-business] > [data-kpi]").count()).toBe(5);
      expect(await page.evaluate(() => !!(document.querySelector("[data-kpi-row]")!.compareDocumentPosition(document.querySelector("[data-company-map]")!) & Node.DOCUMENT_POSITION_FOLLOWING))).toBe(true);
      // The company map is the same component as before, with its controls, in one surface (no card inside a card).
      expect(await page.locator("[data-company-map] [data-map-controls]").count()).toBe(1);
      expect(await page.locator("[data-company-map] [data-process-map]").count()).toBe(1);
      expect(await page.locator("[data-company-map] [data-slot=card]").count()).toBe(0);
      const box = (sel: string) => page.locator(sel).first().evaluate((e) => e.getBoundingClientRect().toJSON() as DOMRect);
      const map = await box("[data-company-map]");
      const main = await box("[data-kpi-row]");
      const cards = await page.locator("[data-cards] > [data-chart]").evaluateAll((els) => els.map((e) => e.getBoundingClientRect().toJSON() as DOMRect));
      // Open issues and the busiest people first, then team load and the time charts.
      expect(cards.length).toBe(6);
      expect(cards.every((c) => c.top > map.bottom - 1)).toBe(true);
      // The map runs the full width of the page (the QA ask: no two-thirds map with a rail beside it).
      expect(Math.abs(map.width - main.width)).toBeLessThanOrEqual(1);
      if (width >= 1280) {
        // The map's controls in one slim row above it: Key and playback inline, no strip of their own, no bordered box round playback.
        const bar = await box("[data-company-map] [data-map-toolbar]");
        expect(bar.height).toBeLessThanOrEqual(48);
        const playbackBox = await box("[data-company-map] [data-map-toolbar] [role=group][aria-label=Playback]");
        expect(playbackBox.height).toBeLessThanOrEqual(36);
        expect(await page.locator("[data-company-map] [data-map-toolbar] [data-map-key]").count()).toBe(1);
        expect(await page.locator("[data-company-map] [data-playback-strip]").evaluateAll((els) => els.every((e) => !!e.closest("[data-map-toolbar]")))).toBe(true);
        expect(await page.locator("[data-company-map] [role=group][aria-label=Playback]").evaluate((e) => getComputedStyle(e).borderTopWidth)).toBe("0px");
        // The five headline tiles on one line.
        const tiles = await page.locator("[data-kpi-row] [data-whole-business] > [data-kpi]").evaluateAll((els) => els.map((e) => e.getBoundingClientRect().top));
        expect(new Set(tiles).size).toBe(1);
        // Open issues beside the busiest people (the same height), team load the full width, where the time goes beside what it
        // achieves, then the time split the full width: no tall narrow towers.
        expect(cards[0]!.top).toBe(cards[1]!.top);
        expect(cards[0]!.height).toBe(cards[1]!.height);
        expect(cards[2]!.top).toBeGreaterThan(cards[0]!.bottom - 1);
        expect(Math.abs(cards[2]!.width - map.width)).toBeLessThanOrEqual(1);
        expect(cards[3]!.top).toBe(cards[4]!.top);
        expect(Math.abs(cards[5]!.width - map.width)).toBeLessThanOrEqual(1);
      } else {
        for (let i = 1; i < cards.length; i++) expect(cards[i]!.top).toBeGreaterThan(cards[i - 1]!.bottom - 1);
      }
      // "How this works" is a small (?) in each panel's header, not a line under every chart.
      expect(await page.locator("details[data-how]").count()).toBe(0);
      expect(await page.locator("[data-how] button").count()).toBeGreaterThanOrEqual(6);
      // No sideways scroll on a phone or a laptop.
      expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
      const shots = process.env.OVERVIEW_SHOTS;
      if (shots) {
        mkdirSync(shots, { recursive: true });
        await page.evaluate(() => document.fonts.ready);
        await page.screenshot({ path: `${shots}/overview-${width}.png`, fullPage: true });
      }
      expect(errors).toEqual([]);
      await page.close();
    }, 300_000);
  }
});
