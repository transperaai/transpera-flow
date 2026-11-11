import { chromium, type Browser, type Page } from "playwright-core";
import { mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bundleHarness } from "./build-harness";

// The free-play Sandbox in a real browser, with its simulations in a real Web Worker (./play-harness/entry.tsx), on the engine fixture `capacityModel()` and
// the Set up data that agrees with it (made-up data): the three parts stacked (company map, then the levers band, then the results), the result charts (heatmap, over-line bars, three line charts against
// today's path dashed, time bars), a lever that moves the charts, no automation section among the levers (D53), a map version picked from a process's popover (badge, chip, reset to
// today), a price rise with "Clients react", Reset levers, the levers resetting when the
// page is left (unmounted and opened again), no save, scenario or compare UI, no automation levers (D53), pay
// hidden, and a phone, where the page never scrolls sideways. With PLAY_SHOTS=<dir> it also saves the screenshots (light and dark, 1440 and 400 px).

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
    bundleHarness(new URL("./play-harness/entry.tsx", import.meta.url), META),
    Promise.all(["simulate.worker.ts"].map(async (f) => [f, await bundleHarness(new URL(`../src/workers/${f}`, import.meta.url))] as const)).then(Object.fromEntries),
    appCss(),
  ]);
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
}, 180_000);

afterAll(async () => {
  await browser?.close();
});

type Options = { viewer?: boolean; payHidden?: boolean };

async function mount(options: Options = {}, width = 1440, scheme: "light" | "dark" = "light"): Promise<{ page: Page; errors: string[] }> {
  const page = await browser.newPage({ viewport: { width, height: 1000 }, colorScheme: scheme, deviceScaleFactor: process.env.PLAY_SHOTS ? 2 : 1 });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.setContent(`<style>${css}</style><div id="root"></div>`);
  await page.evaluate((w) => (window.workerScripts = w), workers);
  await page.addScriptTag({ content: script });
  await page.evaluate((o) => window.mountPlay(o), options);
  return { page, errors };
}

/** Today's path has run: the result charts are on the page. */
const ready = (page: Page) => page.waitForSelector("[data-play-heatmap]", { timeout: 120_000 });
/** The run for the levers as they stand has finished. */
const settled = async (page: Page) => {
  await page.waitForFunction(() => document.querySelector("[data-run-status]") && !/Working it out/.test(document.querySelector("[data-run-status]")!.textContent ?? ""), null, { timeout: 120_000 });
  // A change waits a moment before it runs: let that moment pass, then wait again for the run.
  await page.waitForTimeout(450);
  await page.waitForFunction(() => !/Working it out/.test(document.querySelector("[data-run-status]")!.textContent ?? ""), null, { timeout: 120_000 });
};
const text = (page: Page, sel: string) => page.locator(sel).first().innerText();
const clientsHeader = (page: Page) => text(page, "[data-chart-header='clients']");

