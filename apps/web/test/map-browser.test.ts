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


describe("adding from the Editor's palette", () => {
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

  /** Every process is on the map to start with; select the first card as a person does (a click on it). */
  async function selectFirstCard(page: Page) {
    const library = page.locator("[data-process-library]");
    await library.waitFor();
    expect(await library.locator("[data-library-item][data-state='placed']").count()).toBe(3);
    expect(await library.locator("[data-library-item][data-state='free']").count()).toBe(0);
    const name = (await page.evaluate(() => window.mapApi.getSteps()))[0]!;
    const card = page.locator(".react-flow__node", { hasText: name }).first();
    await card.click({ position: { x: 20, y: 8 } });
    await page.locator("[data-remove-from-map]").waitFor();
    return { library, name };
  }
  async function expectOffTheMap(page: Page, library: ReturnType<Page["locator"]>, name: string) {
    await page.waitForFunction((n) => !window.mapApi.getSteps().includes(n) && window.mapApi.getSteps().length === 2, name);
    await page.waitForFunction(() => document.querySelectorAll("[data-process-library] [data-library-item][data-state='free']").length === 1);
    expect(await library.locator("[data-library-item][data-state='placed']").count()).toBe(2);
    // The process is offered again under its own name, and can be ticked.
    expect(await library.locator("[data-library-item][data-state='free']").innerText()).toContain(name);
  }

  it("pressing Delete on a selected card takes it off the map (the link only), and the library offers the process again", async () => {
    const page = await mount({ editable: true, company: true, palette: true });
    const { library, name } = await selectFirstCard(page);
    await page.keyboard.press("Delete");
    await expectOffTheMap(page, library, name);
    await page.close();
  }, 60_000);

  it("the inspector's Remove from this map takes the card off the map, and the library offers the process again", async () => {
    const page = await mount({ editable: true, company: true, palette: true });
    const { library, name } = await selectFirstCard(page);
    await page.locator("[data-remove-from-map]").click();
    await expectOffTheMap(page, library, name);
    await page.close();
  }, 60_000);
});

