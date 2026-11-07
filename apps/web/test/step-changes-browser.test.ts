import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bundleHarness } from "./build-harness";
import type { TourHarnessOptions } from "./tour-harness/entry";

// "Automate…" and "Augment…" in the step panel (D53, part B), on the real Editor in demo mode: in solution mode a Step offers them, each edit goes into the
// Editor's own list and is saved with the solution (Save solution); a Wait or a Decision does not; the live process points at making a solution. // (The demo keeps the saved solution in the tab; the server side is tested in test/actions-database.test.ts and packages/db/test/step-change-edit.test.ts.)

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

const demoSolutions = (page: Page) => page.evaluate(() => window.demoSolutions().map((s) => ({ name: s.name, step_changes: s.step_changes, steps: s.steps.steps.map((x) => x.id) })));
const fillAutomation = async (page: Page, name: string) => {
  const dialog = page.locator("[data-step-change-dialog]");
  await dialog.waitFor();
  await dialog.locator("[data-change-name]").fill(name);
  await dialog.locator("[data-change-share]").fill("85");
  await dialog.locator("[data-change-checking]").fill("2");
  await dialog.locator("[data-change-adoption]").fill("70");
  await dialog.locator("[data-change-ramp]").fill("3");
  await dialog.locator("[data-change-cost]").fill("400");
  await dialog.locator("[data-change-save]").dispatchEvent("click");
  await dialog.waitFor({ state: "detached" });
};
const saveSolution = async (page: Page) => {
  await page.getByRole("button", { name: "Save solution", exact: true }).dispatchEvent("click");
  await page.waitForFunction(() => window.demoSolutions().length > 0);
};

describe("step changes in the step panel", () => {
  it("an edit in the panel shows in the list at once (no server call) and is saved with the solution, with the same id", async () => {
    const change = { id: "0b8f6f0e-6d0a-4d5e-9d57-2f1d1d2a9c11", name: "Draft with AI", kind: "augmentation" as const, effects: [{ step: DISCOVERY, part: "augmentable" as const, factor: 2 }], adoption: 0.9, ramp_months: 1, tiers: null, cost_monthly: null };
    const { page, errors } = await open({ editorMode: "solution", solutionChanges: [change] });
    await select(page, DISCOVERY);
    await page.locator(`[data-change-on-step="${change.id}"]`).waitFor();
    // Edit the seeded change, then add an automation: both are in the list, and nothing went to the server.
    await page.locator("[data-change-edit]").dispatchEvent("click");
    await page.locator("[data-change-factor]").fill("3");
    await page.locator("[data-change-save]").dispatchEvent("click");
    await page.locator("[data-step-change-dialog]").waitFor({ state: "detached" });
    await page.locator("[data-change-automate]").dispatchEvent("click");
    await fillAutomation(page, "Pace it by machine");
    expect(await page.locator("[data-change-on-step]").count()).toBe(2);
    expect((await calls(page)).length).toBe(0);
    await saveSolution(page);
    const [saved] = await demoSolutions(page);
    expect(saved!.step_changes).toHaveLength(2);
    expect(saved!.step_changes[0]).toMatchObject({ id: change.id, kind: "augmentation", effects: [{ step: DISCOVERY, part: "augmentable", factor: 3 }] });
    expect(saved!.step_changes[1]).toMatchObject({ name: "Pace it by machine", kind: "automation", adoption: 0.7, ramp_months: 3, cost_monthly: 400, effects: [{ step: DISCOVERY, part: "automatable", remove: 0.85, residualHours: 2 / 60 }] });
    expect(saved!.step_changes[1]!.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(errors).toEqual([]);
  });

  it("a new solution that isn't saved yet can get an automation, and saves it; Remove takes one out", async () => {
    const { page } = await open({ editorMode: "solution", newSolution: true });
    await select(page, DISCOVERY);
    expect(await page.locator("[data-change-automate]").count()).toBe(1);
    await page.locator("[data-change-automate]").dispatchEvent("click");
    await fillAutomation(page, "Pace it by machine");
    await page.locator("[data-change-augment]").dispatchEvent("click");
    const dialog = page.locator("[data-step-change-dialog]");
    await dialog.waitFor();
    await dialog.locator("[data-change-name]").fill("Draft with AI");
    await dialog.locator("[data-change-save]").dispatchEvent("click");
    await dialog.waitFor({ state: "detached" });
    expect(await page.locator("[data-change-on-step]").count()).toBe(2);
    await page.locator("[data-change-edit]").nth(1).dispatchEvent("click");
    await page.locator("[data-change-remove]").dispatchEvent("click");
    await dialog.waitFor({ state: "detached" });
    expect(await page.locator("[data-change-on-step]").count()).toBe(1);
    await page.getByRole("textbox", { name: "Solution name" }).fill("Pacing by machine");
    await saveSolution(page);
    const [saved] = await demoSolutions(page);
    expect(saved!.step_changes).toHaveLength(1);
    expect(saved!.step_changes[0]).toMatchObject({ name: "Pace it by machine", kind: "automation" });
  });

  it("a Wait or a Decision has no Automate… or Augment…", async () => {
    const { page } = await open({ editorMode: "solution", newSolution: true });
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
