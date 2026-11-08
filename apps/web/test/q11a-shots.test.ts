import { mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, it } from "vitest";
import { bundleHarness } from "./build-harness";

// Screenshots for Q11 group A (not a check): `Q11A_SHOTS=<dir> Q11A_PHASE=before|after pnpm vitest run test/q11a-shots.test.ts` saves the Overview, Capacity and
// Sandbox pages on the example fixtures at 1440 px light and dark and at 400 px light. Skipped when Q11A_SHOTS is not set.
const dir = process.env.Q11A_SHOTS;
const phase = process.env.Q11A_PHASE ?? "after";
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

const bundle = (f: string) => bundleHarness(new URL(`../src/workers/${f}`, import.meta.url));
let browser: Browser;
let css: string;
let workers: Record<string, string>;
const scripts: Record<string, string> = {};

beforeAll(async () => {
  if (!dir) return;
  const [overview, capacity, play, sim, absence, c] = await Promise.all([
    bundleHarness(new URL("./overview-page-harness/entry.tsx", import.meta.url), META),
    bundleHarness(new URL("./capacity-harness/entry.tsx", import.meta.url), META),
    bundleHarness(new URL("./play-harness/entry.tsx", import.meta.url), META),
    bundle("simulate.worker.ts"),
    bundle("absence.worker.ts"),
    appCss(),
  ]);
  Object.assign(scripts, { overview, capacity, play });
  workers = { "simulate.worker.ts": sim, "absence.worker.ts": absence };
  css = c;
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
}, 240_000);

afterAll(async () => {
  await browser?.close();
});

const VIEWS = [
  { scheme: "light", width: 1440 },
  { scheme: "dark", width: 1440 },
  { scheme: "light", width: 400 },
] as const;

async function shoot(name: string, script: string, mount: string, ready: (page: Page) => Promise<unknown>) {
  mkdirSync(dir!, { recursive: true });
  for (const v of VIEWS) {
    const page = await browser.newPage({ viewport: { width: v.width, height: 1000 }, colorScheme: v.scheme });
    await page.setContent(`<style>${css}</style><div id="root"></div>`);
    await page.evaluate((w) => (window.workerScripts = w), workers);
    await page.addScriptTag({ content: script });
    await page.evaluate((m) => (window as unknown as Record<string, () => void>)[m]!(), mount);
    await ready(page);
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(500);
    const height = await page.evaluate(() => document.documentElement.scrollHeight);
    await page.screenshot({ path: `${dir}/${name}-${phase}-${v.scheme}-${v.width}.png`, fullPage: true, clip: { x: 0, y: 0, width: v.width, height } });
    await page.close();
  }
}

describe("Q11 group A screenshots", { timeout: 600_000 }, () => {
  it.skipIf(!dir)("Overview", async () => {
    await shoot("overview", scripts.overview!, "mountOverviewPage", async (page) => {
      await page.waitForFunction(() => /Playing/.test(document.querySelector("[data-horizon-note]")?.textContent ?? ""), null, { timeout: 120_000 });
      await page.waitForSelector("[data-team-load]", { timeout: 120_000 });
    });
  });
  it.skipIf(!dir)("Capacity", async () => {
    await shoot("capacity", scripts.capacity!, "mountCapacity", async (page) => {
      await page.waitForSelector("[data-room]", { timeout: 120_000 });
      await page.waitForSelector("[data-named-clients]", { timeout: 120_000 });
    });
  });
  it.skipIf(!dir)("Sandbox", async () => {
    await shoot("sandbox", scripts.play!, "mountPlay", async (page) => {
      await page.waitForSelector("[data-play-heatmap]", { timeout: 120_000 });
      await page.waitForSelector('[data-play-chart="DLER by department"]', { timeout: 60_000 });
    });
  });
});