describe("the process library on the company map (B12)", () => {
  const free = (page: Page) => page.locator("[data-process-library] [data-library-item][data-state='free']");
  const add = (page: Page) => page.locator("[data-library-add]");
  const takeAllOff = async (page: Page) => {
    await page.evaluate(() => window.mapApi.removeCards());
    await page.waitForFunction(() => window.mapApi.getSteps().length === 0);
    await page.waitForFunction(() => document.querySelectorAll("[data-process-library] [data-library-item][data-state='free']").length === 3);
  };

  it("adds several processes at once as cards in view that do not sit on each other, and they show as already on the map", async () => {
    const page = await mount({ editable: true, company: true, palette: true });
    await takeAllOff(page);
    expect(await add(page).isDisabled()).toBe(true);
    for (const item of await free(page).all()) await item.locator("input").check();
    await page.waitForFunction(() => /^Add 3 to the map$/.test(document.querySelector("[data-library-add]")?.textContent ?? ""));
    await add(page).click();
    await page.waitForFunction(() => document.querySelectorAll(".react-flow__node").length === 3);
    await settled(page);
    const placed = await cards(page);
    const p = await panel(page);
    for (const c of placed) expect(within(c, p)).toBe(true);
    for (let i = 0; i < placed.length; i++) for (let j = i + 1; j < placed.length; j++) expect(covers(placed[i]!, placed[j]!) || covers(placed[j]!, placed[i]!)).toBe(false);
    // They are links: three cards, and the library now says all three are on the map.
    expect(await page.evaluate(() => window.mapApi.getSteps())).toHaveLength(3);
    await page.waitForFunction(() => document.querySelectorAll("[data-process-library] [data-library-item][data-state='placed']").length === 3);
    expect(await free(page).count()).toBe(0);
    expect(await page.locator("[data-library-item][data-state='placed'] input:disabled").count()).toBe(3);
    await page.close();
  }, 60_000);

  it("places each process once, and the cards land where the map was moved to", async () => {
    const page = await mount({ editable: true, company: true, palette: true });
    await takeAllOff(page);
    // Move the view, then add two of the three: they land in what is now being looked at.
    const p = await panel(page);
    const framed = await view(page);
    await page.mouse.move(p.x + p.width - 60, p.y + p.height - 40);
    await page.mouse.down();
    await page.mouse.move(p.x + p.width - 460, p.y + p.height - 240, { steps: 8 });
    await page.mouse.up();
    await page.waitForFunction((v) => document.querySelector<HTMLElement>(".react-flow__viewport")!.style.transform !== v, framed);
    const items = await free(page).all();
    await items[0]!.locator("input").check();
    await items[1]!.locator("input").check();
    await add(page).click();
    await page.waitForFunction(() => document.querySelectorAll(".react-flow__node").length === 2);
    await settled(page);
    // (Ticking a box may have scrolled the page: measure the panel again, in the same frame as the cards.)
    const [placed, now] = [await cards(page), await panel(page)];
    for (const c of placed) expect(within(c, now)).toBe(true);
    expect(covers(placed[0]!, placed[1]!) || covers(placed[1]!, placed[0]!)).toBe(false);
    // The third is still free; the two placed are disabled and cannot be added again.
    expect(await free(page).count()).toBe(1);
    expect(await page.locator("[data-library-item][data-state='placed'] input:enabled").count()).toBe(0);
    await page.close();
  }, 60_000);

  it("says when the search is hiding processes that are ticked, and still adds them", async () => {
    const page = await mount({ editable: true, company: true, palette: true });
    await takeAllOff(page);
    const items = await free(page).all();
    await items[0]!.locator("input").check();
    await items[1]!.locator("input").check();
    await page.getByLabel("Search processes by name").fill("zzz no such process");
    await page.waitForFunction(() => document.querySelectorAll("[data-library-item]").length === 0);
    await page.waitForFunction(() => /^Add 2 to the map \(2 hidden by search\)$/.test(document.querySelector("[data-library-add]")?.textContent ?? ""));
    await add(page).click();
    await page.waitForFunction(() => document.querySelectorAll(".react-flow__node").length === 2);
    await page.close();
  }, 60_000);

  it("searches by name", async () => {
    const page = await mount({ editable: true, company: true, palette: true });
    const names = await page.locator("[data-library-item] > span > span:first-child").allTextContents();
    expect(names).toHaveLength(3);
    const word = names[0]!.slice(0, 4);
    await page.getByLabel("Search processes by name").fill(word.toUpperCase());
    await page.waitForFunction((n) => document.querySelectorAll("[data-library-item]").length <= n, 3);
    const shown = await page.locator("[data-library-item]").allTextContents();
    expect(shown.length).toBeGreaterThanOrEqual(1);
    expect(shown.every((t) => t.toLowerCase().includes(word.toLowerCase()))).toBe(true);
    await page.getByLabel("Search processes by name").fill("zzz no such process");
    await page.waitForFunction(() => document.querySelectorAll("[data-library-item]").length === 0);
    expect(await page.getByText(/No process matches/).count()).toBe(1);
    await page.close();
  }, 60_000);
});

