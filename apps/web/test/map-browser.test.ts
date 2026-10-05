import { build } from "esbuild";
import { chromium, type Browser, type Page } from "playwright-core";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { northbeamStepIds } from "@transpera-flow/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { HarnessOptions } from "./map-harness/entry";

// The map in a real browser (issue #99): how it frames itself, how its open groups and highlight behave, and where
// focus goes. React Flow measures the DOM, so none of this can be seen in a unit test. The page is the canvas
// bundled by esbuild with just enough CSS for its layout (the app's Tailwind is not compiled here).

let browser: Browser;
let script: string;
let css: string;

const LAYOUT_CSS = `
  body { margin: 0; font: 14px sans-serif; }
  .absolute { position: absolute } .relative { position: relative } .inset-0 { inset: 0 } .isolate { isolation: isolate }
  .flex { display: flex } .flex-col { flex-direction: column } .flex-1 { flex: 1 1 0% } .min-h-0 { min-height: 0 } .min-w-0 { min-width: 0 }
  .self-start { align-self: flex-start } .h-fit { height: fit-content }
  .w-48 { width: 12rem } .w-60 { width: 15rem } .h-full { height: 100% } .w-full { width: 100% }
  .border-b { border-bottom: 1px solid #ddd } .px-3 { padding: 0 .75rem } .py-2 { padding: .5rem 0 }
`;

beforeAll(async () => {
  const out = await build({
    entryPoints: [fileURLToPath(new URL("./map-harness/entry.tsx", import.meta.url))],
    bundle: true,
    format: "iife",
    platform: "browser",
    write: false,
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' },
    alias: { "@": fileURLToPath(new URL("../src", import.meta.url)) },
    logLevel: "silent",
  });
  script = out.outputFiles[0]!.text;
  css = readFileSync(createRequire(import.meta.url).resolve("@xyflow/react/dist/style.css"), "utf8");
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
}, 120_000);

afterAll(async () => {
  await browser?.close();
});

async function mount(options: Partial<HarnessOptions> = {}, width = 1400): Promise<Page> {
  const page = await browser.newPage({ viewport: { width, height: 800 } });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  // A page set from a string isn't a secure context, where the editor's ids come from.
  await page.evaluate(() => {
    crypto.randomUUID ??= () => "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) => (Number(c) ^ (Math.random() * 16) >> (Number(c) / 4)).toString(16)) as `${string}-${string}-${string}-${string}-${string}`;
  });
  await page.setContent(`<style>${css}${LAYOUT_CSS}</style><div id="root"></div>`);
  await page.addScriptTag({ content: script });
  await page.evaluate((o) => window.mountMap(o), { editable: false, nested: false, controlled: false, highlight: null, company: false, palette: false, card: false, ...options });
  await page.waitForSelector(".react-flow__node");
  // Wait for the first framing: the view leaves its starting place.
  await page.waitForFunction(() => !/translate\(0px, 0px\) scale\(1\)/.test(document.querySelector<HTMLElement>(".react-flow__viewport")?.style.transform ?? ""), undefined, { timeout: 10_000 });
  await page.waitForTimeout(400);
  expect(errors).toEqual([]);
  return page;
}

/** Waits until every card has been measured and has stopped moving (the same place on two frames running). */
const settled = (page: Page) =>
  page.waitForFunction(() => {
    const w = window as unknown as { __cards?: string };
    const nodes = [...document.querySelectorAll(".react-flow__node")];
    const now = nodes.map((e) => { const r = e.getBoundingClientRect(); return `${e.getAttribute("data-id")}:${r.left}:${r.top}:${r.width}:${r.height}`; }).join("|");
    const steady = now === w.__cards && nodes.every((e) => e.getBoundingClientRect().width > 0);
    w.__cards = now;
    return steady;
  });

const view = (page: Page) => page.evaluate(() => document.querySelector<HTMLElement>(".react-flow__viewport")!.style.transform);
const openGroups = (page: Page) => page.locator("[data-group='open']").count();

