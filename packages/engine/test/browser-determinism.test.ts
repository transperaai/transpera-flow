import { build } from "esbuild";
import { chromium, type Browser } from "playwright-core";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { larkspurModel, northbeamModel, northbeamWithClients, northbeamWithMoney, northbeamWithServices, northbeamWithServicing, simulate, type SimulateOptions } from "../src";
import { largeModel } from "./fixtures/large-model";

// The same model and seed must give byte-identical results in Node and in a
// browser Web Worker (where the app runs the engine). Uses Chromium from
// CHROMIUM_PATH if set, otherwise Playwright's installed Chromium.

let browser: Browser;
let engineBundle: string;

beforeAll(async () => {
  const out = await build({
    entryPoints: [fileURLToPath(new URL("../src/index.ts", import.meta.url))],
    bundle: true,
    format: "iife",
    globalName: "TransperaFlowEngine",
    write: false,
    platform: "browser",
  });
  engineBundle = out.outputFiles[0]!.text;
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
}, 60_000);

afterAll(async () => {
  await browser?.close();
});

async function runInWorker(model: unknown, reps: number, seed: number, options: SimulateOptions = {}): Promise<string> {
  const page = await browser.newPage();
  try {
    return await page.evaluate(
      ({ bundle, model, reps, seed, options }) =>
        new Promise<string>((resolve, reject) => {
          const src = `${bundle}\nself.onmessage = (e) => self.postMessage(JSON.stringify(TransperaFlowEngine.simulate(e.data.model, e.data.reps, e.data.seed, e.data.options)));`;
          const worker = new Worker(URL.createObjectURL(new Blob([src], { type: "text/javascript" })));
          worker.onmessage = (e) => resolve(e.data as string);
          worker.onerror = (e) => reject(new Error(e.message));
          worker.postMessage({ model, reps, seed, options });
        }),
      { bundle: engineBundle, model, reps, seed, options },
    );
  } finally {
    await page.close();
  }
}

describe("determinism across hosts", () => {
  it("Northbeam (automatic warm-up): Node and a browser worker agree byte for byte", async () => {
    const model = northbeamModel();
    expect(await runInWorker(model, 30, 1)).toBe(JSON.stringify(simulate(model, 30, 1)));
  }, 60_000);

  it("Northbeam started from current WIP: Node and a browser worker agree byte for byte", async () => {
    const model = northbeamModel();
    model.steps = model.steps.map((s) => (s.id === "audit" ? { ...s, currentWip: 8 } : s.id === "decision" ? { ...s, currentWip: 5 } : s));
    expect(await runInWorker(model, 30, 1)).toBe(JSON.stringify(simulate(model, 30, 1)));
  }, 60_000);

  it("Northbeam with SEO and PPC services: Node and a browser worker agree byte for byte", async () => {
    const model = northbeamWithServices();
    expect(await runInWorker(model, 30, 1)).toBe(JSON.stringify(simulate(model, 30, 1)));
  }, 60_000);

  it("Northbeam with its client roster and a 10% overtime cap: Node and a browser worker agree byte for byte", async () => {
    const model = northbeamWithClients();
    expect(await runInWorker(model, 30, 1)).toBe(JSON.stringify(simulate(model, 30, 1)));
  }, 60_000);

  it("Northbeam with seasonality and growth: Node and a browser worker agree byte for byte", async () => {
    const model = {
      ...northbeamWithServices(),
      demand: { seasonality: [1.3, 1.2, 1.1, 1, 0.9, 0.8, 0.6, 0.7, 1.1, 1.2, 1.1, 0.5], growthMonthly: 0.03, startMonth: 8.93 },
    };
    expect(await runInWorker(model, 30, 1)).toBe(JSON.stringify(simulate(model, 30, 1)));
  }, 60_000);

  // The golden models (golden.test.ts) are compared exactly, which relies on this.
  it("Northbeam as seeded, with servicing: Node and a browser worker agree byte for byte", async () => {
    const model = northbeamWithServicing();
    expect(await runInWorker(model, 30, 1)).toBe(JSON.stringify(simulate(model, 30, 1)));
  }, 60_000);

  it("Larkspur, the messier golden agency: Node and a browser worker agree byte for byte", async () => {
    const model = larkspurModel();
    expect(await runInWorker(model, 30, 1)).toBe(JSON.stringify(simulate(model, 30, 1)));
  }, 60_000);

  it("Northbeam with overheads and hourly PPC (the northbeam-money golden model), month by month: Node and a browser worker agree byte for byte", async () => {
    const model = northbeamWithMoney();
    expect(await runInWorker(model, 30, 1, { monthly: true })).toBe(JSON.stringify(simulate(model, 30, 1, { monthly: true })));
  }, 60_000);

  it("large synthetic model: Node and a browser worker agree byte for byte", async () => {
    const model = largeModel();
    expect(await runInWorker(model, 5, 17)).toBe(JSON.stringify(simulate(model, 5, 17)));
  }, 60_000);
});
