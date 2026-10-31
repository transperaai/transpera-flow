import { chromium, type Browser, type Page } from "playwright-core";
import { mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bundleHarness } from "./build-harness";

// The Capacity page in a real browser, with its two simulations in a real Web Worker (./capacity-harness/entry.tsx), on the engine
// fixture `capacityModel()` and the Set up data that agrees with it (made-up data; the example workspace is the same agency): every
// section of the page, the leaver select, the empty state (no tiers), the missing state (a blank tier value and an engine problem),
// the pay-hidden view, and a phone, where the page never scrolls sideways and the tables scroll inside their card.
//
// With CAPACITY_SHOTS=<dir> it also saves the screenshots of the page (light and dark, 1440 and 400 px) there.

let browser: Browser;
let script: string;
let workers: Record<string, string>;
let css = "";

const META = { "import.meta.url": JSON.stringify("http://harness.test/src/lib/x/") };

/** The app's real stylesheet (Tailwind compiled from globals.css). Test only: postcss is Tailwind's own dependency. */
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
    bundleHarness(new URL("./capacity-harness/entry.tsx", import.meta.url), META),
    Promise.all(["simulate.worker.ts"].map(async (f) => [f, await bundleHarness(new URL(`../src/workers/${f}`, import.meta.url))] as const)).then(Object.fromEntries),
    appCss(),
  ]);
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
}, 180_000);

afterAll(async () => {
  await browser?.close();
});

type Options = { payHidden?: boolean; noTiers?: boolean; missingWords?: boolean; badModel?: boolean };

async function mount(options: Options = {}, width = 1440, scheme: "light" | "dark" = "light"): Promise<{ page: Page; errors: string[] }> {
  const page = await browser.newPage({ viewport: { width, height: 1000 }, colorScheme: scheme });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.setContent(`<style>${css}</style><div id="root"></div>`);
  await page.evaluate((w) => (window.workerScripts = w), workers);
  await page.addScriptTag({ content: script });
  await page.evaluate((o) => window.mountCapacity(o), options);
  return { page, errors };
}

/** Both runs finished: the "What to do" section has its answer. */
const allDone = (page: Page) => page.waitForSelector("[data-next-twelve] [data-todo], [data-next-twelve]:not(:has([role=status]))", { timeout: 120_000 });
const text = (page: Page, sel: string) => page.locator(sel).first().innerText();

