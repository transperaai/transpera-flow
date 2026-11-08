import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bundleHarness } from "./build-harness";

// A step's time in the real Editor (demo mode, edits stay in the tab), entered one way (brainstorm round 2, item 10): "Usually … h" and a tick box
// "It varies" that opens Quickest / Usually / Longest. No "Time pattern" select and no "How much it varies" number.

let browser: Browser;
let script: string;
const ORIGIN = "https://editor.test/";
const AUDIT = "e0000000-0000-4000-8000-000000000003";

beforeAll(async () => {
  script = await bundleHarness(new URL("./tour-harness/entry.tsx", import.meta.url));
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
}, 120_000);

afterAll(async () => {
  await browser?.close();
});

async function open(): Promise<{ page: Page; errors: string[] }> {
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 1000 } })).newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.route(ORIGIN, (route) => route.fulfill({ contentType: "text/html", body: `<!doctype html><meta name="viewport" content="width=device-width"><div id="root"></div>` }));
  await page.goto(ORIGIN);
  await page.addScriptTag({ content: script });
  await page.evaluate(() => window.mountEditor({ userId: "user-a", dismissed: true }));
  await page.waitForSelector(".react-flow__node");
  await page.locator(".react-flow__pane").dispatchEvent("click");
  await page.locator(`.react-flow__node[data-id="${AUDIT}"]`).dispatchEvent("click");
  await page.locator('aside[aria-label="Inspector"]').waitFor();
  return { page, errors };
}

const work = (page: Page) => page.locator('[data-duration="work"]');

describe("a step's time, in the Editor", { timeout: 120_000 }, () => {
  it("is Usually plus It varies; ticking opens Quickest / Usually / Longest, unticking keeps the usual time", async () => {
    const { page, errors } = await open();
    const panel = page.locator('aside[aria-label="Inspector"]');
    expect(await panel.getByText("Time pattern").count()).toBe(0);
    expect(await panel.getByText("How much it varies").count()).toBe(0);
    const box = work(page).getByRole("checkbox");
    // The example's Audit & proposal is a range (6, 9, 12 h): ticked, with the three fields.
    expect(await box.isChecked()).toBe(true);
    for (const label of ["Quickest", "Usually", "Longest"]) expect(await work(page).getByLabel(label, { exact: true }).count(), label).toBe(1);
    expect(await work(page).getByLabel("Usually", { exact: true }).inputValue()).toBe("9");
    // Untick: one field, the usual time kept.
    await box.click();
    await expect.poll(async () => work(page).getByLabel("Quickest", { exact: true }).count()).toBe(0);
    expect(await work(page).getByLabel("Usually", { exact: true }).inputValue()).toBe("9");
    // Tick again: a range around it.
    await work(page).getByRole("checkbox").click();
    await expect.poll(async () => work(page).getByLabel("Longest", { exact: true }).count()).toBe(1);
    expect(Number(await work(page).getByLabel("Longest", { exact: true }).inputValue())).toBeGreaterThan(9);
    expect(errors).toEqual([]);
    await page.close();
  });
});