describe("the free-play Sandbox", { timeout: 240_000 }, () => {
  for (const width of [1440, 400]) {
    it(`has its three parts, the result charts on today's path, and no save UI (${width}px)`, async () => {
      const { page, errors } = await mount({}, width);
      await ready(page);

      // One scrolling page: the toolbar, then the company map full width, then the levers laid out horizontally in one band, then the results (the
      // verdict and its figures, then the charts). No pane scrolls on its own; on a phone the same order, stacked.
      expect(await page.locator("[data-play-toolbar]").count()).toBe(1);
      expect(await page.locator("[data-play-map]").count()).toBe(1);
      expect(await page.locator("[data-play-levers]").count()).toBe(1);
      expect(await page.locator("[data-play-results]").count()).toBe(1);
      expect(await page.locator("[data-play-map] details, [data-play-map] summary").count()).toBe(0);
      const layout = await page.evaluate(() => {
        const box = (sel: string) => document.querySelector(sel)!.getBoundingClientRect();
        const map = box("[data-company-map]");
        const levers = box("[data-play-levers-column]");
        const results = box("[data-play-results]");
        const groups = [...document.querySelectorAll("[data-lever-details]")].map((e) => e.getBoundingClientRect());
        return {
          toolbarBeforeMap: box("[data-play-toolbar]").bottom <= box("[data-play-map]").top,
          mapBeforeLevers: map.bottom <= levers.top,
          leversBeforeResults: levers.bottom <= results.top,
          kpisBeforeCharts: box("[data-play-kpis]").bottom <= box("[data-play-charts]").top,
          fullWidth: [map.width, levers.width, results.width].map((w) => Math.round(w)),
          mapHeight: map.height,
          groupRows: new Set(groups.map((g) => Math.round(g.top))).size,
          groupsOpen: groups.length,
          scrollers: [...document.querySelectorAll("[data-sandbox-play] *")].filter((e) => ["auto", "scroll"].includes(getComputedStyle(e).overflowY) && !e.closest("[data-company-map], [data-play-heatmap]")).length,
          pageScrolls: document.documentElement.scrollHeight > window.innerHeight,
        };
      });
      expect(layout.toolbarBeforeMap).toBe(true);
      expect(layout.mapBeforeLevers).toBe(true);
      expect(layout.leversBeforeResults).toBe(true);
      expect(layout.kpisBeforeCharts).toBe(true);
      // The map, the levers band and the results share the page's width; the map is the star (about two thirds of the window, at least 28rem).
      expect(Math.max(...layout.fullWidth) - Math.min(...layout.fullWidth)).toBeLessThanOrEqual(1);
      expect(layout.mapHeight).toBeGreaterThanOrEqual(448);
      // Every group of levers shows; all five on one row from 1440px, wrapped on a phone (one column each).
      expect(layout.groupsOpen).toBe(5);
      expect(layout.groupRows).toBe(width >= 1440 ? 1 : 5);
      expect(layout.scrollers).toBe(0);
      expect(layout.pageScrolls).toBe(true);
      expect(await text(page, "[data-levers-count]")).toBe("No changes");
      expect(await page.locator("[data-levers-reset]").isDisabled()).toBe(true);
      // The verdict's figures: worst month, clients, profit and DLER, in one flat strip.
      expect(await page.locator("[data-play-kpis] [data-play-kpi]").evaluateAll((els) => els.map((e) => e.getAttribute("data-play-kpi")))).toEqual(["worst", "clients", "profit", "dler"]);
      expect(await text(page, "[data-play-summary]")).toMatch(/^(Worst month is [A-Z][a-z]{2} \d{4}|Nobody goes over).+ By [A-Z][a-z]{2} \d{4}: \d+ clients and .+ profit a month\. Move a lever/);

      // Every group of levers the brief lists, and Reset.
      for (const g of ["market", "add", "lose", "price", "people"]) expect(await page.locator(`[data-lever-group="${g}"]`).count(), g).toBe(1);
      expect(await text(page, "[data-play-levers]")).toMatch(/Win new clients[\s\S]*Lose clients[\s\S]*Prices[\s\S]*People/);
      // The levers are business conditions only (D53): an automation is part of a process version, picked on the map.
      expect(await page.locator('[data-lever-group="automation"], [data-automation-switch], [data-changes-manage], [data-change-add]').count()).toBe(0);
      expect(await text(page, "[data-play-levers]")).not.toMatch(/Automation and augmentation/);
      expect(await page.locator("[data-play-reset]").count()).toBe(1);
      expect(await page.locator('[data-lever="priceReaction"] option').allInnerTexts()).toEqual(["Barely", "Normally", "Strongly"]);

      // The map is a card per process, with one line above it; the per-process cards, step pickers and "No solutions" lines are gone.
      expect(await page.locator("[data-company-map] [data-id]").count()).toBeGreaterThanOrEqual(6);
      expect(await text(page, "[data-version-summary]")).toBe("Every process on today's version.");
      for (const gone of [/No solutions for this process/, /No blocks yet/, /Company processes/]) expect(await page.locator("body").innerText(), String(gone)).not.toMatch(gone);
      expect(await page.locator("[data-block], [data-step-row], [data-version]").count()).toBe(0);

      // No "What happens" card: the numbers are in the chart headers. On today's path there is no change, no switch and no dashed copy.
      expect(await page.locator("[data-verdict], [data-verdict-line]").count()).toBe(0);
      expect(await page.locator("body").innerText()).not.toMatch(/What happens/);
      // The worst month of the year, named with the teams over (QA round 2, A1); no comparison on today's path.
      const worst = await text(page, "[data-chart-header='worst']");
      expect(worst).toMatch(/^(Worst month: [A-Z][a-z]{2} \d{4} · \d+ (person|people) over their utilisation threshold\n+.+ \d+|Nobody goes over their utilisation threshold in the next 12 months)$/);
      expect(worst).not.toMatch(/today's path/);
      expect(await text(page, "[data-chart-header='clients']")).toMatch(/^\d+ clients by [A-Z][a-z]{2} \d{4}$/);
      expect(await text(page, "[data-chart-header='retainers']")).toMatch(/ MRR$/);
      expect(await text(page, "[data-chart-header='dler']")).toMatch(/^DLER \d\.\d by [A-Z][a-z]{2} \d{4}$/);
      expect(await page.locator("[data-heat-switch]").count()).toBe(0);
      expect(await page.locator("[data-play-chart]").count()).toBe(3);
      for (const title of ["Clients by department", "MRR", "DLER by department"]) expect(await page.locator(`[data-play-chart="${title}"]`).count(), title).toBe(1);
      expect(await page.locator("[data-play-chart] path[data-line='today']").count()).toBe(0);
      expect(await page.locator("[data-legend-today]").count()).toBe(0);
      // The heatmap: a row for every team and a cell for each of 12 months, the worst month's column outlined; no bars under it. One time bar (C1).
      expect(await page.locator("[data-heat-row]").count()).toBeGreaterThan(2);
      expect(await page.locator("[data-heat-row]").first().locator("[data-heat-cell]").count()).toBe(12);
      expect(await page.locator("[data-play-over-bars], [data-over-bar]").count()).toBe(0);
      if (!/^Nobody/.test(worst)) expect(await page.locator("[data-heat-row] [data-worst-month]").count()).toBe(await page.locator("[data-heat-row]").count());
      expect(await page.locator("[data-play-purpose-bar]").count()).toBe(1);
      expect(await page.locator("[data-play-donut]").count()).toBe(0);
      // The charts side by side at 1440px (three across), one per row on a phone, and the horizon filter at 12 months; no "how far ahead" lines on today's path.
      expect(await page.locator("[data-play-horizon-option='12']").getAttribute("aria-pressed")).toBe("true");
      expect(await page.locator("[data-payoff]").count()).toBe(0);
      const tops = await page.locator("[data-play-card]").evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().top)));
      expect(new Set(tops).size).toBe(width >= 1440 ? 1 : tops.length);
      expect(await page.locator("[data-purpose-moves]").count()).toBe(0);
      // DLER has its 4.5 goal line, and every result card has its (i).
      expect(await text(page, '[data-play-chart="DLER by department"]')).toContain("Goal 4.5");
      for (const t of ["Who's overloaded, and when", "Clients by department", "MRR", "DLER by department", "Where the time goes"]) expect(await page.getByRole("button", { name: `About ${t}` }).count(), t).toBe(1);

      // Nothing about saving, scenarios or comparing; goal seek and "What matters most" stay hidden.
      const all = await page.locator("body").innerText();
      for (const gone of [/Save/, /Rename/, /Duplicate/, /Compare/i, /Saved scenarios/i, /Name this scenario/i, /Find a value/, /What matters most/]) expect(all, String(gone)).not.toMatch(gone);
      for (const sel of ["[data-sandbox-scenario]", "[data-scenario-compare]", "[data-goal-open]", "[data-tornado]"]) expect(await page.locator(sel).count(), sel).toBe(0);

      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow).toBeLessThanOrEqual(0);
      expect(errors).toEqual([]);
      await page.close();
    });
  }

  it("winning new clients moves the charts, and Reset levers puts it back", async () => {
    const { page, errors } = await mount();
    await ready(page);
    const before = await clientsHeader(page);
    expect(before).toMatch(/^\d+ clients by [A-Z][a-z]{2} \d{4}$/);
    await page.locator('[data-lever="add:org"]').fill("2");
    await page.locator('[data-lever="add:perf"]').fill("1");
    await page.locator('[data-lever="addMonths"]').selectOption("6");
    await settled(page);
    expect(await page.locator("[data-sandbox-play]").getAttribute("data-moved")).toBe("true");
    // The levers band counts what moved (two departments' wins; how long for is a setting of them, not a change of its own).
    expect(await text(page, "[data-levers-count]")).toBe("2 changes");
    expect(await page.locator("[data-levers-reset]").isDisabled()).toBe(false);
    const after = await clientsHeader(page);
    const gained = Number(/\(\+(\d+)\)$/.exec(after)?.[1]);
    // 3 a month for 6 months is 18, less the few the example's churn takes in the months after.
    expect(gained).toBeGreaterThan(12);
    expect(gained).toBeLessThanOrEqual(18);
    expect(after).not.toBe(before);
    // The charts changed too: the solid and dashed clients lines are not the same.
    const lines = await page.locator('[data-play-chart="Clients by department"] path').evaluateAll((ps) => ps.map((p) => p.getAttribute("d")));
    expect(new Set(lines).size).toBeGreaterThan(2);
    // The change brings the switch, the dashed lines, the second time bar and a "how far ahead" line under each chart.
    expect(await page.locator("[data-heat-switch-option='scene']").getAttribute("aria-pressed")).toBe("true");
    expect(await page.locator('[data-play-chart="Clients by department"] path[data-line="today"]').count()).toBeGreaterThan(0);
    expect(await page.locator("[data-play-purpose-bar]").count()).toBe(2);
    expect(await text(page, "[data-payoff='clients']")).toBe(`Ahead of today's path by ${gained} clients at 12 months.`);
    expect(await text(page, "[data-payoff='mrr']")).toMatch(/^MRR at 12 months: \+.+ a month on today's path\. Added over the 12 months: \+.+\.$/);
    expect(await page.locator("[data-purpose-moves]").count()).toBe(1);
    // The switch flips the heatmap to today's run and back.
    await page.locator("[data-heat-switch-option='today']").click();
    expect(await page.locator("[data-heat-switch-option='today']").getAttribute("aria-pressed")).toBe("true");
    expect(await page.locator("[data-play-heatmap]").getAttribute("data-heat-view")).toBe("today");
    await page.locator("[data-heat-switch-option='scene']").click();
    expect(await page.locator("[data-play-heatmap]").getAttribute("data-heat-view")).toBe("scene");
    // Hovering a cell tells the team, the month and the busy share.
    await page.locator("[data-heat-cell]").first().hover();
    expect(await page.locator("[data-play-tip]").first().innerText()).toMatch(/busy/);

    await page.locator("[data-play-reset]").click();
    await settled(page);
    expect(await page.locator("[data-sandbox-play]").getAttribute("data-moved")).toBe("false");
    expect(await clientsHeader(page)).toBe(before);
    expect(await page.locator("[data-heat-switch]").count()).toBe(0);
    expect(errors).toEqual([]);
    await page.close();
  });

  it("the levers band's Reset puts the levers back and keeps the map's versions", async () => {
    const { page, errors } = await mount();
    await ready(page);
    const card = page.locator("[data-company-map] [data-id]").first();
    const id = (await card.getAttribute("data-id"))!;
    await card.click();
    await page.locator(`[data-version-popover="${id}"] [data-version-option="sol-${id}"]`).click();
    await page.keyboard.press("Escape");
    await page.locator('[data-lever="add:org"]').fill("2");
    await page.locator('[data-lever="churn"] input').fill("20");
    await settled(page);
    expect(await text(page, "[data-levers-count]")).toBe("2 changes");
    await page.locator("[data-levers-reset]").click();
    await settled(page);
    expect(await page.locator('[data-lever="add:org"]').inputValue()).toBe("0");
    expect(await page.locator('[data-lever="churn"] [data-lever-value]').innerText()).toBe("0%");
    expect(await text(page, "[data-levers-count]")).toBe("No changes");
    // The map's version is a choice on the map, not a lever: it stays, and the run is still off today's path.
    expect(await page.locator(`[data-version-chip="${id}"]`).count()).toBe(1);
    expect(await page.locator("[data-sandbox-play]").getAttribute("data-moved")).toBe("true");
    expect(errors).toEqual([]);
    await page.close();
  });

  it("the levers reset when the page is left", async () => {
    const { page, errors } = await mount();
    await ready(page);
    await page.locator('[data-lever="add:org"]').fill("3");
    await page.locator('[data-lever="leads"] input').fill("20");
    await settled(page);
    expect(await page.locator('[data-lever="add:org"]').inputValue()).toBe("3");
    // Leaving the page unmounts it; coming back opens it fresh.
    await page.evaluate(() => window.unmountPlay());
    await page.evaluate(() => window.mountPlay({}));
    await ready(page);
    expect(await page.locator('[data-lever="add:org"]').inputValue()).toBe("0");
    expect(await page.locator('[data-lever="leads"] [data-lever-value]').innerText()).toBe("0%");
    expect(await page.locator("[data-sandbox-play]").getAttribute("data-moved")).toBe("false");
    expect(errors).toEqual([]);
    await page.close();
  });

  it("clicking a process on the map picks its version: a badge, a chip and the run using it; Reset to today takes it back", async () => {
    const { page, errors } = await mount();
    await ready(page);
    const card = page.locator("[data-company-map] [data-id]").first();
    const id = (await card.getAttribute("data-id"))!;
    await card.click();
    const popover = page.locator(`[data-version-popover="${id}"]`);
    await popover.waitFor();
    // "Today", then each map made for the process with its status pill; the month is off until a map is picked.
    expect(await popover.locator("[data-version-option]").first().getAttribute("data-version-option")).toBe("today");
    expect(await popover.locator(`[data-version-option="sol-${id}"]`).innerText()).toMatch(/^Faster .+\s+Testing$/);
    expect(await popover.locator(`[data-version-option="sol-${id}"] [data-status]`).getAttribute("data-status")).toBe("testing");
    expect(await page.locator(`[data-version-month="${id}"]`).isDisabled()).toBe(true);
    await popover.locator(`[data-version-option="sol-${id}"]`).click();
    expect(await page.locator(`[data-version-month="${id}"]`).isDisabled()).toBe(false);
    await page.locator(`[data-version-month="${id}"]`).selectOption("4");
    await page.keyboard.press("Escape");

    expect(await card.getAttribute("data-new-version")).toBe("true");
    expect(await page.locator(`[data-id="${id}"] ~ [data-version-badge], [data-version-badge]`).first().innerText()).toMatch(/^New version: Faster /);
    expect(await text(page, "[data-version-summary]")).toMatch(/^1 process on new versions\s+.+: Faster .+ from \w{3}\s*✕\s*Reset to today$/);
    expect(await page.locator(`[data-version-chip="${id}"]`).count()).toBe(1);
    await settled(page);
    expect(await page.locator("[data-sandbox-play]").getAttribute("data-moved")).toBe("true");
    expect(await page.locator("[data-run-error]").count()).toBe(0);
    expect(await page.locator("[data-play-heatmap]").count()).toBe(1);

    // The chip's cross takes the one process back; Reset to today takes them all.
    await page.locator(`[data-version-remove="${id}"]`).click();
    expect(await page.locator("[data-version-chip]").count()).toBe(0);
    expect(await card.getAttribute("data-new-version")).toBeNull();
    const second = page.locator("[data-company-map] [data-id]").nth(1);
    for (const c of [card, second]) {
      await c.click();
      await page.locator("[data-version-popover] [data-version-option]").nth(1).click();
      await page.keyboard.press("Escape");
    }
    expect(await text(page, "[data-version-summary]")).toMatch(/^2 processes on new versions/);
    await page.locator("[data-versions-reset]").click();
    expect(await text(page, "[data-version-summary]")).toBe("Every process on today's version.");
    await settled(page);
    expect(await page.locator("[data-sandbox-play]").getAttribute("data-moved")).toBe("false");
    expect(errors).toEqual([]);
    await page.close();
  });

  it("a price rise shows the clients lost to it on their own line, and Strongly loses more than Barely", async () => {
    const { page, errors } = await mount();
    await ready(page);
    expect(await page.locator("[data-price-loss]").count()).toBe(0);
    await page.locator('[data-lever="price"] input').fill("10");
    await page.locator('[data-lever="priceFrom"]').selectOption("1");
    await page.locator('[data-lever="priceReaction"]').selectOption("barely");
    await settled(page);
    await page.waitForSelector("[data-price-loss]");
    const lost = async () => Number(/Clients lost to the price rise: ([\d.]+)/.exec(await text(page, "[data-price-loss]"))?.[1]);
    const barely = await lost();
    expect(barely).toBeGreaterThan(0);
    await page.locator('[data-lever="priceReaction"]').selectOption("strongly");
    await settled(page);
    const strongly = await lost();
    expect(strongly).toBeGreaterThan(barely * 2.5);
    expect(strongly).toBeLessThan(barely * 5.5);
    expect(errors).toEqual([]);
    await page.close();
  });

  it("someone leaving and a hire change the people over their line", async () => {
    const { page, errors } = await mount();
    await ready(page);
    await page.locator('[data-lever="addLeaver"]').click();
    await page.locator('[aria-label="Month they leave"]').first().selectOption("0");
    await settled(page);
    expect(await text(page, "[data-chart-header='worst']")).toMatch(/· today's path: (\d+ in [A-Z][a-z]{2} \d{4}|nobody over)$/);
    await page.locator('[data-lever="addHire"]').click();
    await settled(page);
    expect(await page.locator("[data-hire-row]").count()).toBe(1);
    expect(await page.locator("[data-run-error]").count()).toBe(0);
    expect(errors).toEqual([]);
    await page.close();
  });

  it("shows the charts for the months picked above them, 12 to 60, and the heatmap stays on the first year", async () => {
    const { page, errors } = await mount();
    await ready(page);
    for (const h of ["12", "18", "24", "36", "48", "60"]) expect(await page.locator(`[data-play-horizon-option="${h}"]`).count(), h).toBe(1);
    await page.locator("[data-play-horizon-option='36']").click();
    await settled(page);
    expect(await page.locator("[data-play-horizon-option='36']").getAttribute("aria-pressed")).toBe("true");
    // 36 months from Nov 2026 (the harness's start) end in Oct 2029; the heatmap keeps 12 columns.
    expect(await text(page, "[data-chart-header='clients']")).toMatch(/ by Oct 2029$/);
    expect(await page.locator("[data-heat-row]").first().locator("[data-heat-cell]").count()).toBe(12);
    expect(await text(page, "[data-time-total]")).toMatch(/over the next 36 months\.$/);
    // A change at 36 months says how far ahead it is at 36.
    await page.locator('[data-lever="add:org"]').fill("2");
    await page.locator('[data-lever="addMonths"]').selectOption("6");
    await settled(page);
    expect(await text(page, "[data-payoff='mrr']")).toMatch(/^MRR at 36 months: .+ Added over the 36 months: .+\.$/);
    expect(errors).toEqual([]);
    await page.close();
  });

  it("hides DLER from someone who can't see pay, and still shows the rest", async () => {
    const { page, errors } = await mount({ payHidden: true });
    await ready(page);
    expect(await page.locator("[data-dler-hidden]").count()).toBe(1);
    expect(await page.locator("[data-chart-header='dler']").count()).toBe(0);
    expect(await page.locator("[data-play-chart]").count()).toBe(2);
    expect(errors).toEqual([]);
    await page.close();
  });

  const shots = process.env.PLAY_SHOTS;
  it.skipIf(!shots)("saves screenshots (light and dark, 1440 and 400 px)", async () => {
    mkdirSync(shots!, { recursive: true });
    for (const scheme of ["light", "dark"] as const) {
      for (const width of [1440, 400]) {
        const shotPopover = true;
        const { page } = await mount({}, width, scheme);
        await ready(page);
        // Today's path first: the charts with no change.
        await page.waitForSelector("[data-play-purpose-bar]");
        await page.evaluate(() => document.fonts.ready);
        await page.waitForTimeout(400);
        await page.screenshot({ path: `${shots}/sandbox-today-${scheme}-${width}.png`, fullPage: true });
        await page.locator('[data-lever="add:org"]').fill("2");
        await page.locator('[data-lever="add:perf"]').fill("1");
        await page.locator('[data-lever="addMonths"]').selectOption("6");
        const card = page.locator("[data-company-map] [data-id]").first();
        await card.click();
        await page.locator("[data-version-popover] [data-version-option]").nth(1).click();
        if (shotPopover) await page.screenshot({ path: `${shots}/sandbox-popover-${scheme}-${width}.png`, fullPage: false });
        await page.keyboard.press("Escape");
        await page.locator('[data-lever="price"] input').fill("8");
        await settled(page);
        await page.evaluate(() => document.fonts.ready);
        await page.screenshot({ path: `${shots}/sandbox-${scheme}-${width}.png`, fullPage: true });
        await page.close();
      }
    }
  });
});
