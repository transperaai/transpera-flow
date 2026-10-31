import { chromium, type Browser, type Page } from "playwright-core";
import { mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { capacitySetupFromModel, dler, perEmployee, serviceLines } from "@transpera-flow/db";
import { capacityModel } from "@transpera-flow/engine";
import { bundleHarness } from "./build-harness";

// The Overview's department cards in a real browser, with the Today simulation in a real Web Worker (./overview-departments-harness/entry.tsx),
// on the engine fixture `capacityModel()` and the Set up data that agrees with it (made-up data; the example workspace is the same agency):
// a card per department with its figures, busiest people and time by purpose, the whole business row, the empty state (no tiers), missing
// salaries, the pay-hidden view, a phone, and that opening the cards again does not run the simulation again.
//
// With OVERVIEW_SHOTS=<dir> it also saves the screenshots (light and dark, 1440 and 400 px) there.

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
    bundleHarness(new URL("./overview-departments-harness/entry.tsx", import.meta.url), META),
    Promise.all(["simulate.worker.ts"].map(async (f) => [f, await bundleHarness(new URL(`../src/workers/${f}`, import.meta.url))] as const)).then(Object.fromEntries),
    appCss(),
  ]);
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
}, 180_000);

afterAll(async () => {
  await browser?.close();
});

type Options = { payHidden?: boolean; noTiers?: boolean; noSalaries?: boolean; dlerIncludesLeadership?: boolean };

async function mount(options: Options = {}, width = 1440, scheme: "light" | "dark" = "light"): Promise<{ page: Page; errors: string[] }> {
  const page = await browser.newPage({ viewport: { width, height: 1000 }, colorScheme: scheme });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.setContent(`<style>${css}</style><div id="root"></div>`);
  await page.evaluate((w) => (window.workerScripts = w), workers);
  await page.addScriptTag({ content: script });
  await page.evaluate((o) => window.mountDepartments(o), options);
  return { page, errors };
}

const done = (page: Page) => page.waitForSelector("[data-busiest]", { timeout: 120_000 });
const card = (page: Page, name: string) => page.locator(`[data-department="${name}"]`);
const kpi = (page: Page, name: string, label: string) => card(page, name).locator("[data-kpi]").filter({ hasText: label }).first().innerText();

// What the cards should say, from the same pure figures the db package tests by hand on a small model.
const model = capacityModel();
const setup = capacitySetupFromModel(model);
const ORGANIC = "Organic (SEO)";
const PERFORMANCE = "Performance";

