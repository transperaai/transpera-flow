import { chromium, type Browser, type Page } from "playwright-core";
import { mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { capacitySetupFromModel, dler, DLER_GOAL, perEmployee, serviceLines } from "@transpera-flow/db";
import { capacityModel } from "@transpera-flow/engine";
import { bundleHarness } from "./build-harness";

// The Overview's department figures in a real browser, with the Today simulation in a real Web Worker (./overview-departments-harness/entry.tsx),
// on the engine fixture `capacityModel()` and the Set up data that agrees with it (made-up data; the example workspace is the same agency):
// the whole business as hero numbers (WB1), the departments side by side as status tiles (DS1), the busiest people (BP1) and where the
// time goes (WT1), the empty state (no tiers), missing salaries, the pay-hidden view, a phone, and that opening them again does not run the
// simulation again.
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
    it(`shows the whole business, the departments side by side, the busiest people and where the time goes (${width}px)`, async () => {
      const { page, errors } = await mount({}, width);
      await done(page);
      expect(await page.locator("[data-department]").count()).toBe(2);
      for (const name of [ORGANIC, PERFORMANCE]) {
        const dept = setup.departments.find((d) => d.name === name)!;
        const per = perEmployee(setup, dept.id);
        const row = dler(setup).departments.find((d) => d.departmentId === dept.id)!;
        const c = card(page, name);
        const labels = await c.locator("[data-kpi] > div:first-child").allInnerTexts();
        // D39: no "Clients per employee" (clients aren't spread evenly across employees).
        expect(labels).toEqual(["Clients", `MRR ÷ ${per.employees} people`, "DLER", "Over their utilisation threshold", "Room for more clients"]);
        // DLER against its goal, coloured by the Capacity page's rule.
        const d = await kpi(page, name, "DLER");
        expect(d).toContain(row.ratio!.toFixed(1));
        expect(d).toContain(row.ratio! >= DLER_GOAL ? "At or above the 4.5 goal" : "Below the 4.5 goal");
        expect(d).not.toContain(":1");
        expect(await c.locator("[data-kpi]").filter({ hasText: "DLER" }).first().getAttribute("data-tone")).toBe(row.ratio! >= DLER_GOAL ? "good" : "warn");
        const room = await kpi(page, name, "Room for more clients");
        expect(room).toMatch(/Plenty of room|Some room|Tight|Full/);
        expect(room).toMatch(/fills first: .+/);
        // "1 of 7", and what the threshold is.
        const past = await kpi(page, name, "Over their utilisation threshold");
        expect(past).toMatch(/\d+ of \d+/);
        expect(past).toMatch(/Busy above \d+(–\d+% \(each role's utilisation threshold\)|%)/);
      }
      const tiles = page.locator("[data-section=departments]");
      expect(await tiles.locator("[data-capacity-link]").getAttribute("href")).toBe("/w/example/capacity");
      await tiles.locator("[data-how] button").click();
      expect(await tiles.locator("[data-how]").innerText()).toContain("a rough guide from the simulation, not a promise");

      // Busiest people: only those over or within 10 points of their own threshold, busiest first; everyone else folded away.
      const close = await page.locator("[data-busiest-close] [role=img]").evaluateAll((els) => els.map((e) => e.getAttribute("aria-label") ?? ""));
      for (const label of close) {
        const [, busy, line] = /(\d+)% busy against a utilisation threshold of (\d+)%/.exec(label)!;
        expect(Number(busy)).toBeGreaterThanOrEqual(Number(line) - 10);
      }
      const order = await page.locator("[data-busiest-close] [data-busy]").evaluateAll((els) => els.map((e) => Number(e.getAttribute("data-busy"))));
      expect(order).toEqual([...order].sort((a, b) => b - a));
      const rest = page.locator("[data-busiest-rest]");
      const restCount = await rest.count();
      if (restCount) {
        expect(await rest.locator("summary").innerText()).toMatch(/^\d+ (others|people|person) more than 10 points under their utilisation threshold$/);
        expect(await rest.locator("[data-person]").first().isVisible()).toBe(false);
        await rest.locator("summary").click();
        expect(await rest.locator("[data-person]").first().isVisible()).toBe(true);
      }
      expect(close.length + (restCount ? await rest.locator("[data-person]").count() : 0)).toBeGreaterThan(0);
      expect(await page.locator("#busiest-people").innerText()).toMatch(/of their utilisation threshold\.|Nobody is over or within 10 points/);

      // Where the time goes: a bar per department in the same colours, by process by default (Q1 item 16), by purpose on the toggle.
      const time = page.locator("[data-section=where-time-goes]");
      expect(await time.locator("[data-time-by] [aria-pressed=true]").innerText()).toBe("By process");
      expect(await time.locator("[data-department-time]").count()).toBe(2);
      const parts = () => time.locator("[data-part]").evaluateAll((els) => els.map((e) => [e.getAttribute("data-part"), (e as HTMLElement).style.background, e.getAttribute("title")] as const));
      const byProcess = await parts();
      expect(byProcess.length).toBeGreaterThan(0);
      for (const [, , title] of byProcess) expect(title).toMatch(/: \d[\d,]* h a month \(\d+%\)$/);
      // A name has one colour in every bar.
      const colourOf = new Map<string, string>();
      for (const [n, bg] of byProcess) {
        if (colourOf.has(n!)) expect(colourOf.get(n!)).toBe(bg);
        colourOf.set(n!, bg);
      }
      const totals = await time.locator("[data-time-total]").allInnerTexts();
      await time.getByRole("button", { name: "By purpose" }).click();
      expect(await time.locator("[data-time-by] [aria-pressed=true]").innerText()).toBe("By purpose");
      const byPurpose = await parts();
      expect(byPurpose.length).toBeGreaterThan(0);
      expect(byPurpose.map((p) => p[0])).not.toEqual(byProcess.map((p) => p[0]));
      // The same hours either way.
      expect(await time.locator("[data-time-total]").allInnerTexts()).toEqual(totals);
      await time.getByRole("button", { name: "By process" }).click();

      // The whole business comes first, above the departments: unique clients, MRR ÷ N people, DLER against its goal.
      expect(await page.evaluate(() => { const w = document.querySelector("[data-whole-business]")!; const d = document.querySelector("[data-department]")!; return !!(w.compareDocumentPosition(d) & Node.DOCUMENT_POSITION_FOLLOWING); })).toBe(true);
      const lines = serviceLines(setup);
      const whole = await page.locator("[data-whole-business]").innerText();
      expect(whole).toContain(`${lines.unique}`);
      expect(whole).toContain(`${lines.both} taking both`);
      expect(whole).toMatch(/MRR ÷ \d+ people/);
      expect(whole).toMatch(/from .+ MRR/);
      expect(whole).toContain(dler(setup).whole.ratio!.toFixed(1));
      expect(await page.locator("[data-whole-business] [data-dler-scale]").getAttribute("aria-label")).toBe(`DLER ${dler(setup).whole.ratio!.toFixed(1)} against a goal of 4.5`);
      // Only DLER, the figure with a goal, has a status colour.
      expect(await page.locator("[data-whole-business] [data-kpi-status]").count()).toBe(1);
      // The page never scrolls sideways.
      expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
      expect(errors).toEqual([]);
      await page.close();
    });
  }

  it("DLER leaves directors out by default (D48), and counts them when the setting is passed on", async () => {
    const { page, errors } = await mount({ dlerIncludesLeadership: true });
    await done(page);
    const on = capacitySetupFromModel(model, { dlerIncludesLeadership: true });
    const withLeaders = dler(on).whole.ratio!.toFixed(1);
    const without = dler(setup).whole.ratio!.toFixed(1); // the default
    expect(without).not.toBe(withLeaders);
    expect(await page.locator("[data-whole-business]").innerText()).toContain(withLeaders);
    expect(errors).toEqual([]);
    await page.close();
  });

  it("shows the start checklist, with links to Settings, when no tier services exist", async () => {
    const { page, errors } = await mount({ noTiers: true });
    await page.waitForSelector("[data-no-tiers]");
    expect(await page.locator("[data-no-tiers]").innerText()).toContain("No tiers and services are set up yet.");
    const links = await page.locator("[data-setup-checklist] a").evaluateAll((as) => as.map((a) => a.getAttribute("href")));
    expect(links.length).toBeGreaterThanOrEqual(3);
    // Each goes straight to its section of the one Settings page (no detour through a redirect).
    for (const l of links) expect(l).toMatch(/^\/w\/example\/settings#(tiers-clients|people-roles|roles-heading|people-heading|clients-heading)$/);
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
      expect(await card(page, name).locator("[data-kpi]").filter({ hasText: "DLER" }).first().getAttribute("data-tone")).toBe("none");
    }
    expect(await page.locator("[data-whole-business] [data-salaries-missing]").count()).toBe(1);
    expect(await page.locator("[data-salaries-missing] a").first().getAttribute("href")).toBe("/w/example/settings#people-roles");
    expect(await kpi(page, ORGANIC, "MRR ÷")).toMatch(/\d/);
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
    // The per-employee ratio is still there.
    expect(await kpi(page, ORGANIC, "MRR ÷")).toMatch(/\d/);
    expect(errors).toEqual([]);
    await page.close();
  });

  it("does not run the simulation again when the figures open a second time (the Capacity page's cache)", async () => {
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
