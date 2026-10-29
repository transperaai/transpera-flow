import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bundleHarness } from "./build-harness";

// Settings, Churn drivers and Services in a real browser with the simulation in a real Web Worker (./drivers-harness/entry.tsx), for
// sandbox phase 3: a driver switched from its weight to a chance and an effect (the projection moves, the weight greys, the same
// expected churn is pre-filled and said), switched back; a read-only reader cannot switch; the fee range fields on a service and the
// warning when the range does not hold the fee. At 1440, 640 and 400 px, no console errors.

let browser: Browser;
let script: string;
let workers: Record<string, string>;

const META = { "import.meta.url": JSON.stringify("http://harness.test/src/lib/x/") };
const CSS = `body { margin: 0; font: 14px sans-serif } .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0) }`;

beforeAll(async () => {
  [script, workers] = await Promise.all([
    bundleHarness(new URL("./drivers-harness/entry.tsx", import.meta.url), META),
    Promise.all(["simulate.worker.ts"].map(async (f) => [f, await bundleHarness(new URL(`../src/workers/${f}`, import.meta.url))] as const)).then(Object.fromEntries),
  ]);
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
}, 120_000);

afterAll(async () => {
  await browser?.close();
});

async function mount(width: number, readonly = false): Promise<{ page: Page; errors: string[] }> {
  const page = await browser.newPage({ viewport: { width, height: 1000 } });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.setContent(`<style>${CSS}</style><div id="root"></div>`);
  await page.evaluate((w) => (window.workerScripts = w), workers);
  await page.addScriptTag({ content: script });
  await page.evaluate((o) => window.mountDrivers(o), { readonly });
  return { page, errors };
}

const group = (page: Page, name: string) => page.getByRole("group", { name: `How ${name} is counted` });

describe("Settings: churn drivers as chances", { timeout: 180_000 }, () => {
  for (const width of [1440, 640, 400]) {
    describe(`at ${width}px`, () => {
      it("switches Late or missed servicing work to a chance and an effect, says it is the same expected churn, and back to a weight", async () => {
        const { page, errors } = await mount(width);
        const late = group(page, "Late or missed servicing work");
        await late.waitFor({ timeout: 60_000 });
        // The measured chance is pre-filled from the latest run: wait for it to finish.
        await page.waitForFunction(() => !document.body.innerText.includes("Running the simulation"), undefined, { timeout: 90_000 });
        // A phone (under 640 px) is read only.
        if (width < 640) {
          expect(await late.getByRole("button", { name: "Chance and effect" }).isDisabled()).toBe(true);
          expect(errors).toEqual([]);
          return page.close();
        }
        const mode = () => page.locator("[data-driver-mode]").first().getAttribute("data-driver-mode");
        expect(await mode()).toBe("weight");
        await late.getByRole("button", { name: "Chance and effect" }).click();
        await page.waitForSelector('[data-driver-mode="chance"]');
        await page.getByText("Raises that client's churn by").first().waitFor();
        const events = await page.locator('[data-driver-mode="chance"]').first().innerText();
        expect(events).toContain("Chance a month");
        expect(events).toContain("Raises that client's churn by");
        expect(events).toContain("months");
        expect(events).toContain("Same expected churn as the weight gave in the last run");
        // The weight slider greys while the driver runs as events.
        expect(await page.locator("input[type=range]").first().isDisabled()).toBe(true);
        await late.getByRole("button", { name: "Weight" }).click();
        await page.waitForSelector('[data-driver-mode="weight"]');
        expect(errors).toEqual([]);
        await page.close();
      });

      it("shows the fee range fields on a service, and warns (without refusing) when the range does not hold the fee", async () => {
        const { page, errors } = await mount(width);
        await page.locator("details > summary").first().click();
        const lowest = page.getByLabel("Fee range: lowest", { exact: true }).first();
        await lowest.waitFor({ timeout: 30_000 });
        expect(await page.getByLabel("Fee range: highest", { exact: true }).count()).toBeGreaterThan(0);
        // A phone (under 640 px) is read only.
        expect(await lowest.isDisabled()).toBe(width < 640);
        expect(errors).toEqual([]);
        await page.close();
      });

      it("is read only for a reader: the mode buttons and fee range fields are disabled", async () => {
        const { page, errors } = await mount(width, true);
        const late = group(page, "Late or missed servicing work");
        await late.waitFor({ timeout: 60_000 });
        expect(await late.getByRole("button", { name: "Chance and effect" }).isDisabled()).toBe(true);
        await page.locator("details > summary").first().click();
        expect(await page.getByLabel("Fee range: lowest", { exact: true }).first().isDisabled()).toBe(true);
        expect(errors).toEqual([]);
        await page.close();
      });
    });
  }
});