describe("Overview department cards", { timeout: 180_000 }, () => {
  for (const width of [1440, 400]) {
    it(`shows a card per department and the whole business (${width}px)`, async () => {
      const { page, errors } = await mount({}, width);
      await done(page);
      expect(await page.locator("[data-department]").count()).toBe(2);
      for (const name of [ORGANIC, PERFORMANCE]) {
        const dept = setup.departments.find((d) => d.name === name)!;
        const per = perEmployee(setup, dept.id);
        const row = dler(setup).departments.find((d) => d.departmentId === dept.id)!;
        const c = card(page, name);
        const labels = await c.locator("[data-kpi] > div:first-child").allInnerTexts();
        expect(labels).toEqual(["Clients", "Clients per employee", "Revenue per employee", "DLER", "At or over their line", "Room for more clients"]);
        expect(await kpi(page, name, "Clients per employee")).toContain(`${per.clients} clients ÷ ${per.employees} people in the department`);
        expect(await kpi(page, name, "Revenue per employee")).toContain(`retainers ÷ ${per.employees} people`);
        const d = await kpi(page, name, "DLER");
        expect(d).toContain(row.ratio!.toFixed(1));
        expect(d).toContain("goal 4.5");
        expect(d).not.toContain(":1");
        expect(await kpi(page, name, "Room for more clients")).toMatch(/Limit: .+/);
        expect(await kpi(page, name, "At or over their line")).toMatch(/\d/);
        expect(await c.locator("[data-capacity-link]").getAttribute("href")).toBe("/w/example/capacity");
        // Busiest people: at most six, each with a busy bar against the line; where the time goes: purposes with hours and share.
        const people = await c.locator("[data-busiest] tr").count();
        expect(people).toBeGreaterThan(0);
        expect(people).toBeLessThanOrEqual(6);
        expect(await c.locator("[data-busiest] [data-busy]").count()).toBe(people);
        expect(await c.locator("[data-time] [data-purpose]").count()).toBeGreaterThan(0);
        expect(await c.locator("[data-time]").innerText()).toMatch(/h a month/);
      }
      // The whole business: unique clients, revenue per employee, DLER.
      const lines = serviceLines(setup);
      const whole = await page.locator("[data-whole-business]").innerText();
      expect(whole).toContain(`${lines.unique}`);
      expect(whole).toContain(`${lines.both} taking both`);
      expect(whole).toContain("Revenue per employee");
      expect(whole).toContain(dler(setup).whole.ratio!.toFixed(1));
      // The page never scrolls sideways.
      expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
      expect(errors).toEqual([]);
      await page.close();
    });
  }

  it("DLER follows the leadership switch", async () => {
    const { page, errors } = await mount({ dlerIncludesLeadership: false });
    await done(page);
    const off = capacitySetupFromModel(model, { dlerIncludesLeadership: false });
    const on = dler(setup).whole.ratio!.toFixed(1);
    const without = dler(off).whole.ratio!.toFixed(1);
    expect(without).not.toBe(on);
    expect(await page.locator("[data-whole-business]").innerText()).toContain(without);
    expect(errors).toEqual([]);
    await page.close();
  });

  it("shows the start checklist, with links to Set up, when no tier services exist", async () => {
    const { page, errors } = await mount({ noTiers: true });
    await page.waitForSelector("[data-no-tiers]");
    expect(await page.locator("[data-no-tiers]").innerText()).toContain("No tiers and services are set up yet.");
    const links = await page.locator("[data-setup-checklist] a").evaluateAll((as) => as.map((a) => a.getAttribute("href")));
    expect(links.length).toBeGreaterThanOrEqual(3);
    for (const l of links) expect(l).toMatch(/^\/w\/example\/setup\/(people|clients)/);
    expect(await page.locator("[data-department]").count()).toBe(0);
    expect(await page.evaluate(() => window.workerPosts.length)).toBe(0);
    expect(errors).toEqual([]);
    await page.close();
  });

  it("says 'Salaries not entered' with a link when no salary is entered, and leaves the other figures", async () => {
    const { page, errors } = await mount({ noSalaries: true });
    await done(page);
    for (const name of [ORGANIC, PERFORMANCE]) {
      const d = await kpi(page, name, "DLER");
      expect(d).toContain("Salaries not entered");
      expect(d).not.toMatch(/goal/);
    }
    expect(await page.locator("[data-whole-business] [data-salaries-missing]").count()).toBe(1);
    expect(await page.locator("[data-salaries-missing] a").first().getAttribute("href")).toBe("/w/example/setup/people");
    expect(await kpi(page, ORGANIC, "Clients per employee")).toMatch(/\d/);
    expect(errors).toEqual([]);
    await page.close();
  });

  it("shows the ratios but no money behind pay to someone who can't see pay", async () => {
    const { page, errors } = await mount({ payHidden: true });
    await done(page);
    const all = await page.locator("[data-tier=departments]").innerText();
    for (const salary of ["12,500", "7,500", "12,000", "7,000", "5,500", "2,500", "6,000", "107,000", "66,000", "173,000"]) expect(all).not.toContain(salary);
    expect(all).toContain("Pay is hidden for your role");
    expect(all).not.toContain("÷ £");
    // The per-employee ratios are still there.
    expect(await kpi(page, ORGANIC, "Clients per employee")).toMatch(/\d/);
    expect(await kpi(page, ORGANIC, "Revenue per employee")).toMatch(/\d/);
    expect(errors).toEqual([]);
    await page.close();
  });

  it("does not run the simulation again when the cards open a second time (the Capacity page's cache)", async () => {
    const { page, errors } = await mount();
    await done(page);
    const first = await page.evaluate(() => window.workerPosts.length);
    expect(first).toBe(1);
    await page.evaluate(() => window.unmountDepartments());
    await page.evaluate(() => window.mountDepartments());
    await done(page);
    expect(await page.evaluate(() => window.workerPosts.length)).toBe(first);
    expect(errors).toEqual([]);
    await page.close();
  });

  const shots = process.env.OVERVIEW_SHOTS;
  it.skipIf(!shots)("saves screenshots (light and dark, 1440 and 400 px)", async () => {
    mkdirSync(shots!, { recursive: true });
    for (const scheme of ["light", "dark"] as const) {
      for (const width of [1440, 400]) {
        const { page } = await mount({}, width, scheme);
        await done(page);
        await page.evaluate(() => document.fonts.ready);
        await page.screenshot({ path: `${shots}/overview-departments-${scheme}-${width}.png`, fullPage: true });
        await page.close();
      }
    }
  });
});
