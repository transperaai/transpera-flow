import { chromium, type Browser, type Page } from "playwright-core";
import { mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bundleHarness } from "./build-harness";

// The Processes page's layout in a real browser with the app's stylesheet (Q7): the header's two button groups, the toolbar row above
// the table, centred columns, a row menu that never wraps, and "Change type" choosing the category. With Q7_SHOTS=<dir> it also saves
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
  it("groups the header buttons: company map on the left, Upload process and New process on the right, one size", async () => {
    const { page, errors } = await mount({ canEdit: true, published: true });
    const group = page.getByRole("group", { name: "Company map" });
    expect(await group.getByRole("link").allInnerTexts()).toEqual(["Company map", "✎ Edit company map", "History"]);
    const actions = page.locator("[data-page-actions]");
    expect(await actions.locator("[data-slot=button]").allInnerTexts()).toEqual(["Upload process", "✎ New process"]);
    const g = (await group.boundingBox())!;
    const a = (await actions.boundingBox())!;
    expect(g.x + g.width).toBeLessThanOrEqual(a.x);
    expect(Math.abs(g.y - a.y)).toBeLessThan(8);
    const heights = await page.locator("[data-processes-actions] [data-slot=button]").evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().height)));
    expect(new Set(heights).size).toBe(1);
    expect(await page.locator("[data-edit-company-map]").evaluate((e) => getComputedStyle(e).backgroundColor)).not.toBe(await group.getByRole("link", { name: "History" }).evaluate((e) => getComputedStyle(e).backgroundColor));
    expect(errors).toEqual([]);
    await page.close();
  });

  it("shows Edit only to editors and History only once published", async () => {
    for (const [canEdit, published, links] of [
      [false, true, ["Company map", "History"]],
      [true, false, ["✎ Edit company map"]],
    ] as const) {
      const { page } = await mount({ canEdit, published });
      expect(await page.getByRole("group", { name: "Company map" }).getByRole("link").allInnerTexts()).toEqual([...links]);
      await page.close();
    }
  });

  it("keeps the In use / Archived switch and the category filter on one toolbar line at 1440 px, above the table", async () => {
    const { page } = await mount({ canEdit: true, published: true });
    const view = (await box(page, '[role=group][aria-label="Show"]'))!;
    const type = (await box(page, '[role=group][aria-label="Type"]'))!;
    const table = (await box(page, "table"))!;
    expect(Math.abs(view.y - type.y)).toBeLessThan(4);
    expect(view.height).toBeCloseTo(type.height, 0);
    expect(view.x + view.width).toBeLessThan(type.x);
    expect(type.y + type.height).toBeLessThan(table.y);
    const header = (await box(page, "header:has(h1)"))!;
    expect(view.y).toBeGreaterThan(header.y + header.height + 8);
    await page.close();
  });

  it("pins the company map's row at the top (Q16): outside the category filter, with its version, a draft pill, and History, Edit and Open", async () => {
    const { page, errors } = await mount({ canEdit: true, published: true });
    expect(await page.locator("tbody tr").first().getAttribute("data-company-row")).not.toBeNull();
    const row = page.locator("[data-company-row]");
    expect(await row.locator("td").nth(1).innerText()).toMatch(/^Company map\s+Draft open$/);
    expect(await row.locator("td").nth(2).innerText()).toBe("Company");
    expect(await row.locator("[data-company-version]").innerText()).toMatch(/^Version 4 · /);
    expect(await row.locator("[data-company-actions] a").allInnerTexts()).toEqual(["History", "Edit", "Open→"]);
    await page.getByRole("button", { name: /^Sales/ }).click();
    expect(await page.locator("[data-company-row]").count()).toBe(1);
    const reader = await mount({ canEdit: false, published: true });
    expect(await reader.page.locator("[data-company-row] [data-company-actions] a").allInnerTexts()).toEqual(["History", "Open→"]);
    expect(errors).toEqual([]);
    await page.close();
    await reader.page.close();
  });

  it("centres every column but Process and Type", async () => {
    const { page } = await mount({ canEdit: true, published: true });
    const heads = await page.locator("thead th").evaluateAll((els) => els.map((e) => [e.textContent!.trim(), getComputedStyle(e).textAlign] as const));
    for (const [text, align] of heads) expect(align, text || "(blank)").toBe(text.startsWith("Process") || text.startsWith("Type") ? "left" : "center");
    const row = await page.locator("[data-process]").first().locator("td").evaluateAll((els) => els.map((e) => getComputedStyle(e).textAlign));
    // chevron, Process, Type, Steps, Open issues, Live version, menu, Open
    expect(["left", "start"]).toContain(row[1]);
    expect(row[2]).toBe("left");
    expect(row.slice(3)).toEqual(["center", "center", "center", "center", "center"]);
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
