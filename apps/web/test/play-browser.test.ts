import { chromium, type Browser, type Page } from "playwright-core";
import { mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bundleHarness } from "./build-harness";

// The free-play Sandbox in a real browser, with its simulations in a real Web Worker (./play-harness/entry.tsx), on the engine fixture `capacityModel()` and
// the Set up data that agrees with it (made-up data): the three parts (company map on top, levers left, results right), the verdict and four charts against
// today's path (dashed), a lever that moves the verdict, an automation switched on, a map version picked from a process's popover (badge, chip, reset to
// today), a price rise with "Clients react", Reset levers, the levers resetting when the
// page is left (unmounted and opened again), no save, scenario or compare UI, the changes list (add, edit, remove) for an admin and not for a Viewer, pay
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
  const page = await browser.newPage({ viewport: { width, height: 1000 }, colorScheme: scheme });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.setContent(`<style>${css}</style><div id="root"></div>`);
  await page.evaluate((w) => (window.workerScripts = w), workers);
  await page.addScriptTag({ content: script });
  await page.evaluate((o) => window.mountPlay(o), options);
  return { page, errors };
}

/** Today's path has run: the verdict is on the page. */
const ready = (page: Page) => page.waitForSelector("[data-verdict-line]", { timeout: 120_000 });
/** The run for the levers as they stand has finished. */
const settled = async (page: Page) => {
  await page.waitForFunction(() => document.querySelector("[data-run-status]") && !/Working it out/.test(document.querySelector("[data-run-status]")!.textContent ?? ""), null, { timeout: 120_000 });
  // A change waits a moment before it runs: let that moment pass, then wait again for the run.
  await page.waitForTimeout(450);
  await page.waitForFunction(() => !/Working it out/.test(document.querySelector("[data-run-status]")!.textContent ?? ""), null, { timeout: 120_000 });
};
const text = (page: Page, sel: string) => page.locator(sel).first().innerText();
const verdictFirst = (page: Page) => text(page, "[data-verdict-line='0']");

