import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bundleHarness } from "./build-harness";
import type { TourHarnessOptions } from "./tour-harness/entry";

// "Automate…" and "Augment…" in the step panel (D53, part B), on the real Editor in demo mode: a Step on a saved solution's version offers them and
// sends one edit to the server action; a Wait or a Decision does not; the live process points at making a solution. (The server action is stood in
// for by the harness, which notes each call; the data side is tested in packages/db/test/step-change-edit.test.ts.)

let browser: Browser;
let script: string;
const ORIGIN = "https://editor.test/";
const DISCOVERY = "e0000000-0000-4000-8000-000000000002";
const AUDIT = "e0000000-0000-4000-8000-000000000003";

beforeAll(async () => {
  script = await bundleHarness(new URL("./tour-harness/entry.tsx", import.meta.url));
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
}, 120_000);

afterAll(async () => {
  await browser?.close();
});

async function open(options: TourHarnessOptions = {}): Promise<{ page: Page; errors: string[] }> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.route(ORIGIN, (route) => route.fulfill({ contentType: "text/html", body: `<!doctype html><meta name="viewport" content="width=device-width"><div id="root"></div>` }));
  await page.goto(ORIGIN);
  await page.addScriptTag({ content: script });
  await page.evaluate((o) => window.mountEditor(o), { userId: "user-a", dismissed: true, ...options });
  await page.waitForSelector("[data-editor]");
  await page.waitForSelector(".react-flow__node");
  await page.waitForTimeout(800);
  return { page, errors };
}

const select = async (page: Page, id: string) => {
  await page.locator(".react-flow__pane").dispatchEvent("click");
  await page.locator(`.react-flow__node[data-id="${id}"]`).dispatchEvent("click");
  await page.locator('aside[aria-label="Inspector"]').waitFor();
};
const calls = (page: Page) => page.evaluate(() => (globalThis as unknown as { __serverActions?: { name: string; args: unknown[] }[] }).__serverActions ?? []);

describe("step changes in the step panel", () => {
  it("a Step on a solution's version offers Automate… and Augment…, and an automation is one save", async () => {
    const { page, errors } = await open({ editorMode: "solution", solutionChanges: [] });
    await select(page, DISCOVERY);
    await page.locator("[data-change-augment]").waitFor();
    await page.locator("[data-change-automate]").dispatchEvent("click");
    const dialog = page.locator("[data-step-change-dialog]");
    await dialog.waitFor();
    await dialog.locator("[data-change-name]").fill("Pace it by machine");
    await dialog.locator("[data-change-share]").fill("85");
    await dialog.locator("[data-change-checking]").fill("2");
    await dialog.locator("[data-change-adoption]").fill("70");
    await dialog.locator("[data-change-ramp]").fill("3");
    await dialog.locator("[data-change-cost]").fill("400");
    await dialog.locator("[data-change-save]").dispatchEvent("click");
    await page.locator("[data-change-error]").waitFor();
    const sent = (await calls(page)).filter((c) => c.name === "saveStepChange");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.args[2]).toEqual({
      op: "save",
      key: null,
      change: {
        name: "Pace it by machine",
        kind: "automation",
        effects: [{ step: DISCOVERY, part: "automatable", remove: 0.85, residualHours: 2 / 60 }],
        adoption: 0.7,
        ramp_months: 3,
        tiers: null,
        cost_monthly: 400,
      },
    });
    expect(errors).toEqual([]);
  });

  it("an augmentation sends times faster, and a step's change can be edited or removed from the same place", async () => {
    const change = { id: "0b8f6f0e-6d0a-4d5e-9d57-2f1d1d2a9c11", name: "Draft with AI", kind: "augmentation" as const, effects: [{ step: DISCOVERY, part: "augmentable" as const, factor: 2 }], adoption: 0.9, ramp_months: 1, tiers: null, cost_monthly: null };
    const { page } = await open({ editorMode: "solution", solutionChanges: [change] });
    await select(page, DISCOVERY);
    await page.locator(`[data-change-on-step="${change.id}"]`).waitFor();
    await page.locator("[data-change-edit]").dispatchEvent("click");
    const dialog = page.locator("[data-step-change-dialog]");
    expect(await dialog.locator("[data-change-factor]").inputValue()).toBe("2");
    await dialog.locator("[data-change-factor]").fill("3");
    await dialog.locator("[data-change-save]").dispatchEvent("click");
    await page.locator("[data-change-error]").waitFor();
    await dialog.locator("[data-change-remove]").dispatchEvent("click");
    await page.waitForFunction(() => ((globalThis as unknown as { __serverActions?: unknown[] }).__serverActions ?? []).length >= 2);
    const sent = (await calls(page)).filter((c) => c.name === "saveStepChange");
    expect(sent[0]!.args[2]).toMatchObject({ op: "save", key: change.id, change: { kind: "augmentation", effects: [{ step: DISCOVERY, part: "augmentable", factor: 3 }], adoption: 0.9, ramp_months: 1 } });
    expect(sent[1]!.args[2]).toEqual({ op: "remove", key: change.id });
  });

  it("a Wait or a Decision has no Automate… or Augment…", async () => {
    const { page } = await open({ editorMode: "solution", solutionChanges: [] });
    await select(page, AUDIT);
    expect(await page.locator("[data-change-automate]").count()).toBe(1);
    await page.getByRole("button", { name: "+ Wait", exact: true }).dispatchEvent("click");
    await page.locator('aside[aria-label="Inspector"]').waitFor();
    expect(await page.locator("[data-change-automate]").count()).toBe(0);
    await page.getByRole("button", { name: "+ Decision", exact: true }).dispatchEvent("click");
    await page.locator("[data-decision-panel]").waitFor();
    expect(await page.locator("[data-change-automate]").count()).toBe(0);
  });

  it("on the live process the panel says to make a solution, and offers no Automate…", async () => {
    const { page } = await open({ makeSolution: true });
    await select(page, DISCOVERY);
    const link = page.locator("[data-make-solution]");
    await link.waitFor();
    expect(await link.textContent()).toBe("Make a solution to try an automation");
    expect(await page.locator("[data-change-automate]").count()).toBe(0);
  });
});
