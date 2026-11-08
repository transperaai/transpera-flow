import { bundleHarness } from "./build-harness";
import { chromium, type Browser, type Page } from "playwright-core";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { HarnessOptions } from "./map-harness/entry";

// Dragging a line's middle in the Editor: a selected line of an editable map has a round handle on its middle; dragging it redraws the
// line as it goes and saves once on release (one undo), the arrow keys nudge it, a double-click puts it back. A read-only map draws a
// moved line where it was saved but has no handle. The command and the diff are unit-tested in editor-bend.test.ts.

let browser: Browser;
let script: string;
let css: string;

const LAYOUT_CSS = `
  body { margin: 0; font: 14px sans-serif; }
  .absolute { position: absolute } .relative { position: relative } .inset-0 { inset: 0 } .isolate { isolation: isolate }
  .flex { display: flex } .flex-col { flex-direction: column } .flex-1 { flex: 1 1 0% } .min-h-0 { min-height: 0 } .min-w-0 { min-width: 0 }
  .h-full { height: 100% } .w-full { width: 100% } .size-3\\.5 { width: .875rem; height: .875rem }
`;

beforeAll(async () => {
  script = await bundleHarness(new URL("./map-harness/entry.tsx", import.meta.url));
  css = readFileSync(createRequire(import.meta.url).resolve("@xyflow/react/dist/style.css"), "utf8");
  css += readFileSync(fileURLToPath(new URL("../src/styles/react-flow.css", import.meta.url)), "utf8");
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
}, 120_000);

afterAll(async () => {
  await browser?.close();
});

async function mount(options: Partial<HarnessOptions> = {}): Promise<{ page: Page; errors: string[] }> {
  const page = await browser.newPage({ viewport: { width: 1400, height: 800 } });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  // A page set from a string isn't a secure context, where the editor's ids come from.
  await page.evaluate(() => {
    crypto.randomUUID ??= () => "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) => (Number(c) ^ (Math.random() * 16) >> (Number(c) / 4)).toString(16)) as `${string}-${string}-${string}-${string}-${string}`;
  });
  await page.setContent(`<style>${css}${LAYOUT_CSS}</style><div id="root"></div>`);
  await page.addScriptTag({ content: script });
  await page.evaluate((o) => window.mountMap(o), { editable: false, nested: false, controlled: false, highlight: null, company: false, palette: false, card: false, ...options });
  await page.waitForSelector(".react-flow__node");
  await page.waitForFunction(() => !/translate\(0px, 0px\) scale\(1\)/.test(document.querySelector<HTMLElement>(".react-flow__viewport")?.style.transform ?? ""), undefined, { timeout: 10_000 });
  await page.waitForTimeout(400);
  return { page, errors };
}

const pathOf = (page: Page, id: string) => page.locator(`.react-flow__edge[data-id="${id}"] path.react-flow__edge-path`).getAttribute("d");
const handle = (page: Page, id?: string) => page.locator(id ? `[data-bend-handle="${id}"]` : "[data-bend-handle]");
const centreOf = async (page: Page, id: string) => page.evaluate((e) => window.mapApi.getEdges().find((x) => x.id === e)!.center, id);

/**
 * A line that goes forwards (its target's left edge right of its source's right edge), drawn on the map, on screen: its middle segment
 * runs up and down, so a drag sideways moves it.
 */
async function forwardLine(page: Page): Promise<string> {
  const id = await page.evaluate(() => {
    const view = document.querySelector(".react-flow")!.getBoundingClientRect();
    for (const e of window.mapApi.getEdges()) {
      const el = document.querySelector<SVGGElement>(`.react-flow__edge[data-id="${e.id}"]`);
      const d = el?.querySelector("path.react-flow__edge-path")?.getAttribute("d");
      if (!el || !d) continue;
      const nums = [...d.matchAll(/-?\d+(\.\d+)?/g)].map((m) => Number(m[0]));
      const [x0, , ...rest] = nums;
      const x1 = rest[rest.length - 2]!;
      const box = el.getBoundingClientRect();
      if (x1 - x0! > 120 && box.left > view.left + 20 && box.right < view.right - 20 && box.top > view.top + 20 && box.bottom < view.bottom - 20) return e.id;
    }
    return null;
  });
  expect(id).not.toBeNull();
  return id!;
}

async function selectLine(page: Page, id: string) {
  await page.locator(".react-flow__pane").dispatchEvent("click");
  await page.locator(`.react-flow__edge[data-id="${id}"]`).dispatchEvent("click");
  await handle(page, id).waitFor({ state: "visible" });
}