describe("framing the map", () => {
  it("frames a map that starts with its groups open (not only one that starts closed)", async () => {
    const page = await mount({ editable: true, nested: true });
    expect(await openGroups(page)).toBe(2);
    const scale = Number(/scale\(([\d.]+)\)/.exec(await view(page))![1]);
    expect(scale).toBeGreaterThanOrEqual(0.7);
    // The first card sits inside the panel.
    const box = await page.locator(".react-flow__node").first().boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    await page.close();
  }, 60_000);

  it("does not move the view when a step is added", async () => {
    const page = await mount({ editable: true });
    const before = await view(page);
    const count = await page.locator(".react-flow__node").count();
    await page.evaluate(() => window.mapApi.addStep());
    await page.waitForFunction((n) => document.querySelectorAll(".react-flow__node").length > n, count);
    await page.waitForTimeout(600);
    expect(await view(page)).toBe(before);
    // ...nor after the person has moved it, and then another step comes.
    await page.mouse.move(300, 400);
    await page.mouse.wheel(0, -300);
    await page.waitForTimeout(400);
    const moved = await view(page);
    expect(moved).not.toBe(before);
    await page.evaluate(() => window.mapApi.addStep());
    await page.waitForTimeout(600);
    expect(await view(page)).toBe(moved);
    await page.close();
  }, 60_000);
});

describe("the map's width", () => {
  for (const width of [1440, 1280, 400]) {
    it(`fills the card it sits in at ${width}px wide, whatever its toolbar measures (the Overview's right third was blank)`, async () => {
      const page = await mount({ card: true }, width);
      const panel = await page.locator(".react-flow").boundingBox();
      const region = await page.locator("[data-process-map]").boundingBox();
      expect(Math.round(region!.width)).toBe(width);
      expect(Math.round(panel!.width)).toBe(width);
      await page.close();
    }, 60_000);
  }
});

describe("open groups and highlight", () => {
  it("keeps open groups in the state it is given, and follows that state", async () => {
    const page = await mount({ nested: true, controlled: true });
    expect(await openGroups(page)).toBe(0);
    await page.getByRole("button", { name: "Expand all" }).click();
    await page.waitForFunction(() => window.mapApi.getOpen().length === 2);
    expect(await openGroups(page)).toBe(2);
    await page.evaluate(() => window.mapApi.setOpen([]));
    await page.waitForFunction(() => document.querySelectorAll("[data-group='open']").length === 0);
    await page.close();
  }, 60_000);

  it("opens a highlighted step's group while it lasts, without changing the open state", async () => {
    const page = await mount({ nested: true, controlled: true });
    await page.evaluate(() => window.mapApi.setHighlight([window.mapIds.qualify]));
    await page.waitForFunction(() => document.querySelectorAll("[data-group='open']").length === 1);
    expect(await page.evaluate(() => window.mapApi.getOpen())).toEqual([]);
    expect(await page.locator("[data-lit='true']").count()).toBe(1);
    await page.evaluate(() => window.mapApi.setHighlight(null));
    await page.waitForFunction(() => document.querySelectorAll("[data-group='open']").length === 0);
    await page.close();
  }, 60_000);

  it("does not move the view when a highlight changes", async () => {
    const page = await mount({ nested: true, controlled: true });
    const before = await view(page);
    await page.evaluate(() => window.mapApi.setHighlight([window.mapIds.discovery]));
    await page.waitForTimeout(700);
    await page.evaluate(() => window.mapApi.setHighlight(null));
    await page.waitForTimeout(700);
    expect(await view(page)).toBe(before);
    await page.close();
  }, 60_000);

  it("opens the groups of a highlight the map starts with into the open state, so they can be closed by hand", async () => {
    const seeded = await mount({ nested: true, controlled: true, highlight: [northbeamStepIds.qualify] });
    await seeded.waitForFunction(() => window.mapApi.getOpen().length === 1);
    expect(await openGroups(seeded)).toBe(1);
    await seeded.getByRole("button", { name: /^Collapse Sales conversation/ }).click();
    await seeded.waitForFunction(() => document.querySelectorAll("[data-group='open']").length === 0);
    expect(await seeded.evaluate(() => window.mapApi.getOpen())).toEqual([]);
    await seeded.close();
  }, 60_000);
});

