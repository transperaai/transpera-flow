import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bundleHarness } from "./build-harness";

// The start page of a workspace with nothing published (issue #243), in a real browser: at 1280px an editor sees the buttons and
// New process opens its dialog; at 400px (a phone, read only) no edit control is visible, the notice says why, and the checklist
// links still work. A reader sees one sentence at either width.

let browser: Browser;
let script: string;

beforeAll(async () => {
  script = await bundleHarness(new URL("./start-overview-harness/entry.tsx", import.meta.url));
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
}, 120_000);

afterAll(async () => {
  await browser?.close();
});

async function mount(width: number, canEdit = true): Promise<{ page: Page; errors: string[] }> {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.setContent(`<div id="root"></div>`);
  // The harness loads no app stylesheet. `max-sm:hidden` (EDIT_ONLY) is the one rule the phone check needs, written as Tailwind emits it.
  await page.addStyleTag({ content: "@media (max-width: 639px) { .max-sm\\:hidden { display: none; } }" });
  await page.addScriptTag({ content: script });
  await page.evaluate((o) => window.mountStart(o), { canEdit });
  await page.waitForSelector("[data-start-overview]");
  return { page, errors };
}

const visibleEditEntries = (page: Page) => page.locator("[data-edit-entry]:visible").count();

describe("the start page at 1280px", () => {
  it("shows the three ways to build, and New process opens its dialog and makes one", async () => {
    const { page, errors } = await mount(1280);
    expect(await visibleEditEntries(page)).toBe(3);
    expect(await page.getByRole("button", { name: /New process/ }).isVisible()).toBe(true);
    expect(await page.getByRole("button", { name: "Upload process", exact: true }).isVisible()).toBe(true);
    const company = page.locator("[data-build-company-map]");
    expect(await company.isVisible()).toBe(true);
    expect(await company.getAttribute("href")).toBe("/w/acme/p/co1/edit?from=%2Fw%2Facme");
    expect(await page.locator("[data-phone-notice]").count()).toBe(0);

    await page.getByRole("button", { name: /New process/ }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Name").fill("Quote to cash");
    await dialog.getByRole("radio", { name: /Sales pipeline/ }).check();
    await dialog.getByRole("button", { name: /^Create/ }).click();
    await expect.poll(() => page.evaluate(() => window.created)).toEqual(["Quote to cash"]);
    expect(errors).toEqual([]);
    await page.close();
  }, 60_000);

  it("ticks the first checklist item and leaves the rest", async () => {
    const { page } = await mount(1280);
    expect(await page.locator("[data-setup-item]").evaluateAll((els) => els.map((e) => [e.getAttribute("data-setup-item"), e.hasAttribute("data-done")]))).toEqual([
      ["roles", true],
      ["people", false],
      ["clients", false],
      ["process", false],
      ["publish", false],
    ]);
    await page.close();
  }, 60_000);
});

describe("the start page at 400px", () => {
  it("shows no edit control, says why, and keeps the checklist links", async () => {
    const { page, errors } = await mount(400);
    await page.waitForSelector("[data-phone-notice]");
    expect(await visibleEditEntries(page)).toBe(0);
    // Each of the three is hidden by the phone rule itself, not by accident.
    expect(await page.locator("[data-edit-entry].max-sm\\:hidden").count()).toBe(3);
    expect(await page.getByRole("button", { name: /New process/ }).isVisible()).toBe(false);
    expect(await page.locator("[data-build-company-map]").isVisible()).toBe(false);
    expect(await page.locator("[data-phone-notice]").innerText()).toMatch(/^Read only on a phone\./);
    const links = page.locator("[data-setup-item] a");
    expect(await links.count()).toBe(5);
    for (let i = 0; i < 5; i++) expect(await links.nth(i).isVisible()).toBe(true);
    expect(errors).toEqual([]);
    await page.close();
  }, 60_000);
});

describe("the start page for a reader", () => {
  it.each([1280, 400])("is one sentence at %ipx, with nothing to press", async (width) => {
    const { page, errors } = await mount(width, false);
    expect(await page.locator("[data-start-overview]").innerText()).toContain("has nothing published yet");
    expect(await visibleEditEntries(page)).toBe(0);
    expect(await page.locator("[data-start-overview] button, [data-start-overview] a").count()).toBe(0);
    expect(errors).toEqual([]);
    await page.close();
  }, 60_000);
});