async function middle(page: Page, id: string) {
  const box = (await handle(page, id).boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

describe("dragging a line's middle", () => {
  it("shows a handle only on the selected line; a drag moves the line as it goes, keeps it there on release, and undo puts it back", async () => {
    const { page, errors } = await mount({ editable: true });
    expect(await handle(page).count()).toBe(0);
    const id = await forwardLine(page);
    const before = (await pathOf(page, id))!;
    await selectLine(page, id);
    expect(await handle(page).count()).toBe(1);
    expect(await handle(page, id).getAttribute("aria-label")).toBe("Drag to move this line");

    const a = await middle(page, id);
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.mouse.move(a.x + 30, a.y + 10, { steps: 4 });
    await page.mouse.move(a.x + 60, a.y + 20, { steps: 4 });
    // Redrawn while dragging, and nothing is saved yet.
    const during = await pathOf(page, id);
    expect(during).not.toBe(before);
    expect(await centreOf(page, id)).toEqual([null, null]);
    await page.mouse.up();

    await page.waitForFunction((e) => window.mapApi.getEdges().find((x) => x.id === e)!.center[0] !== null, id);
    const [dx] = await centreOf(page, id);
    // The drag was 60 screen pixels to the right, at whatever zoom the map is framed at.
    const zoom = await page.evaluate(() => Number(/scale\(([\d.]+)\)/.exec(document.querySelector<HTMLElement>(".react-flow__viewport")!.style.transform)![1]));
    expect(Math.abs(dx! - 60 / zoom)).toBeLessThan(2);
    const after = (await pathOf(page, id))!;
    expect(after).not.toBe(before);
    // Where it was let go (saved to the whole map unit).
    const xs = (d: string) => [...d.matchAll(/-?\d+(\.\d+)?/g)].map((m) => Number(m[0]));
    xs(after).forEach((v, i) => expect(Math.abs(v - xs(during!)[i]!)).toBeLessThan(1));
    await page.waitForTimeout(300);
    expect(await pathOf(page, id)).toBe(after);
    // The handle follows the line's middle.
    const b = await middle(page, id);
    expect(Math.abs(b.x - (a.x + 60))).toBeLessThan(2);
    expect(await page.evaluate(() => window.mapApi.undoLabel())).toMatch(/^Moved the line /);

    // One undo step for the whole drag.
    expect(await page.evaluate(() => window.mapApi.undo())).toBe(true);
    await page.waitForFunction((e) => window.mapApi.getEdges().find((x) => x.id === e)!.center[0] === null, id);
    expect(await pathOf(page, id)).toBe(before);
    expect(errors).toEqual([]);
    await page.close();
  }, 60_000);

  it("nudges with the arrow keys, one edit a press, and a double-click puts the line back", async () => {
    const { page, errors } = await mount({ editable: true });
    const id = await forwardLine(page);
    const before = (await pathOf(page, id))!;
    await selectLine(page, id);
    await handle(page, id).focus();
    await page.keyboard.press("ArrowRight");
    await page.waitForFunction((e) => window.mapApi.getEdges().find((x) => x.id === e)!.center[0] === 10, id);
    await page.keyboard.press("ArrowRight");
    await page.waitForFunction((e) => window.mapApi.getEdges().find((x) => x.id === e)!.center[0] === 20, id);
    expect(await pathOf(page, id)).not.toBe(before);
    // The line stays selected (the arrows nudged the line, not the map or a card).
    expect(await handle(page, id).count()).toBe(1);

    await handle(page, id).dblclick();
    await page.waitForFunction((e) => window.mapApi.getEdges().find((x) => x.id === e)!.center[0] === null, id);
    expect(await pathOf(page, id)).toBe(before);
    expect(await page.evaluate(() => window.mapApi.undoLabel())).toMatch(/^Reset the line /);
    expect(errors).toEqual([]);
    await page.close();
  }, 60_000);

  it("works on the company map in its department lanes", async () => {
    const { page, errors } = await mount({ editable: true, company: true, bands: true });
    await page.waitForSelector("[data-lane]");
    const id = (await page.evaluate(() => window.mapApi.getEdges()))[0]!.id;
    const before = (await pathOf(page, id))!;
    await selectLine(page, id);
    const a = await middle(page, id);
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.mouse.move(a.x + 40, a.y + 40, { steps: 6 });
    await page.mouse.up();
    await page.waitForFunction((e) => window.mapApi.getEdges().find((x) => x.id === e)!.center.some((v) => v !== null), id);
    expect(await pathOf(page, id)).not.toBe(before);
    expect(errors).toEqual([]);
    await page.close();
  }, 60_000);

  it("a read-only map draws a moved line where it was saved, with no handle", async () => {
    const plain = await mount({ editable: false });
    const id = await forwardLine(plain.page);
    const straight = await pathOf(plain.page, id);
    await plain.page.close();

    const { page, errors } = await mount({ editable: false, bend: { dx: 40, dy: 0 } });
    expect(await pathOf(page, id)).not.toBe(straight);
    await page.locator(`.react-flow__edge[data-id="${id}"]`).dispatchEvent("click");
    await page.waitForTimeout(300);
    expect(await handle(page).count()).toBe(0);
    expect(errors).toEqual([]);
    await page.close();
  }, 60_000);
});
