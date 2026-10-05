import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bundleHarness } from "./build-harness";
import type { TourHarnessOptions } from "./tour-harness/entry";

// The Editor's written tour in a real browser (issue #176, B18), on the real Editor (demo mode): it opens by itself the first
// time, every step points at an element that is really on the screen, "Take the tour" starts it again, and once dismissed it
// stays away, per user. The steps and the storage rules are unit-tested in editor-tour.test.ts.

let browser: Browser;
let script: string;

beforeAll(async () => {
  script = await bundleHarness(new URL("./tour-harness/entry.tsx", import.meta.url));
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
}, 120_000);

afterAll(async () => {
  await browser?.close();
});

const ORIGIN = "https://editor.test/";

/** Open the Editor on a fresh browser profile (or the given one, to test what is remembered), and wait for it to draw. */
async function open(options: TourHarnessOptions = {}, opts: { context?: BrowserContext; width?: number } = {}): Promise<{ page: Page; context: BrowserContext; errors: string[] }> {
  const context = opts.context ?? (await browser.newContext({ viewport: { width: opts.width ?? 1440, height: 900 } }));
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  // A page set from a string has no storage; a real origin has, as the app does.
  await page.route(ORIGIN, (route) => route.fulfill({ contentType: "text/html", body: `<!doctype html><meta name="viewport" content="width=device-width"><div id="root"></div>` }));
  await page.goto(ORIGIN);
  await page.addScriptTag({ content: script });
  await page.evaluate((o) => window.mountEditor(o), options);
  await page.waitForSelector("[data-editor]");
  return { page, context, errors };
}

const card = (page: Page) => page.locator("[data-tour-card]");

/** Walk the tour with Next; returns each step's id, whether its highlight sits on the element it points at, and the card's text. */
async function walk(page: Page) {
  const seen: { id: string; onTarget: boolean; title: string; count: string }[] = [];
  for (;;) {
    const id = (await card(page).getAttribute("data-tour-step"))!;
    // The highlight is placed after the page scrolls the area into view.
    await page.waitForFunction((step) => !!document.querySelector(`[data-tour-highlight="${step}"]`), id);
    // The outline glides to its place; measure it once it has arrived.
    await page.waitForTimeout(300);
    const onTarget = await page.evaluate((step) => {
      // The outline's place is inline style (viewport pixels): the page here has none of the app's stylesheet.
      const st = (document.querySelector(`[data-tour-highlight="${step}"]`) as HTMLElement).style;
      const h = { left: parseFloat(st.left), top: parseFloat(st.top), right: parseFloat(st.left) + parseFloat(st.width), bottom: parseFloat(st.top) + parseFloat(st.height) };
      const selectors: Record<string, string[]> = {
        palette: ['aside[aria-label="Palette"]'],
        canvas: ["[data-tour=canvas]"],
        inspector: ['aside[aria-label="Inspector"]'],
        checklist: ["[data-missing-for-simulation]"],
        draft: ["[data-tour=draft]"],
        simulate: ["[data-tour=simulate]"],
        publish: ["[data-tour=publish]"],
        history: ["[data-tour=history]"],
      };
      // Each step has ONE element it must be on: the one named here, not whichever the tour found.
      const el = selectors[step]!.map((s) => document.querySelector(s)).find(Boolean);
      if (!el) return false;
      const r = el.getBoundingClientRect();
      // The outline surrounds the element (a little padding either way, clipped to the screen) and is no bigger than that.
      const around = r.width > 0 && r.height > 0 && h.left <= Math.max(r.left, 0) + 1 && h.top <= Math.max(r.top, 0) + 1 && h.right >= Math.min(r.right, innerWidth) - 1 && h.bottom >= Math.min(r.bottom, innerHeight) - 1;
      const snug = h.right - h.left <= Math.min(r.width, innerWidth) + 16 && h.bottom - h.top <= Math.min(r.height, innerHeight) + 16 + 24;
      return around && snug;
    }, id);
    seen.push({ id, onTarget, title: await card(page).locator("h2").innerText(), count: await page.locator("[data-tour-count]").innerText() });
    const next = page.locator("[data-tour-next]");
    if ((await next.innerText()) === "Done") {
      await next.click();
      return seen;
    }
    await next.click();
  }
}

