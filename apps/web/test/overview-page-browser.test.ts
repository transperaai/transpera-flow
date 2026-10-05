import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bundleHarness } from "./build-harness";

// The real Overview page component in a real browser (issue #173, B15), its simulations in real Web Workers: how many runs
// it asks for. The company is simulated at the workspace's length and at the horizon; each implemented solution's before
// and after is simulated once, and changing the horizon runs the horizon again but not the solutions. The page is
// ./overview-page-harness bundled with esbuild (see ../build-harness.ts), each worker bundled on its own.

let browser: Browser;
let script: string;
let workers: Record<string, string>;

// The bundle has no `import.meta.url`: give it one under which `../../workers/<name>.ts` names the worker file.
const META = { "import.meta.url": JSON.stringify("http://harness.test/src/lib/x/") };

beforeAll(async () => {
  [script, workers] = await Promise.all([
    bundleHarness(new URL("./overview-page-harness/entry.tsx", import.meta.url), META),
    Promise.all(["simulate.worker.ts", "impact.worker.ts", "absence.worker.ts"].map(async (f) => [f, await bundleHarness(new URL(`../src/workers/${f}`, import.meta.url))] as const)).then(Object.fromEntries),
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
  it("simulates each solution's before and after once: changing the horizon runs the horizon again, not the solutions", async () => {
    const { page, errors } = await mount();
    // The implemented solution is measured: the card shows what it saved.
    await page.waitForFunction(() => /a month (saved|added)/.test(document.querySelector('[data-card="improvement"]')?.textContent ?? ""), null, { timeout: 90_000 });
    await page.waitForFunction(() => /Playing 3 months/.test(document.querySelector("[data-horizon-note]")?.textContent ?? ""), null, { timeout: 60_000 });
    const before = await posts(page);
    expect(count(before, "impact.worker.ts")).toBe(1);
    const runsBefore = count(before, "simulate.worker.ts");
    expect(runsBefore).toBeGreaterThanOrEqual(1);
    expect(runsBefore).toBeLessThanOrEqual(2);

    await page.getByRole("button", { name: "12 months" }).click();
    await page.waitForFunction(() => /Playing 12 months/.test(document.querySelector("[data-horizon-note]")?.textContent ?? ""), null, { timeout: 90_000 });
    // The cards have caught up with the new run, and the improvement card still shows its numbers.
    await page.waitForFunction(() => /over the next 12 months/.test(document.querySelector('[data-card="flow-efficiency"]')?.textContent ?? ""), null, { timeout: 30_000 });
    expect(await page.locator('[data-card="improvement"]').textContent()).toMatch(/a month (saved|added)/);

    const after = await posts(page);
    // One more run, at the new horizon; the run the findings come from and the solutions' runs aren't asked for again.
    expect(count(after, "simulate.worker.ts")).toBe(runsBefore + 1);
    expect(count(after, "impact.worker.ts")).toBe(1);

    // Back to 3 months: the horizon runs again, the solutions still don't.
    await page.getByRole("button", { name: "3 months" }).click();
    await page.waitForFunction(() => /Playing 3 months/.test(document.querySelector("[data-horizon-note]")?.textContent ?? ""), null, { timeout: 90_000 });
    await expect.poll(async () => count(await posts(page), "simulate.worker.ts"), { timeout: 30_000 }).toBe(runsBefore + 2);
    expect(count(await posts(page), "impact.worker.ts")).toBe(1);
    expect(errors).toEqual([]);
    await page.close();
  }, 240_000);
});
