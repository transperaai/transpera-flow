import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bundleHarness } from "./build-harness";

// What a step achieves in the real Editor (sandbox phase 4, demo mode, so edits stay in the tab): the inspector's "What it achieves" picker
// with the Automatic name and why, setting two steps at once from the multi-selection, and undo putting each back in one go.

let browser: Browser;
let script: string;
const ORIGIN = "https://editor.test/";
const AUDIT = "e0000000-0000-4000-8000-000000000003";
const DISCOVERY = "e0000000-0000-4000-8000-000000000002";
const KICKOFF = "e0000000-0000-4000-8000-000000000006";

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

const node = (page: Page, id: string) => page.locator(`.react-flow__node[data-id="${id}"]`);
// The page here has none of the app's stylesheet, so the canvas's toolbar and the inspector lie over the nodes: the click goes to the node itself.
const select = async (page: Page, id: string) => {
  // A click on a step that is already in a selection keeps the selection, so start from an empty one.
  await page.locator(".react-flow__pane").dispatchEvent("click");
  await node(page, id).dispatchEvent("click");
  await page.locator('aside[aria-label="Inspector"]').waitFor();
};
const picker = (page: Page) => page.getByLabel("What it achieves", { exact: true });
// The label holds the (i) with its text, so the field is found by its label's start.
const many = (page: Page) => page.locator("label", { hasText: /^What they achieve/ }).locator("select");

describe("what a step achieves, in the Editor", { timeout: 120_000 }, () => {
  for (const width of [1440, 1024]) {
    it(`sets one step, then two at once, and undo puts each back (${width}px)`, async () => {
      const { page, errors } = await open(width);
      // A step up to and including the sale decision is Winning work until someone chooses; one after it moves the client's job forward.
      await select(page, AUDIT);
      expect(await picker(page).locator("option").first().innerText()).toBe("Automatic: Winning work");
      expect(await page.getByText("Sales pipeline process, up to and including the sale decision").count()).toBe(1);
      await select(page, KICKOFF);
      expect(await picker(page).locator("option").first().innerText()).toBe("Automatic: Moves the client's job forward");
      // The workspace's categories, in order, with no Client upkeep (not a step's purpose).
      const options = await picker(page).locator("option").allInnerTexts();
      expect(options.slice(1)).toEqual(["Moves the client's job forward", "Required", "Winning work", "Coordination", "Fixing", "Could be removed"]);

      // One step.
      await select(page, AUDIT);
      await picker(page).selectOption({ label: "Coordination" });
      expect(await picker(page).inputValue()).toBe("coordination");

      // Two at once from the multi-selection: Control-click adds a step to the selection.
      await select(page, DISCOVERY);
      // The canvas ignores a modifier key pressed while a form field has the focus.
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await page.keyboard.down("Control");
      await node(page, KICKOFF).dispatchEvent("click");
      await page.keyboard.up("Control");
      await many(page).waitFor();
      expect(await many(page).inputValue()).toBe("__automatic");
      await many(page).selectOption({ label: "Fixing" });
      await select(page, DISCOVERY);
      expect(await picker(page).inputValue()).toBe("fixing");
      await select(page, KICKOFF);
      expect(await picker(page).inputValue()).toBe("fixing");

      // One undo takes both back to Automatic; the first step's own choice stays.
      await page.locator("body").click({ position: { x: 5, y: 5 } });
      await page.keyboard.press("Control+z");
      await select(page, DISCOVERY);
      expect(await picker(page).inputValue()).toBe("");
      await select(page, KICKOFF);
      expect(await picker(page).inputValue()).toBe("");
      await select(page, AUDIT);
      expect(await picker(page).inputValue()).toBe("coordination");
      // And another undo clears the first.
      await page.locator("body").click({ position: { x: 5, y: 5 } });
      await page.keyboard.press("Control+z");
      await select(page, AUDIT);
      expect(await picker(page).inputValue()).toBe("");
      expect(errors).toEqual([]);
      await page.context().close();
    });
  }
});