describe("the free-play Sandbox", { timeout: 240_000 }, () => {
  for (const width of [1440, 400]) {
    it(`has its three parts, the verdict and four charts against today's path, and no save UI (${width}px)`, async () => {
      const { page, errors } = await mount({}, width);
      await ready(page);

      // 1. Company map on top; 2. levers; 3. results.
      expect(await page.locator("[data-play-map]").count()).toBe(1);
      expect(await page.locator("[data-play-levers]").count()).toBe(1);
      expect(await page.locator("[data-play-results]").count()).toBe(1);
      const top = await page.evaluate(() => {
        const p = document.querySelector("[data-play-map]")!.getBoundingClientRect().top;
        const l = document.querySelector("[data-play-levers]")!.getBoundingClientRect().top;
        return p < l;
      });
      expect(top).toBe(true);

      // Every group of levers the brief lists, and Reset.
      for (const g of ["market", "add", "lose", "price", "people", "automation"]) expect(await page.locator(`[data-lever-group="${g}"]`).count(), g).toBe(1);
      expect(await text(page, "[data-play-levers]")).toMatch(/Win new clients[\s\S]*Lose clients[\s\S]*Prices[\s\S]*People[\s\S]*Automation and augmentation/);
      expect(await page.locator("[data-play-reset]").count()).toBe(1);
      expect(await page.locator('[data-lever="priceReaction"] option').allInnerTexts()).toEqual(["Barely", "Normally", "Strongly"]);

      // The map is a card per process, with one line above it; the per-process cards, step pickers and "No solutions" lines are gone.
      expect(await page.locator("[data-company-map] [data-id]").count()).toBeGreaterThanOrEqual(6);
      expect(await text(page, "[data-version-summary]")).toBe("All processes on today's map. Click a process to load another version.");
      for (const gone of [/No solutions for this process/, /No blocks yet/, /Company processes/]) expect(await page.locator("body").innerText(), String(gone)).not.toMatch(gone);
      expect(await page.locator("[data-block], [data-step-row], [data-version]").count()).toBe(0);
      // Automations are a lever group: a switch and a muted line naming the steps each acts on.
      expect(await page.locator("[data-automation-switch]").count()).toBeGreaterThan(5);
      expect(await text(page, "[data-automation-steps]")).toMatch(/^(Automation|Augmentation), acts on .+/);

      // The verdict: the prototype's sentences, then four charts with a dashed "Today's path".
      const first = await verdictFirst(page);
      expect(first).toMatch(/^By \w{3}: \d+ clients \([+−]\d+ against today's path\), retainers .+ a month \([+−].+\), DLER \d\.\d \(\d\.\d on today's path\)\.$/);
      expect(await text(page, "[data-verdict-line]:last-child")).toMatch(/^At the worst month, \d+ (person is|people are) over their line \(\d+ on today's path\)\.$/);
      expect(await page.locator("[data-play-chart]").count()).toBe(4);
      for (const title of ["Clients by department", "Retainers a month", "DLER by department", "Busy share of the five busiest teams"]) expect(await page.locator(`[data-play-chart="${title}"]`).count(), title).toBe(1);
      for (const chart of await page.locator("[data-play-chart]").all()) {
        expect(await chart.locator('path[data-line="today"]').count()).toBeGreaterThan(0);
        expect(await chart.locator("[data-legend-today]").innerText()).toBe("Today's path");
      }
      // DLER has its 4.5 goal line; the busy chart a line per team.
      expect(await text(page, '[data-play-chart="DLER by department"]')).toContain("Goal 4.5");
      expect(await page.locator('[data-play-chart="Busy share of the five busiest teams"] [data-team-line]').count()).toBe(5);

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

  it("winning new clients moves the verdict and the charts, and Reset levers puts it back", async () => {
    const { page, errors } = await mount();
    await ready(page);
    const before = await verdictFirst(page);
    expect(before).toMatch(/\(\+0 against today's path\)/);
    await page.locator('[data-lever="add:org"]').fill("2");
    await page.locator('[data-lever="add:perf"]').fill("1");
    await page.locator('[data-lever="addMonths"]').selectOption("6");
    await settled(page);
    expect(await page.locator("[data-sandbox-play]").getAttribute("data-moved")).toBe("true");
    const after = await verdictFirst(page);
    const gained = Number(/\(\+(\d+) against today's path\)/.exec(after)?.[1]);
    // 3 a month for 6 months is 18, less the few the example's churn takes in the months after.
    expect(gained).toBeGreaterThan(12);
    expect(gained).toBeLessThanOrEqual(18);
    expect(after).not.toBe(before);
    // The charts changed too: the solid and dashed clients lines are not the same.
    const lines = await page.locator('[data-play-chart="Clients by department"] path').evaluateAll((ps) => ps.map((p) => p.getAttribute("d")));
    expect(new Set(lines).size).toBeGreaterThan(2);

    await page.locator("[data-play-reset]").click();
    await settled(page);
    expect(await page.locator("[data-sandbox-play]").getAttribute("data-moved")).toBe("false");
    expect(await verdictFirst(page)).toBe(before);
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

  it("an automation switched on runs from its month, and switching it off puts today's path back", async () => {
    const { page, errors } = await mount();
    await ready(page);
    const row = page.locator("[data-automation]").first();
    const id = (await row.getAttribute("data-automation"))!;
    expect(await row.getAttribute("data-on")).toBe("false");
    expect(await page.locator(`[data-lever="automation:${id}"]`).count()).toBe(0);
    await page.locator(`[data-automation-switch="${id}"]`).click();
    expect(await row.getAttribute("data-on")).toBe("true");
    await page.locator(`[data-lever="automation:${id}"]`).selectOption("3");
    await settled(page);
    expect(await page.locator("[data-sandbox-play]").getAttribute("data-moved")).toBe("true");
    await page.locator(`[data-automation-switch="${id}"]`).click();
    expect(await row.getAttribute("data-on")).toBe("false");
    await settled(page);
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
    expect(await page.locator("[data-verdict-line]").count()).toBeGreaterThanOrEqual(2);

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
    expect(await text(page, "[data-version-summary]")).toBe("All processes on today's map. Click a process to load another version.");
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

  it("someone leaving and a hire change when teams and people go over their line", async () => {
    const { page, errors } = await mount();
    await ready(page);
    await page.locator('[data-lever="addLeaver"]').click();
    await page.locator('[aria-label="Month they leave"]').first().selectOption("0");
    await settled(page);
    const text1 = await text(page, "[data-verdict]");
    expect(text1).toMatch(/over the line|no longer over|go over their line|At the worst month/);
    await page.locator('[data-lever="addHire"]').click();
    await settled(page);
    expect(await page.locator("[data-hire-row]").count()).toBe(1);
    expect(await page.locator("[data-run-error]").count()).toBe(0);
    expect(errors).toEqual([]);
    await page.close();
  });

  it("an admin adds, edits and removes a change; a Viewer can't", async () => {
    const admin = await mount();
    await ready(admin.page);
    const n = await admin.page.locator("[data-changes-list] li").count();
    expect(n).toBeGreaterThan(5);
    // Add and Edit are behind the group's Manage button.
    expect(await admin.page.locator("[data-change-add]").count()).toBe(0);
    await admin.page.locator("[data-changes-manage]").click();
    await admin.page.locator("[data-change-add]").click();
    await admin.page.locator("[data-change-name]").fill("Auto QA");
    await admin.page.locator("[data-change-save]").click();
    await admin.page.waitForSelector("[data-change-dialog]", { state: "detached" });
    expect(await admin.page.locator("[data-changes-list] li").count()).toBe(n + 1);
    expect(await text(admin.page, "[data-changes-list]")).toContain("Auto QA");
    expect(await admin.page.evaluate(() => window.__saved.map((r) => r.name))).toEqual(["Auto QA"]);
    // There is no picker for an issue: changes are not linked to issues.
    await admin.page.locator('[aria-label="Edit Auto QA"]').click();
    expect(await admin.page.locator('[aria-label="Issue it fixes"]').count()).toBe(0);
    await admin.page.keyboard.press("Escape");
    // A bad one is refused in words.
    await admin.page.locator("[data-change-add]").click();
    await admin.page.locator("[data-change-name]").fill("");
    await admin.page.locator("[data-change-save]").click();
    expect(await text(admin.page, "[data-change-error]")).toBe("Give the change a name of up to 200 characters.");
    await admin.page.keyboard.press("Escape");
    // Edit it, then remove it.
    await admin.page.locator('[aria-label="Edit Auto QA"]').click();
    await admin.page.locator("[data-change-name]").fill("Auto QA two");
    await admin.page.locator("[data-change-save]").click();
    await admin.page.waitForSelector("[data-change-dialog]", { state: "detached" });
    expect(await text(admin.page, "[data-changes-list]")).toContain("Auto QA two");
    await admin.page.locator('[aria-label="Edit Auto QA two"]').click();
    await admin.page.locator("[data-change-remove]").click();
    await admin.page.waitForSelector("[data-change-dialog]", { state: "detached" });
    expect(await admin.page.locator("[data-changes-list] li").count()).toBe(n);
    expect(admin.errors).toEqual([]);
    await admin.page.close();

    const viewer = await mount({ viewer: true });
    await ready(viewer.page);
    expect(await viewer.page.locator("[data-changes-manage]").count()).toBe(0);
    expect(await viewer.page.locator("[data-change-add]").count()).toBe(0);
    expect(await viewer.page.getByRole("button", { name: /^Edit / }).count()).toBe(0);
    // A Viewer still plays: the levers work.
    await viewer.page.locator('[data-lever="add:org"]').fill("2");
    await settled(viewer.page);
    expect(await viewer.page.locator("[data-sandbox-play]").getAttribute("data-moved")).toBe("true");
    expect(viewer.errors).toEqual([]);
    await viewer.page.close();
  });

  it("hides DLER from someone who can't see pay, and still shows the rest", async () => {
    const { page, errors } = await mount({ payHidden: true });
    await ready(page);
    expect(await page.locator("[data-dler-hidden]").count()).toBe(1);
    expect(await verdictFirst(page)).not.toContain("DLER");
    expect(await page.locator("[data-play-chart]").count()).toBe(3);
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
        await page.locator('[data-lever="add:org"]').fill("2");
        await page.locator('[data-lever="add:perf"]').fill("1");
        await page.locator('[data-lever="addMonths"]').selectOption("6");
        await page.locator("[data-automation-switch]").first().click();
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