describe("Capacity page", { timeout: 180_000 }, () => {
  for (const width of [1440, 400]) {
    it(`shows every section on the example agency (${width}px)`, async () => {
      const { page, errors } = await mount({}, width);
      await page.waitForSelector("[data-room]", { timeout: 120_000 });
      await allDone(page);
      const root = page.locator("[data-capacity]");
      console.log(`capacity runs (${width}px): today ${await root.getAttribute("data-today-ms")} ms, 12 months ${await root.getAttribute("data-year-ms")} ms`);

      // Headline: clients by service line, taking both, and DLER with the goal.
      const kpis = await page.locator("[data-headline] [data-kpi]").allInnerTexts();
      expect(kpis.some((k) => /Clients with Organic \(SEO\) services/.test(k))).toBe(true);
      expect(kpis.some((k) => /Clients with Performance services/.test(k))).toBe(true);
      expect(kpis.some((k) => /Clients taking both\s+\d+\s+\d+ clients in all/.test(k))).toBe(true);
      expect(kpis.filter((k) => k.includes("DLER") && k.includes("goal 4.5"))).toHaveLength(3);
      expect(kpis.some((k) => k.includes("DLER whole business"))).toBe(true);

      // Room for more clients: a sentence, the gauge with its limits, and chips.
      expect(await page.locator("[data-room]").count()).toBe(2);
      for (const s of await page.locator("[data-room-sentence]").allInnerTexts()) expect(s).toMatch(/can take about \d+ more clients|Full\./);
      expect(await page.locator("[data-gauge]").count()).toBe(2);
      expect(await page.locator("[data-chips] span").count()).toBeGreaterThan(5);

      // Client-facing people: one table per department; Performance has channels.
      expect(await page.locator("[data-people-table]").count()).toBe(2);
      expect(await text(page, '[data-people-table="Performance"] thead')).toContain("Channels");
      expect(await text(page, '[data-people-table="Organic (SEO)"] thead')).not.toContain("Channels");
      expect(await text(page, '[data-people-table="Organic (SEO)"] tbody')).toContain("Laura");

      // Shared teams: no rate is entered, so hours and "Rate not entered yet".
      expect(await page.locator("[data-team]").count()).toBeGreaterThanOrEqual(5);
      expect(await text(page, "[data-shared-teams]")).toContain("Rate not entered yet");

      // Bottleneck: the sentence and step links to the process page.
      expect(await text(page, "[data-bottleneck-sentence]")).toMatch(/is the most stretched, at \d+% against a line of \d+%/);
      const href = await page.locator("[data-step-link]").first().getAttribute("href");
      expect(href).toMatch(/^\/w\/example\/p\/[\w-]+#step-\w+$/);

      // What if someone leaves, time to serve, next 12 months.
      expect(await text(page, "[data-leaver-sentence]")).toMatch(/If .+ leaves/);
      expect(await page.locator("[data-dumbbell]").count()).toBeGreaterThan(0);
      expect(await page.locator("[data-tier-card]").count()).toBe(6);
      expect(await page.locator("[data-named-clients] tbody tr").count()).toBe(13);
      expect(await text(page, "[data-next-twelve]")).toMatch(/What to do:|No team goes over/);
      // Each widget folds its "How this works".
      expect(await page.locator("details[data-how]").count()).toBeGreaterThanOrEqual(8);
      expect(await page.locator("details[data-how][open]").count()).toBe(0);

      // The page never scrolls sideways; wide tables scroll inside their card.
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow).toBeLessThanOrEqual(0);
      if (width === 400) {
        const scrolls = await page.locator("[data-people-table] .overflow-x-auto").evaluateAll((els) => els.map((e) => e.scrollWidth > e.clientWidth));
        expect(scrolls.every(Boolean)).toBe(true);
      }
      expect(errors).toEqual([]);
      await page.close();
    });
  }

  it("changing the person who leaves changes the sentence and the dumbbells", async () => {
    const { page, errors } = await mount();
    await page.waitForSelector("[data-leaver-select]", { timeout: 120_000 });
    const select = page.locator("[data-leaver-select]");
    const first = await text(page, "[data-leaver-sentence]");
    const options = await select.locator("option").allInnerTexts();
    const other = options.find((o) => o === "Zach")!;
    expect(other).toBeDefined();
    await select.selectOption({ label: other });
    const second = await text(page, "[data-leaver-sentence]");
    expect(second).not.toBe(first);
    expect(second).toContain("If Zach leaves");
    expect(second).not.toMatch(/to Zach \(/); // the leaver is never handed clients
    // A shared-team person has no clients: their team shares the work.
    await select.selectOption({ label: "Zach" });
    expect(errors).toEqual([]);
    await page.close();
  });

  it("points to Set up when no tier services exist", async () => {
    const { page, errors } = await mount({ noTiers: true });
    await page.waitForSelector("[data-no-tiers]");
    expect(await text(page, "[data-no-tiers]")).toContain("No tiers and services are set up yet.");
    expect(await page.locator("[data-no-tiers] a").getAttribute("href")).toBe("/w/example/setup/clients");
    expect(await page.locator("[data-room]").count()).toBe(0);
    expect(errors).toEqual([]);
    await page.close();
  });

  it("lists what is missing and the engine's problems, with where to fix each, and still shows the widgets", async () => {
    const missing = await mount({ missingWords: true, badModel: true });
    await missing.page.waitForSelector("[data-attention]");
    const list = await text(missing.page, "[data-attention]");
    expect(list).toContain("Organic (SEO) T1: words");
    expect(list).toMatch(/adoption/i);
    const links = await missing.page.locator("[data-attention] a").evaluateAll((as) => as.map((a) => a.getAttribute("href")));
    expect(links).toContain("/w/example/setup/clients");
    expect(links).toContain("/w/example/processes");
    // The attention list is above the widgets it affects.
    const order = await missing.page.evaluate(() => {
      const a = document.querySelector("[data-attention]")!;
      const r = document.querySelector("[data-headline]")!;
      return a.compareDocumentPosition(r) & Node.DOCUMENT_POSITION_FOLLOWING;
    });
    expect(order).toBeTruthy();
    await missing.page.waitForSelector("[data-room]", { timeout: 120_000 });
    await missing.page.close();
  });

  it("hides every salary from someone who can't see pay, and still shows the page", async () => {
    const { page, errors } = await mount({ payHidden: true });
    await page.waitForSelector("[data-room]", { timeout: 120_000 });
    await allDone(page);
    const all = await page.locator("[data-capacity]").innerText();
    for (const salary of ["12,500", "7,500", "12,000", "7,000", "5,500", "2,500", "6,000", "107,000", "66,000", "173,000"]) expect(all).not.toContain(salary);
    expect(all).toContain("Pay is hidden for your role");
    const dlers = await page.locator("[data-headline] [data-kpi]").filter({ hasText: "DLER" }).allInnerTexts();
    expect(dlers).toHaveLength(3);
    for (const d of dlers) expect(d).not.toMatch(/÷/);
    expect(errors).toEqual([]);
    await page.close();
  });

  const shots = process.env.CAPACITY_SHOTS;
  it.skipIf(!shots)("saves screenshots (light and dark, 1440 and 400 px)", async () => {
    mkdirSync(shots!, { recursive: true });
    for (const scheme of ["light", "dark"] as const) {
      for (const width of [1440, 400]) {
        const { page } = await mount({}, width, scheme);
        await page.waitForSelector("[data-room]", { timeout: 120_000 });
        await allDone(page);
        await page.evaluate(() => document.fonts.ready);
        await page.screenshot({ path: `${shots}/capacity-${scheme}-${width}.png`, fullPage: true });
        await page.close();
      }
    }
  });
});
