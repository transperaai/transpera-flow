import { mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser } from "playwright-core";
import { afterAll, beforeAll, describe, it } from "vitest";
import { bundleHarness } from "./build-harness";

// Screenshots for Q1 (not a check): `Q1_SHOTS=<dir> pnpm vitest run test/q1-shots.test.ts` saves the Overview's capacity pieces on the example
// agency's fixture, light and dark at 1440 px. Skipped when Q1_SHOTS is not set.
const dir = process.env.Q1_SHOTS;
const META = { "import.meta.url": JSON.stringify("http://harness.test/src/lib/x/") };

async function appCss(): Promise<string> {
  const require = createRequire(import.meta.url);
  const here = dirname(require.resolve("@tailwindcss/postcss"));
  type Process = { process(css: string, o: { from: string }): Promise<{ css: string }> };
  const postcss = require(require.resolve("postcss", { paths: [here] })) as (plugins: unknown[]) => Process;
  const tailwind = require("@tailwindcss/postcss") as (o: { base: string }) => unknown;
  const file = fileURLToPath(new URL("../src/app/globals.css", import.meta.url));
  return (await postcss([tailwind({ base: fileURLToPath(new URL("..", import.meta.url)) })]).process(readFileSync(file, "utf8"), { from: file })).css;
}

let browser: Browser;
let script: string;
let worker: string;
let css: string;

beforeAll(async () => {
  if (!dir) return;
  [script, worker, css] = await Promise.all([
    bundleHarness(new URL("./q1-shots-harness/entry.tsx", import.meta.url), META),
    bundleHarness(new URL("../src/workers/simulate.worker.ts", import.meta.url)),
    appCss(),
  ]);
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
}, 180_000);

afterAll(async () => {
  await browser?.close();
});

describe("Q1 screenshots", () => {
  it.skipIf(!dir)("saves the capacity pieces of the Overview, light and dark", async () => {
    mkdirSync(dir!, { recursive: true });
    for (const scheme of ["light", "dark"] as const) {
      const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, colorScheme: scheme });
      await page.setContent(`<style>${css}</style><div id="root"></div>`);
      await page.evaluate((w) => (window.workerScripts = { "simulate.worker.ts": w }), worker);
      await page.addScriptTag({ content: script });
      await page.evaluate(() => window.mountShots());
      await page.waitForSelector("[data-busiest]", { timeout: 120_000 });
      await page.waitForSelector("[data-team-load]", { timeout: 60_000 });
      await page.evaluate(() => document.fonts.ready);
      await page.screenshot({ path: `${dir}/overview-capacity-${scheme}-1440.png`, fullPage: true });
      await page.close();
    }
  }, 240_000);
});
