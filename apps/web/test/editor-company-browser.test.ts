import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bundleHarness } from "./build-harness";

// The company map's Editor has the same palette and right-click menu as a process's (QA round 2, item 7): + Step, + Wait and + Decision, with
// + Process for the process library and no templates; a card that links to a process is removed from the map, not deleted, and can't be renamed
// or copied. Demo mode, so edits stay in the tab.

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

async function open(): Promise<{ page: Page; errors: string[] }> {
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 1000 } })).newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.route(ORIGIN, (route) => route.fulfill({ contentType: "text/html", body: `<!doctype html><meta name="viewport" content="width=device-width"><div id="root"></div>` }));
  await page.goto(ORIGIN);
  await page.addScriptTag({ content: script });
  await page.evaluate(() => window.mountEditor({ userId: "user-a", dismissed: true, company: true }));
  await page.waitForSelector(".react-flow__node");
  return { page, errors };
}

describe("the company map's Editor", { timeout: 120_000 }, () => {
  it("adds steps, waits and decisions like a process, and opens the process library from + Process", async () => {
    const { page, errors } = await open();
    const palette = page.locator('aside[aria-label="Palette"]');
    for (const name of ["+ Step", "+ Wait", "+ Decision", "+ Process"]) expect(await palette.getByRole("button", { name, exact: true }).count(), name).toBe(1);
    expect(await palette.locator("[data-process-library]").count()).toBe(1);
    expect(await palette.innerText()).not.toMatch(/From a template/);
    const before = await page.locator(".react-flow__node").count();
    await palette.getByRole("button", { name: "+ Step", exact: true }).click();
    await expect.poll(() => page.locator(".react-flow__node").count()).toBe(before + 1);
    // + Process folds the library away and back.
    await palette.getByRole("button", { name: "+ Process", exact: true }).click();
    expect(await palette.locator("[data-process-library]").count()).toBe(0);
    expect(errors).toEqual([]);
    await page.close();
  });

  it("draws a decision as a card with a dot per branch and a + dot, as on a process's map (round 2, item 12)", async () => {
    const { page, errors } = await open();
    const palette = page.locator('aside[aria-label="Palette"]');
    await palette.getByRole("button", { name: "+ Decision", exact: true }).click();
    const card = page.locator('[data-tile="decision"]');
    await expect.poll(() => card.count()).toBe(1);
    expect(await card.locator('.react-flow__handle[data-handleid="add-branch"]').count()).toBe(1);
    expect(errors).toEqual([]);
    await page.close();
  });

  it("gives a process card the menu of a link: remove from this map, no rename, copy or change of kind", async () => {
    const { page, errors } = await open();
    // A card that links to a process (the company map's cards all do).
    const card = page.locator(".react-flow__node").first();
    await card.waitFor({ state: "visible" });
    const menu = page.getByRole("menu");
    // On a slow machine the map may still be laying out on the first right-click, so try again until the menu opens.
    await expect
      .poll(
        async () => {
          const box = (await card.boundingBox())!;
          await card.dispatchEvent("contextmenu", { clientX: box.x + 20, clientY: box.y + 10, button: 2 });
          return menu.isVisible();
        },
        { timeout: 20_000, interval: 500 },
      )
      .toBe(true);
    const items = await menu.getByRole("menuitem").allInnerTexts();
    expect(items.join(" | ")).toMatch(/Remove from this map/);
    expect(items.join(" | ")).not.toMatch(/Rename|Change kind/);
    expect(await menu.getByRole("menuitem", { name: /^Copy/ }).getAttribute("aria-disabled")).toBe("true");
    expect(errors).toEqual([]);
    await page.close();
  });
});
