import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bundleHarness } from "./build-harness";

// A step's base values in the real Editor (capacity P4, demo mode, so edits stay in the tab): the work split's sliders stay at 100%,
// each part has a line, the split shows as a bar on the step's tile, Clear split takes it away, a source label shows as a pill,
// and undo puts a split back in one go.

let browser: Browser;
let script: string;
const ORIGIN = "https://editor.test/";
const AUDIT = "e0000000-0000-4000-8000-000000000003";
const KICKOFF = "e0000000-0000-4000-8000-000000000006";

beforeAll(async () => {
  script = await bundleHarness(new URL("./tour-harness/entry.tsx", import.meta.url));
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
}, 120_000);

afterAll(async () => {
  await browser?.close();
});

async function open(width: number): Promise<{ page: Page; errors: string[] }> {
  const context = await browser.newContext({ viewport: { width, height: 1000 } });
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
const select = async (page: Page, id: string) => {
  await page.locator(".react-flow__pane").dispatchEvent("click");
  await node(page, id).dispatchEvent("click");
  await page.locator('aside[aria-label="Inspector"]').waitFor();
};
const slider = (page: Page, part: string) => page.getByLabel(`${part} share`, { exact: true });
const shown = async (page: Page) => [
  await page.locator('[data-split-value="automatable"]').innerText(),
  await page.locator('[data-split-value="augmentable"]').innerText(),
  await page.locator('[data-split-value="manual"]').innerText(),
];
/** Move a slider and let go (the value is saved when the slider is released or loses focus). */
const move = async (page: Page, part: string, value: number) => {
  await slider(page, part).fill(String(value));
  await slider(page, part).blur();
};

describe("a step's base values, in the Editor", { timeout: 120_000 }, () => {
  for (const width of [1440, 1024]) {
    it(`the split sliders stay at 100%, the tile shows the bar, and Clear split takes it away (${width}px)`, async () => {
      const { page, errors } = await open(width);
      await select(page, AUDIT);
      // Nothing entered: the whole time is manual, and the tile shows nothing new.
      expect(await page.getByText("No split entered").count()).toBe(1);
      expect(await shown(page)).toEqual(["0%", "0%", "100%"]);
      expect(await node(page, AUDIT).locator("[data-split-bar]").count()).toBe(0);

      await move(page, "Automatable", 70);
      expect(await shown(page)).toEqual(["70%", "0%", "30%"]);
      await move(page, "Augmentable", 20);
      const values = (await shown(page)).map((v) => Number.parseInt(v, 10));
      expect(values[1]).toBe(20);
      expect(values.reduce((a, b) => a + b, 0)).toBe(100);
      expect(values.every((v) => v % 5 === 0)).toBe(true);
      // Every move, to the end of the range and back, keeps the three at 100%.
      for (const [part, v] of [["Stays manual", 100], ["Automatable", 100], ["Augmentable", 0], ["Stays manual", 35]] as const) {
        await move(page, part, v);
        expect((await shown(page)).map((x) => Number.parseInt(x, 10)).reduce((a, b) => a + b, 0)).toBe(100);
      }

      // The split is on the step's tile as a bar, with its parts in the title.
      const bar = node(page, AUDIT).locator("[data-split-bar]");
      expect(await bar.count()).toBe(1);
      expect(await bar.getAttribute("title")).toMatch(/^Automatable \d+% · Augmentable \d+% · Manual \d+%$/);
      expect(await node(page, KICKOFF).locator("[data-split-bar]").count()).toBe(0);

      // Take it away.
      await page.locator("[data-clear-split]").click();
      expect(await shown(page)).toEqual(["0%", "0%", "100%"]);
      expect(await node(page, AUDIT).locator("[data-split-bar]").count()).toBe(0);
      expect(errors).toEqual([]);
    });
  }

  it("a line for each part is kept, and the source label shows as a pill", async () => {
    const { page, errors } = await open(1440);
    await select(page, AUDIT);
    await move(page, "Automatable", 50);
    const note = page.getByLabel("What the automatable part is");
    await note.fill("Pull spend and budgets");
    await note.blur();
    // Reselect the step: the line is saved, not just in the field.
    await select(page, KICKOFF);
    await select(page, AUDIT);
    expect(await page.getByLabel("What the automatable part is").inputValue()).toBe("Pull spend and budgets");
    expect(await page.locator('[data-source-for="split"] [data-source-pill]').count()).toBe(0);
    await page.locator('[data-source-for="split"] select').selectOption("estimate");
    expect(await page.locator('[data-source-for="split"] [data-source-pill]').innerText()).toBe("Low confidence");
    await page.locator('[data-source-for="split"] select').selectOption("measured");
    expect(await page.locator('[data-source-for="split"] [data-source-pill]').innerText()).toBe("High confidence");
    expect(errors).toEqual([]);
  });

  it("undo puts the split back in one go", async () => {
    const { page } = await open(1440);
    await select(page, AUDIT);
    await move(page, "Automatable", 60);
    expect(await node(page, AUDIT).locator("[data-split-bar]").count()).toBe(1);
    await page.getByRole("button", { name: /^Undo/ }).click();
    expect(await node(page, AUDIT).locator("[data-split-bar]").count()).toBe(0);
    expect(await shown(page)).toEqual(["0%", "0%", "100%"]);
  });
});
