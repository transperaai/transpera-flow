import { chromium, type Browser, type Page } from "playwright-core";
import { mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bundleHarness } from "./build-harness";

// The Processes page's layout in a real browser with the app's stylesheet (Q7; the ListPage of docs/plans/ui-cleanup.md): one primary
// action in the header, a toolbar row (search, Type, count, In use / Archived) above one table surface, numbers right-aligned, the
// company map's buttons on one line, and a row menu that never wraps. With Q7_SHOTS=<dir> it also saves
// the screenshots (1440 and 400 px, and the Change type dialog).

let browser: Browser;
let script: string;
let css = "";

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
  [script, css] = await Promise.all([bundleHarness(new URL("./processes-layout-harness/entry.tsx", import.meta.url)), appCss()]);
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
}, 180_000);

afterAll(async () => {
  await browser?.close();
});

async function mount(opts: { canEdit: boolean; published: boolean }, width = 1440): Promise<{ page: Page; errors: string[] }> {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.setContent(`<style>${css}</style><div id="root"></div>`);
  await page.addScriptTag({ content: script });
  await page.evaluate((o) => window.mountProcessesLayout(o), opts);
  await page.waitForSelector("[data-process]");
  await page.evaluate(() => document.fonts.ready);
  return { page, errors };
}

const box = (page: Page, sel: string) => page.locator(sel).first().boundingBox();

