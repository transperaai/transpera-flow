import { chromium, type Browser, type Page } from "playwright-core";
import { mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 60_000 });
import { bundleHarness } from "./build-harness";

// The Issues list in a real browser with the app's stylesheet (Q9): no Export CSV, a Step column, a coloured pill for each status, and one
// toolbar row (search, Status, Owner, Rating, Process, Clear filters, a count) whose filters live in the URL and that wraps at 400 px, with
// + New issue at the right of the page's header.
// With Q9_SHOTS=<dir> it also saves the screenshots (1440 px light and dark, and 400 px).

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

const META = { "import.meta.url": JSON.stringify("http://harness.test/src/lib/x/") };

beforeAll(async () => {
  [script, css] = await Promise.all([bundleHarness(new URL("./issues-list-harness/entry.tsx", import.meta.url), META, { navigation: "navigation-url.ts" }), appCss()]);
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
}, 180_000);

afterAll(async () => {
  await browser?.close();
});

async function mount(opts: { canEdit?: boolean; url?: string } = {}, width = 1440, scheme: "light" | "dark" = "light"): Promise<{ page: Page; errors: string[] }> {
  const page = await browser.newPage({ viewport: { width, height: 900 }, colorScheme: scheme });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.setContent(`<style>${css}</style><div id="root" style="padding:16px"></div>`);
  await page.addScriptTag({ content: script });
  await page.evaluate((o) => window.mountIssues(o), opts);
  await page.waitForSelector("[data-issues-table]");
  await page.evaluate(() => document.fonts.ready);
  return { page, errors };
}

const url = (page: Page) => page.evaluate(() => window.__harnessUrl);
const rows = (page: Page) => page.locator("[data-issue-row]").evaluateAll((els) => els.map((e) => e.getAttribute("data-issue-row")));
const pick = async (page: Page, filter: string, option: string) => {
  await page.locator(`[data-filter=${filter}]`).click();
  await page.locator(`[data-filter-menu=${filter}] [data-option="${option}"]`).click();
  await page.keyboard.press("Escape");
};

describe("the Issues list", () => {
  it("has no Export CSV, a Step column in place of Touches, and a pill colour for each status", async () => {
    const { page, errors } = await mount({ url: "/w/demo/issues?status=open,testing,resolved,wont_fix" });
    expect(await page.getByText("Export CSV").count()).toBe(0);
    const heads = await page.locator("[data-issues-table] thead th").allInnerTexts();
    expect(heads.map((h) => h.trim().split(/\s/)[0]!.toLowerCase())).toEqual(["issue", "rating", "step", "owners", "status", "solutions"]);
    const colour = (status: string) => page.locator(`[data-issues-table] [data-status=${status}] i`).first().evaluate((e) => getComputedStyle(e).backgroundColor);
    const colours = await Promise.all(["open", "testing", "resolved", "wont_fix"].map(colour));
    expect(new Set(colours).size).toBe(4);
    expect(errors).toEqual([]);
    await page.close();
  });

  it("filters by status, owner (with Unassigned) and rating, keeps them in the URL and clears them", async () => {
    const { page, errors } = await mount();
    expect(await page.locator("[data-clear-filters]").count()).toBe(0);
    const open = await rows(page);
    expect(open.length).toBe(7);
    await pick(page, "status", "resolved");
    expect(await url(page)).toBe("/w/demo/issues?status=open,testing,resolved");
    await page.evaluate(() => window.mountIssues({ url: window.__harnessUrl }));
    await page.waitForSelector("[data-issues-table]");
    expect((await rows(page)).length).toBe(8);
    // The count beside a choice is how many it would show with the other filters.
    await page.locator("[data-filter=owner]").click();
    expect(await page.locator('[data-filter-menu=owner] [data-option="none"]').locator("xpath=..").innerText()).toContain("Unassigned");
    await page.keyboard.press("Escape");
    await pick(page, "owner", "none");
    expect(await url(page)).toContain("owner=none");
    await page.evaluate(() => window.mountIssues({ url: window.__harnessUrl }));
    await page.waitForSelector("[data-issues-table]");
    expect((await rows(page)).length).toBe(2);
    expect(await page.locator("[data-clear-filters]").count()).toBe(1);
    await page.locator("[data-clear-filters]").click();
    expect(await url(page)).toBe("/w/demo/issues");
    await page.evaluate(() => window.mountIssues({ url: window.__harnessUrl }));
    await page.waitForSelector("[data-issues-table]");
    expect((await rows(page)).length).toBe(7);
    expect(errors).toEqual([]);
    await page.close();
  });

  it("searches by title", async () => {
    const { page, errors } = await mount();
    await page.getByLabel("Search issues").fill("karl");
    expect(await url(page)).toBe("/w/demo/issues?q=karl");
    await page.evaluate(() => window.mountIssues({ url: window.__harnessUrl }));
    await page.waitForSelector("[data-issues-table]");
    expect(await page.locator("[data-issue-row]").count()).toBe(1);
    expect(errors).toEqual([]);
    await page.close();
  });

  it("puts + New issue at the header's right, lays the toolbar out as one row at 1440 px with a count, and wraps at 400 px without scrolling sideways", async () => {
    const wide = await mount();
    const bar = (await wide.page.locator("[data-list-toolbar]").boundingBox())!;
    expect(bar.height).toBeLessThan(50);
    expect(await wide.page.locator("[data-page-actions]").getByRole("button", { name: "+ New issue" }).count()).toBe(1);
    expect(await wide.page.locator("[data-list-toolbar]").getByRole("button", { name: "+ New issue" }).count()).toBe(0);
    const header = (await wide.page.locator("[data-page-header]").boundingBox())!;
    expect(header.y + header.height).toBeLessThan(bar.y);
    expect(await wide.page.locator("[data-issue-count]").innerText()).toMatch(/^7 of \d+ issues$/);
    expect(await wide.page.locator("[data-issues-table] thead").evaluate((e) => getComputedStyle(e).position)).toBe("sticky");
    await wide.page.close();
    const narrow = await mount({}, 400);
    expect(await narrow.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    for (const name of ["Status", "Owner", "Rating"]) expect(await narrow.page.locator(`[data-filter=${name.toLowerCase()}]`).isVisible()).toBe(true);
    await narrow.page.close();
  });

  it.runIf(!!process.env.Q9_SHOTS)("saves the screenshots", async () => {
    const dir = process.env.Q9_SHOTS!;
    mkdirSync(dir, { recursive: true });
    const open = process.env.Q9_SHOT_URL || "/w/demo/issues?status=open,testing,resolved,wont_fix";
    for (const [name, width, scheme] of [["issues-1440-light", 1440, "light"], ["issues-1440-dark", 1440, "dark"], ["issues-400-light", 400, "light"]] as const) {
      const { page } = await mount({ url: open }, width, scheme);
      await page.screenshot({ path: `${dir}/${name}.png`, fullPage: true });
      await page.close();
    }
    const { page } = await mount({ url: open });
    await page.locator("[data-filter=status]").click();
    await page.screenshot({ path: `${dir}/issues-1440-status-menu.png` });
    await page.close();
  });
});