describe("a step's detail", () => {
  it("opens on Enter and gives focus back to the step on Escape", async () => {
    const page = await mount();
    const audit = page.locator(`.react-flow__node[data-id="${await page.evaluate(() => window.mapIds.audit)}"]`);
    await audit.focus();
    await page.keyboard.press("Enter");
    await page.waitForSelector("[data-step-detail]");
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.querySelector("[data-step-detail]"));
    await page.waitForFunction((id) => document.activeElement?.getAttribute("data-id") === id, await page.evaluate(() => window.mapIds.audit));
    await page.close();
  }, 60_000);
});

describe("adding from the Editor's palette", () => {
  type Box = { id: string; l: number; t: number; r: number; b: number };
  const cards = (page: Page): Promise<Box[]> =>
    page.locator(".react-flow__node").evaluateAll((els) =>
      els.map((e) => {
        const q = e.getBoundingClientRect();
        return { id: e.getAttribute("data-id")!, l: q.left, t: q.top, r: q.right, b: q.bottom };
      }),
    );
  const panel = async (page: Page) => (await page.locator(".react-flow").boundingBox())!;
  // The harness has no card styling, so a card is drawn bigger than the app's: judge by the card's middle, not its edges.
  const centre = (c: Box) => ({ x: (c.l + c.r) / 2, y: (c.t + c.b) / 2 });
  const within = (c: Box, p: { x: number; y: number; width: number; height: number }) => centre(c).x >= p.x && centre(c).x <= p.x + p.width && centre(c).y >= p.y && centre(c).y <= p.y + p.height;
  const covers = (a: Box, b: Box) => centre(a).x > b.l && centre(a).x < b.r && centre(a).y > b.t && centre(a).y < b.b;

  for (const label of ["+ Step", "+ Decision", "+ Wait", "+ Group"]) {
    it(`${label} adds a card in view that does not sit on another`, async () => {
      const page = await mount({ editable: true, palette: true });
      const before = new Set((await cards(page)).map((c) => c.id));
      await page.getByRole("button", { name: label, exact: true }).click();
      await page.waitForFunction((n) => document.querySelectorAll(".react-flow__node").length > n, before.size);
      await settled(page);
      const after = await cards(page);
      const added = after.filter((c) => !before.has(c.id));
      expect(added.length).toBeGreaterThanOrEqual(1);
      const p = await panel(page);
      // A new group arrives with its first step inside it: the box is the one placed. (The harness draws cards taller than
      // the app does, so for a group the box's top-left corner and title are what must be in view.)
      const card = [...added].sort((a, b) => (b.r - b.l) * (b.b - b.t) - (a.r - a.l) * (a.b - a.t))[0]!;
      if (label === "+ Group") expect(card.l >= p.x && card.r <= p.x + p.width && card.t >= p.y && card.t + 40 <= p.y + p.height).toBe(true);
      else expect(within(card, p)).toBe(true);
      // Nothing it was not joined to is under it (the first of a new group sits inside the group's own box).
      for (const o of after.filter((c) => before.has(c.id))) expect(covers(card, o) || covers(o, card)).toBe(false);
      await page.close();
    }, 60_000);
  }

  it("adds where the person is looking after the map was moved, and does not stack a second on the first", async () => {
    const page = await mount({ editable: true, palette: true });
    const p = await panel(page);
    // Drag the empty map so it is looking at a different place.
    const framed = await view(page);
    await page.mouse.move(p.x + p.width - 60, p.y + p.height - 40);
    await page.mouse.down();
    await page.mouse.move(p.x + p.width - 560, p.y + p.height - 240, { steps: 8 });
    await page.mouse.up();
    await page.waitForFunction((v) => document.querySelector<HTMLElement>(".react-flow__viewport")!.style.transform !== v, framed);
    const known = new Set((await cards(page)).map((c) => c.id));
    await page.getByRole("button", { name: "+ Step", exact: true }).click();
    await page.waitForFunction((n) => document.querySelectorAll(".react-flow__node").length > n, known.size);
    // The first is measured by the time a person presses again.
    await settled(page);
    await page.getByRole("button", { name: "+ Step", exact: true }).click();
    await page.waitForFunction((n) => document.querySelectorAll(".react-flow__node").length >= n + 2, known.size);
    await settled(page);
    const added = (await cards(page)).filter((c) => !known.has(c.id));
    expect(added).toHaveLength(2);
    for (const c of added) expect(within(c, p)).toBe(true);
    expect(covers(added[0]!, added[1]!) || covers(added[1]!, added[0]!)).toBe(false);
    // The first is at the middle of the panel, give or take the nudge a free place needs.
    const mid = { x: p.x + p.width / 2, y: p.y + p.height / 2 };
    const first = added[0]!;
    expect(Math.hypot((first.l + first.r) / 2 - mid.x, (first.t + first.b) / 2 - mid.y)).toBeLessThan(160);
    await page.close();
  }, 60_000);
});

