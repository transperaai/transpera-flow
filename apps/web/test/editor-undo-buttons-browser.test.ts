import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bundleHarness } from "./build-harness";

// The undo and redo buttons in the real Editor's bar (demo mode, so edits stay in the tab): disabled with nothing to do, titled with the
// edit they step over, and they do what the keys do.

let browser: Browser;
let script: string;
const ORIGIN = "https://editor.test/";

beforeAll(async () => {
  script = await bundleHarness(new URL("./tour-harness/entry.tsx", import.meta.url));
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
}, 120_000);

afterAll(async () => {
  await browser?.close();
});

async function open(width: number): Promise<{ page: Page; errors: string[] }> {
  const context = await browser.newContext({ viewport: { width, height: 900 } });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.route(ORIGIN, (route) => route.fulfill({ contentType: "text/html", body: `<!doctype html><meta name="viewport" content="width=device-width"><div id="root"></div>` }));
  await page.goto(ORIGIN);
  await page.addScriptTag({ content: script });
  await page.evaluate(() => window.mountEditor({ userId: "user-a", dismissed: true }));
  await page.waitForSelector("[data-editor]");
  await page.waitForSelector(".react-flow__node");
  return { page, errors };
}

const undo = (page: Page) => page.locator("[data-undo]");
const redo = (page: Page) => page.locator("[data-redo]");

describe("undo and redo buttons in the editor bar", { timeout: 120_000 }, () => {
  it("are disabled with nothing to undo, are titled with the edit, and step through it", async () => {
    const { page, errors } = await open(1440);
    expect(await undo(page).isDisabled()).toBe(true);
    expect(await redo(page).isDisabled()).toBe(true);

    await page.getByRole("button", { name: "+ Step", exact: true }).click();
    await page.waitForFunction(() => document.querySelector("[data-undo]:not([disabled])"));
    const label = (await undo(page).getAttribute("title"))!;
    expect(label).toMatch(/^Undo: Added /);
    expect(await undo(page).getAttribute("aria-label")).toBe(label);
    expect(await redo(page).isDisabled()).toBe(true);
    const count = await page.locator(".react-flow__node").count();

    await undo(page).click();
    await page.waitForFunction((n) => document.querySelectorAll(".react-flow__node").length < n, count);
    expect(await undo(page).isDisabled()).toBe(true);
    expect(await redo(page).getAttribute("title")).toBe(label.replace("Undo:", "Redo:"));

    await redo(page).click();
    await page.waitForFunction((n) => document.querySelectorAll(".react-flow__node").length === n, count);
    expect(await redo(page).isDisabled()).toBe(true);
    expect(await undo(page).isDisabled()).toBe(false);
    expect(errors).toEqual([]);
    await page.close();
  });

  it("leave the map alone while a dialog is open: mod+z with the tour showing undoes nothing", async () => {
    const { page, errors } = await open(1440);
    await page.getByRole("button", { name: "+ Step", exact: true }).click();
    await page.waitForFunction(() => document.querySelector("[data-undo]:not([disabled])"));
    const count = await page.locator(".react-flow__node").count();
    await page.getByRole("button", { name: "Take the tour" }).click();
    await page.locator("[data-tour-card]").waitFor();
    await page.keyboard.press("ControlOrMeta+z");
    await page.waitForTimeout(100);
    expect(await page.locator(".react-flow__node").count()).toBe(count);
    expect(await undo(page).isDisabled()).toBe(false);
    // With the tour closed the same keys undo again.
    await page.keyboard.press("Escape");
    await page.locator("[data-tour-card]").waitFor({ state: "detached" });
    await page.locator("[data-process-map]").focus();
    await page.keyboard.press("ControlOrMeta+z");
    await page.waitForFunction((n) => document.querySelectorAll(".react-flow__node").length < n, count);
    expect(errors).toEqual([]);
    await page.close();
  });
});
