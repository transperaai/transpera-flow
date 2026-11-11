import { chromium, type Browser, type Page } from "playwright-core";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bundleHarness } from "./build-harness";

// QA: in the Editor, scrolling the side panels fast "glitched the page" and scrolled into blank space. From lg the Editor is exactly the
// screen: the page never scrolls, and a panel's scroll stops at its end instead of carrying on to the page. The real Editor (demo mode) in
// a real browser, with the app's own stylesheet.

let browser: Browser;
let script: string;
let css = "";
const ORIGIN = "https://editor.test/";

/** The app's real stylesheet (Tailwind compiled from globals.css). Test only. */
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
  [script, css] = await Promise.all([bundleHarness(new URL("./tour-harness/entry.tsx", import.meta.url)), appCss()]);
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
}, 180_000);

afterAll(async () => {
  await browser?.close();
});

async function open(width: number, height: number): Promise<Page> {
  const context = await browser.newContext({ viewport: { width, height } });
  const page = await context.newPage();
  await page.route(ORIGIN, (route) => route.fulfill({ contentType: "text/html", body: `<!doctype html><meta name="viewport" content="width=device-width"><style>${css}</style><div id="root"></div>` }));
  await page.goto(ORIGIN);
  await page.addScriptTag({ content: script });
  await page.evaluate(() => window.mountEditor({ userId: "user-a", dismissed: true }));
  await page.waitForSelector("[data-editor]");
  await page.waitForSelector(".react-flow__node");
  return page;
}

describe("the Editor's page never scrolls", { timeout: 180_000 }, () => {
  it("is exactly the screen, and a fast scroll past the end of a side panel leaves the page where it was", async () => {
    const page = await open(1440, 900);
    // A step selected fills the inspector with more than fits (the case that let the page grow to about 1,600px tall).
    await page.locator(".react-flow__node").nth(2).click();
    await page.waitForTimeout(300);
    const doc = () => page.evaluate(() => ({ scroll: document.scrollingElement!.scrollTop, height: document.scrollingElement!.scrollHeight, view: window.innerHeight }));
    const before = await doc();
    expect(before.height).toBeLessThanOrEqual(before.view + 1);
    for (const label of ["Inspector", "Palette"]) {
      const panel = page.getByRole("complementary", { name: label });
      const box = (await panel.boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      // A fast flick: many big wheel steps, far more than the panel holds.
      for (let i = 0; i < 40; i++) await page.mouse.wheel(0, 900);
      await page.waitForTimeout(200);
      const after = await doc();
      expect(after.scroll, `${label}: the page moved`).toBe(0);
      expect(after.height).toBeLessThanOrEqual(after.view + 1);
    }
    await page.context().close();
  });
});
