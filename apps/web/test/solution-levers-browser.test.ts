import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bundleHarness } from "./build-harness";

// The Editor's "Lever changes" box in solution mode (issue #33, B4), on the real Editor (demo mode) opened for a visitor's idea that
// brings lever changes and no steps: the box lists each change in words with Remove, notes what the server left out, a solution may be
// saved with levers and no step change, and what is saved carries exactly the levers that were kept.

let browser: Browser;
let script: string;

beforeAll(async () => {
  script = await bundleHarness(new URL("./solution-levers-harness/entry.tsx", import.meta.url));
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
}, 120_000);

afterAll(async () => {
  await browser?.close();
});

async function open(levers: { path: string; op: "set" | "multiply"; value: number }[], notes: string[] = []): Promise<{ page: Page; errors: string[]; step: { stepId: string; stepName: string } }> {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.route("https://editor.test/", (route) => route.fulfill({ contentType: "text/html", body: `<!doctype html><meta name="viewport" content="width=device-width"><div id="root"></div>` }));
  await page.goto("https://editor.test/");
  await page.addScriptTag({ content: script });
  const step = await page.evaluate(([l, n]) => window.mountSolutionEditor({ levers: l as never, notes: n as string[] }), [levers, notes] as const);
  await page.waitForSelector("[data-editor]");
  return { page, errors, step };
}

describe("the Editor's Lever changes box", { timeout: 90_000 }, () => {
  it("lists each change in words with Remove and an (i), notes what was left out, and the idea's note says the idea changes levers only", async () => {
    const probe = await open([]);
    const stepId = probe.step.stepId;
    await probe.page.close();
    const { page, errors, step } = await open(
      [
        { path: "demand.leads_per_week", op: "set", value: 12 },
        { path: `steps.${stepId}.work_hours`, op: "multiply", value: 0.8 },
      ],
      ["1 of the visitor's changes no longer apply (a step, role or service has gone since they sent it)."],
    );
    const box = page.locator("[data-lever-changes]");
    expect(await box.count()).toBe(1);
    expect(await box.locator("[data-lever-change]").allInnerTexts()).toEqual(["Leads per week: 12Remove", `Hands-on time on ${step.stepName}: −20%Remove`]);
    expect(await box.locator("[data-lever-note]").innerText()).toContain("no longer apply");
    expect(await box.getByRole("button", { name: "About Lever changes" }).count()).toBe(1);
    expect(await page.locator("[data-idea-note]").innerText()).toContain("The idea changes levers only: they're listed under Lever changes.");
    expect(errors).toEqual([]);
    await page.close();
  });

  it("Remove drops one; Save solution with no step changed is allowed and stores exactly the levers that were kept", async () => {
    const { page, errors } = await open([
      { path: "demand.leads_per_week", op: "set", value: 12 },
      { path: "demand.active_clients", op: "set", value: 40 },
    ]);
    await page.locator("[data-lever-change='demand.active_clients']").getByRole("button", { name: /Remove/ }).click();
    expect(await page.locator("[data-lever-change]").count()).toBe(1);
    await page.fill("[data-solution-form] input", "One more strategist");
    await page.getByRole("button", { name: "Save solution", exact: true }).click();
    await page.waitForFunction(() => window.savedSolutions().length === 1, undefined, { timeout: 30_000 });
    const saved = await page.evaluate(() => window.savedSolutions());
    expect(saved[0]!.lever_changes).toEqual([{ path: "demand.leads_per_week", op: "set", value: 12 }]);
    expect(saved[0]!.name).toBe("One more strategist");
    expect(errors).toEqual([]);
    await page.close();
  });

  it("with every change removed and no step changed there is nothing to save", async () => {
    const { page } = await open([{ path: "demand.leads_per_week", op: "set", value: 12 }]);
    await page.getByRole("button", { name: /Remove/ }).click();
    expect(await page.locator("[data-lever-changes]").count()).toBe(0);
    await page.fill("[data-solution-form] input", "Nothing");
    await page.getByRole("button", { name: "Save solution", exact: true }).click();
    await page.waitForFunction(() => /Change at least one step or lever first/.test(document.body.innerText));
    expect(await page.evaluate(() => window.savedSolutions().length)).toBe(0);
    await page.close();
  });
});