describe("the Editor tour", () => {
  it("opens by itself the first time, and walks the Editor's areas in order, each pointing at a real element", async () => {
    const { page, errors } = await open({ userId: "user-a", gaps: true });
    await card(page).waitFor();
    expect(await page.locator("[data-tour-count]").innerText()).toBe("Step 1 of 8");
    const seen = await walk(page);
    expect(seen.map((s) => s.id)).toEqual(["palette", "canvas", "inspector", "checklist", "draft", "simulate", "publish", "history"]);
    expect(seen.map((s) => s.title)).toEqual(["The palette", "The canvas", "The inspector", "The assumptions checklist", "Your draft", "Simulate", "Publish", "History"]);
    expect(seen.map((s) => s.count)).toEqual(Array.from({ length: 8 }, (_, i) => `Step ${i + 1} of 8`));
    for (const s of seen) expect(s.onTarget, `${s.id} points at its element`).toBe(true);
    // The checklist step opened the folded-away list it talks about.
    expect(await page.locator("[data-missing-for-simulation]").evaluate((el) => (el as HTMLDetailsElement).open)).toBe(true);
    expect(await card(page).count()).toBe(0);
    expect(await page.locator("[data-tour-highlight]").count()).toBe(0);
    expect(errors).toEqual([]);
    await page.context().close();
  }, 60_000);

  it("leaves out the checklist step when nothing is missing, rather than pointing at something else", async () => {
    const { page } = await open({ userId: "user-a" });
    await card(page).waitFor();
    expect(await page.locator("[data-missing-for-simulation]").count()).toBe(0);
    const seen = await walk(page);
    expect(seen.map((s) => s.id)).toEqual(["palette", "canvas", "inspector", "draft", "simulate", "publish", "history"]);
    for (const s of seen) expect(s.onTarget, s.id).toBe(true);
    await page.context().close();
  }, 60_000);

  it("has Back, which goes to the step before", async () => {
    const { page } = await open({ userId: "user-a" });
    await card(page).waitFor();
    await page.locator("[data-tour-back]").waitFor({ state: "detached" });
    await page.locator("[data-tour-next]").click();
    expect(await card(page).getAttribute("data-tour-step")).toBe("canvas");
    await page.locator("[data-tour-back]").click();
    expect(await card(page).getAttribute("data-tour-step")).toBe("palette");
    await page.context().close();
  }, 60_000);

  it("stays away once skipped, comes back from 'Take the tour', and remembers per user", async () => {
    const first = await open({ userId: "user-a" });
    await card(first.page).waitFor();
    await first.page.locator("[data-tour-skip]").click();
    expect(await card(first.page).count()).toBe(0);
    await first.page.close();

    // The same user, opening the Editor again: nothing opens by itself.
    const again = await open({ userId: "user-a" }, { context: first.context });
    await again.page.waitForTimeout(500);
    expect(await card(again.page).count()).toBe(0);

    // "Take the tour" starts it again, from the first step.
    await again.page.getByRole("button", { name: "Take the tour" }).click();
    await card(again.page).waitFor();
    expect(await again.page.locator("[data-tour-count]").innerText()).toBe("Step 1 of 7");
    await again.page.close();

    // Someone else on the same browser has not seen it.
    const other = await open({ userId: "user-b" }, { context: first.context });
    await card(other.page).waitFor();
    await other.page.close();

    // And the demo (nobody signed in) has its own.
    const demo = await open({ userId: null }, { context: first.context });
    await card(demo.page).waitFor();
    await demo.page.close();
    await first.context.close();
  }, 90_000);

  it("closes with Escape and counts that as dismissed", async () => {
    const first = await open({ userId: "user-a" });
    await card(first.page).waitFor();
    await first.page.keyboard.press("Escape");
    expect(await card(first.page).count()).toBe(0);
    await first.page.close();
    const again = await open({ userId: "user-a" }, { context: first.context });
    await again.page.waitForTimeout(500);
    expect(await card(again.page).count()).toBe(0);
    await first.context.close();
  }, 60_000);

  it("closes with Escape wherever the focus is, and puts the focus back on 'Take the tour'", async () => {
    const { page } = await open({ userId: "user-a" });
    await card(page).waitFor();
    // Focus somewhere else in the Editor (not on the card), then Escape.
    await page.locator("[data-tour=canvas]").evaluate((el) => (el as HTMLElement).focus());
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    expect(await card(page).evaluate((el) => el.contains(document.activeElement))).toBe(false);
    await page.keyboard.press("Escape");
    expect(await card(page).count()).toBe(0);
    await page.waitForFunction(() => document.activeElement?.hasAttribute("data-take-tour"));
    await page.context().close();
  }, 60_000);

  it("remembers a signed-in person's dismissal in the database, as well as the browser: nothing opens when it says so", async () => {
    const first = await open({ userId: "user-a" });
    await card(first.page).waitFor();
    await first.page.locator("[data-tour-skip]").click();
    const calls = await first.page.evaluate(() => (globalThis as unknown as { __serverActions?: { name: string; args: unknown[] }[] }).__serverActions ?? []);
    expect(calls.filter((c) => c.name === "dismissEditorTour")).toEqual([{ name: "dismissEditorTour", args: ["process"] }]);
    await first.context.close();

    // A different browser (nothing stored there) of a person whose account says they dismissed it.
    const elsewhere = await open({ userId: "user-a", dismissed: true });
    await elsewhere.page.waitForTimeout(500);
    expect(await card(elsewhere.page).count()).toBe(0);
    // "Take the tour" still works.
    await elsewhere.page.getByRole("button", { name: "Take the tour" }).click();
    await card(elsewhere.page).waitFor();
    await elsewhere.context.close();

    // The company map's tour is its own: a dismissed process tour doesn't hide it, and dismissing it says `company`.
    const company = await open({ company: true, userId: "user-a" });
    await card(company.page).waitFor();
    await company.page.locator("[data-tour-skip]").click();
    const companyCalls = await company.page.evaluate(() => (globalThis as unknown as { __serverActions?: { name: string; args: unknown[] }[] }).__serverActions ?? []);
    expect(companyCalls.filter((c) => c.name === "dismissEditorTour")).toEqual([{ name: "dismissEditorTour", args: ["company"] }]);
    await company.context.close();

    // The demo has nobody signed in: only the browser remembers.
    const demo = await open({ userId: null });
    await card(demo.page).waitFor();
    await demo.page.locator("[data-tour-skip]").click();
    expect(await demo.page.evaluate(() => ((globalThis as unknown as { __serverActions?: unknown[] }).__serverActions ?? []).length)).toBe(0);
    await demo.context.close();
  }, 90_000);

  it("moves focus to the card so the keyboard carries on from there", async () => {
    const { page } = await open({ userId: "user-a" });
    await card(page).waitFor();
    expect(await page.evaluate(() => document.activeElement?.hasAttribute("data-tour-next"))).toBe(true);
    await page.keyboard.press("Enter");
    expect(await card(page).getAttribute("data-tour-step")).toBe("canvas");
    await page.context().close();
  }, 60_000);

  it("is shorter on the company map: no Simulate and no assumptions, every step still real", async () => {
    const { page, errors } = await open({ company: true, userId: "user-a" });
    await card(page).waitFor();
    expect(await page.locator("[data-tour-count]").innerText()).toBe("Step 1 of 6");
    const ids = [];
    for (;;) {
      const id = (await card(page).getAttribute("data-tour-step"))!;
      ids.push(id);
      await page.waitForFunction((step) => !!document.querySelector(`[data-tour-highlight="${step}"]`), id);
      const next = page.locator("[data-tour-next]");
      if ((await next.innerText()) === "Done") {
        await next.click();
        break;
      }
      await next.click();
    }
    expect(ids).toEqual(["palette", "canvas", "inspector", "draft", "publish", "history"]);
    expect(errors).toEqual([]);
    await page.context().close();
  }, 60_000);

  it("leaves out a step whose element isn't there (a block has no draft to publish, and no History)", async () => {
    const { page } = await open({ editorMode: "block", userId: "user-a" });
    await card(page).waitFor();
    const seen = await walk(page);
    expect(seen.map((s) => s.id)).toEqual(["palette", "canvas", "inspector"]);
    for (const s of seen) expect(s.onTarget, s.id).toBe(true);
    await page.context().close();
  }, 60_000);
});