describe("the company map in the Editor (B11)", () => {
  /** Drag from a card's right-hand handle to another card's left-hand handle. */
  async function connect(page: Page, from: string, to: string) {
    const handle = async (name: string, side: "source" | "target") => {
      const box = await page.locator(".react-flow__node", { hasText: name }).first().locator(`.react-flow__handle.${side}`).boundingBox();
      return { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 };
    };
    const a = await handle(from, "source");
    const b = await handle(to, "target");
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 6 });
    await page.mouse.move(b.x, b.y, { steps: 6 });
    await page.mouse.up();
  }

  it("draws a handoff line with a full share, labels it, shows the label, and removes it", async () => {
    const page = await mount({ editable: true, company: true });
    const lines = () => page.evaluate(() => window.mapApi.getEdges());
    const before = await lines();
    // Northbeam has a pipeline and two servicing processes: the stored map joins the pipeline to each; join the two servicing ones.
    expect(await page.evaluate(() => window.mapApi.getSteps())).toHaveLength(3);
    const servicing = before.map((e) => e.to);
    expect(servicing).toHaveLength(2);
    await connect(page, servicing[0]!, servicing[1]!);
    await page.waitForFunction((n) => window.mapApi.getEdges().length === n + 1, before.length);
    const drawn = (await lines()).find((e) => e.from === servicing[0] && e.to === servicing[1])!;
    // A handoff is a picture, not a branch: its share is whole, whatever else leaves the card.
    expect(drawn).toMatchObject({ label: null, probability: 1 });
    // Selected as it is drawn: the handoff editor has a label field, and no share or tag.
    const label = page.getByLabel("Handoff label");
    await label.fill("Signed contract");
    await label.press("Enter");
    await page.waitForFunction(() => window.mapApi.getEdges().some((e) => e.label === "Signed contract"));
    expect(await page.getByLabel("Branch probability, percent").count()).toBe(0);
    // Click away: the label is drawn on the line.
    await page.mouse.click(40, 520);
    await page.waitForFunction(() => [...document.querySelectorAll(".react-flow__edgelabel-renderer span")].some((e) => e.textContent === "Signed contract"));
    // Remove it again.
    await page.locator(".react-flow__edge-interaction").last().click({ force: true });
    await page.getByRole("button", { name: "Remove handoff" }).click();
    await page.waitForFunction((n) => window.mapApi.getEdges().length === n, before.length);
    await page.close();
  }, 60_000);

  it("keeps every card: Delete does nothing to a process card", async () => {
    const page = await mount({ editable: true, company: true });
    await page.locator(".react-flow__node").first().click();
    await page.keyboard.press("Delete");
    await settled(page);
    expect(await page.evaluate(() => window.mapApi.getSteps())).toHaveLength(3);
    await page.keyboard.press("Control+a");
    await page.keyboard.press("Delete");
    await settled(page);
    expect(await page.evaluate(() => window.mapApi.getSteps())).toHaveLength(3);
    await page.close();
  }, 60_000);
});
