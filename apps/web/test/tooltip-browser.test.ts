import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bundleHarness } from "./build-harness";
import { placeTip } from "@/components/ui/floating-tip";

// Hover pop-ups are never cut off by their widget (Q5). A chart tooltip and a help (i) bubble inside an `overflow: hidden`
// card that sits against the right and bottom of the window must be fully on screen and outside the card in the DOM.
// The page is the harness in ./tooltip-harness, with just enough CSS for the classes the pop-ups use.

let browser: Browser;
let script: string;

const CSS = `
  :root { --rate-risk: #c00; --rate-bad: #e80; --rate-good: #0a0; --rate-great: #080; --accent: #06c; --line: #ddd; --fg-3: #888; --panel: #fff }
  body { margin: 0; font: 14px sans-serif; }
  .fixed { position: fixed } .top-0 { top: 0 } .left-0 { left: 0 } .pointer-events-none { pointer-events: none } .w-max { width: max-content }
  .max-w-56 { max-width: 14rem } .max-w-64 { max-width: 16rem } .w-72 { width: 18rem } .z-50 { z-index: 50 } .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0) }
  .relative { position: relative } .flex { display: flex } .items-center { align-items: center } .gap-4 { gap: 16px } .flex-col { flex-direction: column } .block { display: block }
  [data-chart-tip], [data-slot=popover-content] { background: #fff; border: 1px solid #888; padding: 6px 10px; font-size: 12px; box-sizing: border-box }
`;

beforeAll(async () => {
  script = await bundleHarness(new URL("./tooltip-harness/entry.tsx", import.meta.url));
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
}, 120_000);

afterAll(async () => {
  await browser?.close();
});

async function mount(): Promise<{ page: Page; errors: string[] }> {
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.setContent(`<style>${CSS}</style><div id="root"></div>`);
  await page.addScriptTag({ content: script });
  await page.evaluate(() => window.mountTooltips());
  await page.waitForSelector("[data-card]");
  return { page, errors };
}

/** The pop-up is wholly inside the window, and is not inside the card. */
async function expectFreeOfCard(page: Page, popup: string) {
  const box = await page.locator(popup).boundingBox();
  expect(box).not.toBeNull();
  const view = page.viewportSize()!;
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(view.width);
  expect(box!.y + box!.height).toBeLessThanOrEqual(view.height);
  expect(await page.locator(popup).evaluate((el) => !!el.closest("[data-card]"))).toBe(false);
  expect(await page.locator(popup).evaluate((el) => el.parentElement === document.body)).toBe(true);
}

describe("hover pop-ups inside an overflow-hidden card", () => {
  it("the time split tooltip, with the pointer at the right of the card, is whole and outside the card", async () => {
    const { page, errors } = await mount();
    const card = (await page.locator("[data-card]").first().boundingBox())!;
    const row = (await page.locator("[data-time-split] li").first().boundingBox())!;
    await page.mouse.move(row.x + row.width - 5, row.y + row.height / 2);
    await page.waitForSelector("[data-chart-tip]");
    expect(await page.locator("[data-chart-tip]").innerText()).toMatch(/30% hands-on/);
    await expectFreeOfCard(page, "[data-chart-tip]");
    expect(card.x + card.width).toBe(900);
    expect(errors).toEqual([]);
    await page.close();
  }, 60_000);

  it("the revenue chart tooltip, hovered at the right and bottom edge of the card, is whole and outside the card", async () => {
    const { page, errors } = await mount();
    const svg = (await page.locator("[data-mrr-box] svg").boundingBox())!;
    await page.mouse.move(svg.x + svg.width - 4, svg.y + svg.height - 4);
    await page.waitForFunction(() => document.querySelector("[data-chart-tip]")?.textContent?.includes("on average"));
    await expectFreeOfCard(page, "[data-chart-tip]");
    await page.mouse.move(svg.x + 3, svg.y + 3);
    await page.waitForFunction(() => document.querySelector("[data-chart-tip]")?.textContent?.includes("Now") || document.querySelector("[data-chart-tip]")?.textContent?.includes("on average"));
    await expectFreeOfCard(page, "[data-chart-tip]");
    await page.mouse.move(2, 2);
    await page.waitForFunction(() => !document.querySelector("[data-chart-tip]"));
    expect(errors).toEqual([]);
    await page.close();
  }, 60_000);

  it("the help (i) bubble, opened by hover near the card's right edge, is whole and outside the card, and keeps its text", async () => {
    const { page, errors } = await mount();
    await page.getByRole("button", { name: "About Test setting" }).hover();
    await page.waitForSelector("[data-slot=popover-content]");
    expect(await page.locator("[data-slot=popover-content]").innerText()).toContain("What this setting does, in a sentence.");
    expect(await page.locator("[data-slot=popover-content]").innerText()).toContain("An example of it.");
    const box = (await page.locator("[data-slot=popover-content]").boundingBox())!;
    expect(box.x + box.width).toBeLessThanOrEqual(900);
    expect(box.y + box.height).toBeLessThanOrEqual(700);
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(await page.locator("[data-slot=popover-content]").evaluate((el) => !!el.closest("[data-card]"))).toBe(false);
    // The text is also always in the page for a screen reader.
    expect(await page.getByRole("button", { name: "About Test setting" }).getAttribute("aria-describedby")).toBeTruthy();
    expect(errors).toEqual([]);
    await page.close();
  }, 60_000);
});

describe("placeTip", () => {
  const view = { w: 800, h: 600 };
  const size = { w: 200, h: 80 };
  it("sits above the pointer, centred", () => {
    expect(placeTip({ x: 400, y: 300 }, size, view, "above")).toEqual({ left: 300, top: 208 });
  });
  it("drops below the pointer when there is no room above", () => {
    expect(placeTip({ x: 400, y: 20 }, size, view, "above").top).toBe(32);
  });
  it("flips to the left of the pointer near the right edge, and stays on screen", () => {
    const p = placeTip({ x: 790, y: 590 }, size, view, "side");
    expect(p.left).toBe(578);
    expect(p.top + size.h).toBeLessThanOrEqual(view.h);
  });
  it("is clamped to the left and top edges", () => {
    expect(placeTip({ x: 0, y: 0 }, size, view, "above")).toEqual({ left: 8, top: 12 });
  });
});