describe("layout", () => {
  it("has one primary action, New process; Company map, Edit company map, History and Upload process are outline buttons of one size", async () => {
    const { page, errors } = await mount({ canEdit: true, published: true });
    const group = page.getByRole("group", { name: "Company map" });
    expect(await group.getByRole("link").allInnerTexts()).toEqual(["Company map", "Edit company map", "History"]);
    const buttons = page.locator("[data-page-actions] [data-slot=button]");
    expect(await buttons.allInnerTexts()).toEqual(["Company map", "Edit company map", "History", "Upload process", "New process"]);
    expect(await buttons.evaluateAll((els) => els.map((e) => e.getAttribute("data-variant")))).toEqual(["outline", "outline", "outline", "outline", "default"]);
    const heights = await buttons.evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().height)));
    expect(new Set(heights).size).toBe(1);
    // Purple only marks the button that opens the Editor; the button itself is not purple.
    expect(await page.locator("[data-edit-company-map] [data-edit-marker]").count()).toBe(1);
    expect(await page.locator("[data-edit-company-map]").evaluate((e) => getComputedStyle(e).backgroundColor)).toBe(await group.getByRole("link", { name: "History" }).evaluate((e) => getComputedStyle(e).backgroundColor));
    expect(errors).toEqual([]);
    await page.close();
  });

  it("shows Edit only to editors and History only once published", async () => {
    for (const [canEdit, published, links] of [
      [false, true, ["Company map", "History"]],
      [true, false, ["Edit company map"]],
    ] as const) {
      const { page } = await mount({ canEdit, published });
      expect(await page.getByRole("group", { name: "Company map" }).getByRole("link").allInnerTexts()).toEqual([...links]);
      await page.close();
    }
  });

  it("keeps search, the Type filter, the count and the In use / Archived toggle on one toolbar line at 1440 px, between the header and the table", async () => {
    const { page } = await mount({ canEdit: true, published: true });
    const bar = (await box(page, "[data-list-toolbar]"))!;
    expect(bar.height).toBeLessThan(50);
    const search = (await box(page, "[data-toolbar-search]"))!;
    const type = (await box(page, "[data-filter=type]"))!;
    const view = (await box(page, '[role=radiogroup][aria-label="Show"]'))!;
    expect(search.x + search.width).toBeLessThan(type.x);
    expect(type.x + type.width).toBeLessThan(view.x);
    expect(await page.locator("[data-process-count]").innerText()).toBe("6 processes");
    const header = (await box(page, "[data-page-header]"))!;
    const table = (await box(page, "[data-list-surface]"))!;
    expect(bar.y).toBeGreaterThan(header.y + header.height);
    expect(bar.y + bar.height).toBeLessThan(table.y);
    // One bordered surface, not a card around a card.
    expect(await page.locator("[data-list-surface] [data-slot=card]").count()).toBe(0);
    await page.close();
  });

  it("filters by Type and by search, and says how many show", async () => {
    const { page } = await mount({ canEdit: true, published: true });
    await page.locator("[data-filter=type]").click();
    await page.locator("[data-filter-menu=type] [data-option=sales]").check();
    await page.keyboard.press("Escape");
    expect(await page.locator("[data-process]").count()).toBe(1);
    expect(await page.locator("[data-process-count]").innerText()).toBe("1 of 6 processes");
    await page.locator("[data-clear-filters]").click();
    await page.getByRole("searchbox", { name: "Search processes" }).fill("review");
    expect(await page.locator("[data-process] td:nth-child(2)").allInnerTexts()).toEqual(["Creative review"]);
    await page.close();
  });

  it("pins the company map's row at the top (Q16): outside the filters, with its version, a draft pill, and History, Edit and Open on one line", async () => {
    const { page, errors } = await mount({ canEdit: true, published: true });
    expect(await page.locator("tbody tr").first().getAttribute("data-company-row")).not.toBeNull();
    const row = page.locator("[data-company-row]");
    expect(await row.locator("td").nth(1).innerText()).toMatch(/^Company map\s+Draft open$/);
    expect(await row.locator("td").nth(2).innerText()).toBe("Company");
    expect(await row.locator("[data-company-version]").innerText()).toMatch(/^Version 4 · /);
    const actions = row.locator("[data-company-actions] a");
    expect((await actions.allInnerTexts()).map((t) => t.trim())).toEqual(["History", "Edit", "Open"]);
    const tops = await actions.evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().top)));
    expect(new Set(tops).size).toBe(1);
    await page.locator("[data-filter=type]").click();
    await page.locator("[data-filter-menu=type] [data-option=sales]").check();
    await page.keyboard.press("Escape");
    expect(await page.locator("[data-company-row]").count()).toBe(1);
    const reader = await mount({ canEdit: false, published: true });
    expect((await reader.page.locator("[data-company-row] [data-company-actions] a").allInnerTexts()).map((t) => t.trim())).toEqual(["History", "Open"]);
    expect(errors).toEqual([]);
    await page.close();
    await reader.page.close();
  });

  it("right-aligns the numbers and keeps the text columns left", async () => {
    const { page } = await mount({ canEdit: true, published: true });
    const heads = await page.locator("thead th").evaluateAll((els) => els.map((e) => [e.textContent!.trim(), getComputedStyle(e).textAlign] as const));
    for (const [text, align] of heads) {
      if (text.startsWith("Steps") || text.startsWith("Open issues")) expect(align, text).toBe("right");
      else if (text) expect(align, text).toBe("left");
    }
    // The header row sticks under the shell's bar.
    expect(await page.locator("thead").evaluate((e) => getComputedStyle(e).position)).toBe("sticky");
    // Every column shows at 1280 px.
    await page.setViewportSize({ width: 1280, height: 900 });
    expect(await page.locator("thead th").evaluateAll((els) => els.every((e) => getComputedStyle(e).display !== "none"))).toBe(true);
    await page.close();
  });

  it("draws the archived list with the same table", async () => {
    const { page } = await mount({ canEdit: true, published: true });
    await page.getByRole("radio", { name: "Archived (1)" }).click();
    expect(await page.locator("[data-list-surface] table[aria-label='Archived processes'] thead").count()).toBe(1);
    expect(await page.locator("[data-archived-process]").count()).toBe(1);
    await page.close();
  });

  it("opens a row menu wide enough that no item wraps", async () => {
    const { page } = await mount({ canEdit: true, published: true });
    await page.getByRole("button", { name: "Change Monthly reporting" }).click();
    const items = page.getByRole("menuitem");
    expect(await items.allInnerTexts()).toEqual(["Rename…", "Change type…", "Archive…"]);
    const heights = await items.evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height));
    expect(Math.max(...heights)).toBeLessThan(36);
    expect(await items.evaluateAll((els) => els.every((e) => e.scrollWidth <= e.clientWidth))).toBe(true);
    expect(await page.getByRole("menu").evaluate((e) => e.getBoundingClientRect().width)).toBeGreaterThanOrEqual(150);
    await page.close();
  });

  it("wraps the header and toolbar at 400 px without scrolling the page sideways", async () => {
    const { page } = await mount({ canEdit: false, published: true }, 400);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.close();
  });
});

const shots = process.env.Q7_SHOTS;
describe("screenshots", () => {
  it.skipIf(!shots)("saves the Processes page at 1440 and 400 px, and the Change type dialog", async () => {
    mkdirSync(shots!, { recursive: true });
    const prefix = process.env.Q7_SHOTS_PREFIX ?? "after";
    for (const width of [1440, 400]) {
      const { page } = await mount({ canEdit: true, published: true }, width);
      await page.screenshot({ path: `${shots}/${prefix}-processes-${width}.png`, fullPage: true });
      await page.close();
    }
    const { page } = await mount({ canEdit: true, published: true });
    await page.getByRole("button", { name: "Change Monthly reporting" }).click();
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${shots}/${prefix}-row-menu-1440.png` });
    await page.getByRole("menuitem", { name: /Change type/ }).click();
    await page.waitForSelector("[role=dialog]");
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${shots}/${prefix}-change-type-1440.png` });
    await page.close();
  }, 120_000);
});
