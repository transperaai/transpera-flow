import { build } from "esbuild";
import { chromium, type Browser, type Page } from "playwright-core";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { partOf } from "@transpera-flow/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { demoBundle } from "@/lib/sources/demo";

// The Overview in a real browser (issue #173, B15): Play on the company map moves the work and counts it on the process
// cards, the horizon picker runs the model again for the length picked, and the findings rows open and close. React Flow
// and the playback layer measure the DOM, so none of this can be seen in a unit test. The page is the harness in
// ./overview-harness bundled by esbuild, with just enough CSS for its layout.

let browser: Browser;
let script: string;
let css: string;

const LAYOUT_CSS = `
  body { margin: 0; font: 14px sans-serif; }
  .absolute { position: absolute } .relative { position: relative } .inset-0 { inset: 0 } .flex { display: flex } .flex-col { flex-direction: column }
  .flex-1 { flex: 1 1 0% } .min-h-0 { min-height: 0 } .h-full { height: 100% } .w-full { width: 100% } .hidden { display: none }
  .z-10 { z-index: 10 } .bottom-2\\.5 { bottom: 10px } .left-2\\.5 { left: 10px } .right-2\\.5 { right: 10px } .top-2\\.5 { top: 10px }
  .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0) }
  .playback-badge { position: absolute; font-size: 11px; }
`;

const parts = (() => {
  const live = demoBundle();
  return [partOf(live), ...(live.otherProcesses ?? [])];
})();

beforeAll(async () => {
  const out = await build({
    entryPoints: [fileURLToPath(new URL("./overview-harness/entry.tsx", import.meta.url))],
    bundle: true,
    format: "iife",
    platform: "browser",
    write: false,
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' },
    alias: { "@": fileURLToPath(new URL("../src", import.meta.url)) },
    logLevel: "silent",
  });
  script = out.outputFiles[0]!.text;
  css = readFileSync(createRequire(import.meta.url).resolve("@xyflow/react/dist/style.css"), "utf8");
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
}, 120_000);

afterAll(async () => {
  await browser?.close();
});

async function mount(): Promise<{ page: Page; errors: string[] }> {
  const page = await browser.newPage({ viewport: { width: 1300, height: 1400 } });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.setContent(`<style>${css}${LAYOUT_CSS}</style><div id="root"></div>`);
  await page.addScriptTag({ content: script });
  await page.evaluate(() => window.mountOverview());
  await page.waitForSelector(".react-flow__node");
  return { page, errors };
}

/** The playback badges showing now: the card each sits on (by the node under it) and its text. */
const shownBadges = (page: Page) =>
  page.locator(".playback-badge").evaluateAll((els) => els.filter((e) => (e as HTMLElement).style.display !== "none" && e.textContent).map((e) => e.textContent!));

describe("the Overview's company map", () => {
  it("plays the work: Play starts the clock, and items are counted on the closed process cards", async () => {
    const { page, errors } = await mount();
    const slider = page.locator('input[type="range"]');
    await page.getByRole("button", { name: "Play", exact: true }).click();
    // Real time passes: wait for the clock to move and for counts to appear.
    await page.waitForFunction(() => Number((document.querySelector('input[type="range"]') as HTMLInputElement).value) > 0, null, { timeout: 30_000 });
    await page.waitForFunction(() => [...document.querySelectorAll<HTMLElement>(".playback-badge")].some((b) => b.style.display !== "none" && b.textContent), null, { timeout: 30_000 });
    const badges = await shownBadges(page);
    expect(badges.length).toBeGreaterThan(0);
    for (const b of badges) expect(b).toMatch(/\d+ (queued|active|waiting)/);
    // Every card drawn is a whole process (all closed): the counts are the processes' own, rolled up.
    expect((await page.locator(".react-flow__node").count())).toBe(parts.length);
    expect(Number(await slider.inputValue())).toBeGreaterThan(0);
    await page.getByRole("button", { name: "Pause", exact: true }).click();
    await expect.poll(() => page.getByRole("button", { name: "Play", exact: true }).count()).toBe(1);
    expect(errors).toEqual([]);
    await page.close();
  }, 90_000);

  it("the horizon picker runs the model again for the length picked, and playback covers it", async () => {
    const { page, errors } = await mount();
    const max = () => page.locator('input[type="range"]').getAttribute("max");
    expect(await page.getByRole("button", { name: "3 months" }).getAttribute("aria-pressed")).toBe("true");
    const before = Number(await max());
    expect(before).toBeCloseTo(13 * 40, 0);
    await page.getByRole("button", { name: "12 months" }).click();
    await page.waitForFunction(() => document.querySelector("[data-horizon-note]")?.textContent === "Playing 12 months of work", null, { timeout: 60_000 });
    await expect.poll(max, { timeout: 30_000 }).toBe(String(52 * 40));
    expect(await page.getByRole("button", { name: "12 months" }).getAttribute("aria-pressed")).toBe("true");
    expect(await page.evaluate(() => window.runs)).toEqual([13, 52]);
    // Playing the longer run moves the clock too.
    await page.getByRole("button", { name: "Play", exact: true }).click();
    await page.waitForFunction(() => Number((document.querySelector('input[type="range"]') as HTMLInputElement).value) > 0, null, { timeout: 30_000 });
    expect(errors).toEqual([]);
    await page.close();
  }, 120_000);

  it("opening a process card while playing keeps counting, on the steps now drawn", async () => {
    const { page, errors } = await mount();
    await page.getByRole("button", { name: "Expand" }).first().click();
    await page.waitForFunction((n) => document.querySelectorAll(".react-flow__node").length > n, parts.length, { timeout: 30_000 });
    await page.getByRole("button", { name: "Play", exact: true }).click();
    await page.waitForFunction(() => [...document.querySelectorAll<HTMLElement>(".playback-badge")].some((b) => b.style.display !== "none" && b.textContent), null, { timeout: 30_000 });
    expect((await shownBadges(page)).length).toBeGreaterThan(0);
    expect(errors).toEqual([]);
    await page.close();
  }, 90_000);
});

describe("the Overview's findings by process", () => {
  it("opens a row to show all of its findings, and closes it again", async () => {
    const { page, errors } = await mount();
    const rows = page.locator("[data-findings-group]");
    await expect.poll(() => rows.count()).toBe(parts.length + 1);
    expect(await rows.first().getAttribute("data-findings-group")).toBe("company");
    expect(await page.locator("[data-findings-panel]").count()).toBe(0);
    const lead = page.locator(`[data-findings-group="${parts[0]!.process.id}"]`);
    const toggle = lead.locator("button[aria-expanded]");
    await toggle.click();
    await lead.locator("[data-findings-panel]").waitFor();
    expect(await toggle.getAttribute("aria-expanded")).toBe("true");
    expect(await lead.locator("[data-rendered] li").count()).toBeGreaterThan(0);
    // Only that row opened.
    expect(await page.locator("[data-findings-panel]").count()).toBe(1);
    await toggle.click();
    await lead.locator("[data-findings-panel]").waitFor({ state: "detached" });
    expect(await toggle.getAttribute("aria-expanded")).toBe("false");
    expect(errors).toEqual([]);
    await page.close();
  }, 60_000);
});