describe("the process library in an ordinary process's editor (B12 part 2)", () => {
  const free = (page: Page) => page.locator("[data-process-library] [data-library-item][data-state='free']");
  const holders = (page: Page) => page.evaluate(() => window.mapApi.getSteps());
  const openLibrary = async (page: Page) => {
    await page.locator("[data-palette-process]").click();
    await page.locator("[data-process-library]").waitFor();
  };

  it("+ Process opens the library: what sits nowhere can be ticked, what sits on the company map is greyed and says so", async () => {
    const page = await mount({ editable: true, palette: true, library: true });
    expect(await page.locator("[data-process-library]").count()).toBe(0);
    await openLibrary(page);
    const freeNames = await free(page).locator("> span > span:first-child").allTextContents();
    expect(freeNames).toContain("Renewals");
    expect(freeNames).toEqual([...freeNames].sort((a, b) => a.localeCompare(b)));
    const greyed = page.locator("[data-library-item][data-state='inside']");
    expect(await greyed.count()).toBe(1);
    expect(await greyed.locator("input").isDisabled()).toBe(true);
    expect(await greyed.innerText()).toContain("Referrals");
    expect(await greyed.innerText()).toContain("Already on the company map. A process sits in one place only: take it off there first.");
    expect(await page.locator("[data-process-library] [role=group]").evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")))).toContain("On the company map");
    // The process being edited is never offered.
    expect(await page.locator("[data-library-item]").allTextContents()).not.toContain(expect.stringContaining("Lead to live"));
    await page.close();
  }, 60_000);

  it("adds several processes in one go as links in view, none on another; undo takes them out and redo puts them back", async () => {
    const page = await mount({ editable: true, palette: true, library: true });
    const before = await holders(page);
    const nodesBefore = await page.locator(".react-flow__node").count();
    await openLibrary(page);
    const n = await free(page).count();
    expect(n).toBeGreaterThanOrEqual(2);
    for (const item of await free(page).all()) await item.locator("input").check();
    await page.waitForFunction((k) => document.querySelector("[data-library-add]")?.textContent === `Add ${k} to the map`, n);
    await page.locator("[data-library-add]").click();
    await page.waitForFunction((k) => document.querySelectorAll(".react-flow__node").length === k, nodesBefore + n);
    await settled(page);
    expect((await holders(page)).length).toBe(before.length + n);
    // Every added link is in view, and none covers another.
    const added = await page.evaluate((names) => {
      return [...document.querySelectorAll<HTMLElement>(".react-flow__node")]
        .filter((e) => !names.includes(e.innerText.split("\n")[0] ?? ""))
        .map((e) => { const r = e.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom }; });
    }, before);
    const p = await panel(page);
    expect(added.length).toBeGreaterThanOrEqual(n);
    const placed = (await cards(page)).slice(-n);
    for (const c of placed) expect(within(c, p)).toBe(true);
    for (let i = 0; i < placed.length; i++) for (let j = i + 1; j < placed.length; j++) expect(covers(placed[i]!, placed[j]!) || covers(placed[j]!, placed[i]!)).toBe(false);
    // Now listed as here, and not addable again.
    await page.waitForFunction((k) => document.querySelectorAll("[data-library-item][data-state='placed'] input:disabled").length === k, n);
    expect(await free(page).count()).toBe(0);
    // Undo, then redo (the Editor's shortcuts).
    await page.locator(".react-flow__pane").click({ position: { x: 5, y: 5 } });
    await page.keyboard.press("Control+z");
    await page.waitForFunction((k) => document.querySelectorAll(".react-flow__node").length === k, nodesBefore);
    await page.waitForFunction((k) => document.querySelectorAll("[data-process-library] [data-library-item][data-state='free']").length === k, n);
    await page.keyboard.press("Control+Shift+z");
    await page.waitForFunction((k) => document.querySelectorAll(".react-flow__node").length === k, nodesBefore + n);
    await page.close();
  }, 60_000);

  it("New process makes one and adds it here as a link; a template does the same", async () => {
    const page = await mount({ editable: true, palette: true, library: true });
    const nodesBefore = await page.locator(".react-flow__node").count();
    await openLibrary(page);
    await page.locator("[data-library-new-name]").fill("Client offboarding");
    await page.locator("[data-library-new-kind='servicing']").click();
    await page.locator("[data-library-new-make]").click();
    await page.waitForFunction((k) => document.querySelectorAll(".react-flow__node").length === k, nodesBefore + 1);
    await page.locator("[data-library-note]").waitFor();
    expect(await page.locator("[data-library-note]").innerText()).toContain("Made Client offboarding and added it here.");
    expect(await holders(page)).toContain("Client offboarding");
    await page.locator("[data-library-template='agency-delivery'] button").click();
    await page.waitForFunction((k) => document.querySelectorAll(".react-flow__node").length === k, nodesBefore + 2);
    expect(await page.evaluate(() => window.mapApi.created())).toEqual([
      { kind: "new", name: "Client offboarding", processKind: "servicing" },
      { kind: "template", templateId: "agency-delivery" },
    ]);
    await page.close();
  }, 60_000);
});
