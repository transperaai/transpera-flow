import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bundleHarness } from "./build-harness";

// The real Overview page component in a real browser (issue #173, B15), its simulations in real Web Workers: how many runs
// it asks for. The company is simulated at the workspace's length and at the horizon, and changing the horizon runs the horizon again. The page is
// ./overview-page-harness bundled with esbuild (see ../build-harness.ts), each worker bundled on its own.

let browser: Browser;
let script: string;
let workers: Record<string, string>;

// The bundle has no `import.meta.url`: give it one under which `../../workers/<name>.ts` names the worker file.
const META = { "import.meta.url": JSON.stringify("http://harness.test/src/lib/x/") };

beforeAll(async () => {
  [script, workers] = await Promise.all([
    bundleHarness(new URL("./overview-page-harness/entry.tsx", import.meta.url), META),
    Promise.all(["simulate.worker.ts", "absence.worker.ts"].map(async (f) => [f, await bundleHarness(new URL(`../src/workers/${f}`, import.meta.url))] as const)).then(Object.fromEntries),
  ]);
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
}, 120_000);

afterAll(async () => {
  await browser?.close();
});

async function mount(): Promise<{ page: Page; errors: string[] }> {
  const page = await browser.newPage({ viewport: { width: 1300, height: 1400 } });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.setContent(`<div id="root"></div>`);
  await page.evaluate((w) => (window.workerScripts = w), workers);
  await page.addScriptTag({ content: script });
  await page.evaluate(() => window.mountOverview());
  return { page, errors };
}

const posts = (page: Page) => page.evaluate(() => [...window.workerPosts]);
const count = (list: string[], file: string) => list.filter((f) => f === file).length;

describe("the Overview page's runs", () => {
  it("simulates the horizon again when it changes, between 1, 3 and 6 months only", async () => {
    const { page, errors } = await mount();
    await page.waitForFunction(() => /Playing 3 months/.test(document.querySelector("[data-horizon-note]")?.textContent ?? ""), null, { timeout: 90_000 });
    // Q1 item 9: 1, 3 and 6 months, and a way on to the Sandbox.
    expect(await page.getByRole("group", { name: "Time horizon" }).getByRole("button").allInnerTexts()).toEqual(["1m", "3m", "6m"]);
    expect(await page.locator("[data-sandbox-link]").innerText()).toBe("Simulate further in the Sandbox");
    // Item 7/8: History opens the company map's history page directly, and looks like Export (outline, small).
    expect(await page.locator("[data-company-history]").getAttribute("href")).toBe("/w/x/p/company/history");
    const look = (sel: string) => page.locator(sel).evaluate((e) => e.className.split(/\s+/).sort().join(" "));
    expect(await look("[data-company-history]")).toEqual(await look("[data-export-menu]"));
    const before = await posts(page);
    const runsBefore = count(before, "simulate.worker.ts");
    expect(runsBefore).toBeGreaterThanOrEqual(1);
    expect(runsBefore).toBeLessThanOrEqual(2);

    await page.getByRole("button", { name: "6 months" }).click();
    await page.waitForFunction(() => /Playing 6 months/.test(document.querySelector("[data-horizon-note]")?.textContent ?? ""), null, { timeout: 90_000 });
    await page.waitForFunction(() => /over the next 6 months/.test(document.querySelector('[data-chart="time-split"]')?.textContent ?? ""), null, { timeout: 30_000 });
    // One more run, at the new horizon; the run the findings come from isn't asked for again.
    expect(count(await posts(page), "simulate.worker.ts")).toBe(runsBefore + 1);

    await page.getByRole("button", { name: "3 months" }).click();
    await page.waitForFunction(() => /Playing 3 months/.test(document.querySelector("[data-horizon-note]")?.textContent ?? ""), null, { timeout: 90_000 });
    await expect.poll(async () => count(await posts(page), "simulate.worker.ts"), { timeout: 30_000 }).toBe(runsBefore + 2);
    expect(errors).toEqual([]);
    await page.close();
  }, 240_000);
});
