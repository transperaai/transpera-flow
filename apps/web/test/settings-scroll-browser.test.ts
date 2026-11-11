import { chromium, type Browser } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bundleHarness } from "./build-harness";

// Settings is one scrolling page (the Settings page as page.tsx composes it, from ./q11b-shots-harness/entry.tsx): eight sections in the
// sub-nav's order, each a heading band with its anchor, and the sub-nav marks the section in view as the page scrolls.

let browser: Browser;
let script: string;
const META = { "import.meta.url": JSON.stringify("http://harness.test/src/lib/x/") };
const ORDER = ["workspace", "simulation", "purposes", "churn-drivers", "demand", "tiers-clients", "people-roles", "access"];

beforeAll(async () => {
  script = await bundleHarness(new URL("./q11b-shots-harness/entry.tsx", import.meta.url), META, { navigation: "navigation-url.ts" });
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
}, 120_000);

afterAll(async () => {
  await browser?.close();
});

describe("Settings as one scrolling page", { timeout: 120_000 }, () => {
  it("renders the eight bands in order, each an h2 region with a description, and the sub-nav links to each", async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.setContent(`<div id="root"></div>`);
    await page.addScriptTag({ content: script });
    await page.evaluate(() => window.mountQ11b("settings"));
    await page.waitForSelector("[data-settings-band=access]");
    expect(await page.locator("[data-settings-band]").evaluateAll((els) => els.map((e) => e.id))).toEqual(ORDER);
    for (const id of ORDER) {
      const band = page.locator(`#${id}`);
      expect(await band.getAttribute("role"), id).toBe("region");
      expect(await band.locator(`> header h2#${id}-heading`).count(), id).toBe(1);
      expect(await band.locator("> header p").count(), id).toBe(1);
    }
    const nav = page.locator("[data-settings-nav] a");
    expect(await nav.evaluateAll((as) => as.map((a) => a.getAttribute("href")))).toEqual(ORDER.map((id) => `/w/northbeam/settings#${id}`));
    // The cards inside are a level down from the bands.
    expect(await page.locator("#people-heading").getAttribute("aria-level")).toBe("3");
    expect(errors).toEqual([]);
    await page.close();
  });

  it("marks the section in view as the page scrolls, and the last one at the end", async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.setContent(`<div id="root"></div>`);
    await page.addScriptTag({ content: script });
    await page.evaluate(() => window.mountQ11b("settings"));
    await page.waitForSelector("[data-settings-band=access]");
    const current = () => page.locator('[data-settings-nav] a[aria-current="location"]').innerText();
    await expect.poll(current).toBe("Workspace");
    for (const [id, label] of [["demand", "Demand"], ["tiers-clients", "Tiers & clients"], ["people-roles", "People & roles"]] as const) {
      await page.evaluate((i) => document.getElementById(i)!.scrollIntoView(), id);
      await expect.poll(current, { message: id }).toBe(label);
    }
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await expect.poll(current).toBe("Access");
    await page.close();
  });
});
