import { mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, it } from "vitest";
import { bundleHarness } from "./build-harness";
import type { TourHarnessOptions } from "./tour-harness/entry";

// Screenshots for Automate… and Augment… in the step panel (not a check): `PARTB_SHOTS=<dir> pnpm vitest run test/part-b-shots.test.ts` saves the step panel on a solution's
// version, the automate form filled in, a step with a saved change and the live process's prompt, at 1440 px, light and dark, at device scale 2.
const dir = process.env.PARTB_SHOTS;

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
let css: string;
const DISCOVERY = "e0000000-0000-4000-8000-000000000002";

beforeAll(async () => {
  if (!dir) return;
  [script, css] = await Promise.all([bundleHarness(new URL("./tour-harness/entry.tsx", import.meta.url)), appCss()]);
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
}, 300_000);

afterAll(async () => {
  await browser?.close();
});

async function open(theme: "light" | "dark", options: TourHarnessOptions = {}): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: theme });
  const page = await context.newPage();
  await page.route("https://shots.test/", (route) =>
    route.fulfill({ contentType: "text/html", body: `<!doctype html><html data-theme="${theme}"><head><meta name="viewport" content="width=device-width"><style>${css}</style></head><body><div id="root"></div></body></html>` }),
  );
  await page.goto("https://shots.test/");
  await page.addScriptTag({ content: script });
  await page.evaluate((o) => window.mountEditor(o), { userId: "user-a", dismissed: true, ...options });
  await page.waitForSelector("[data-editor]");
  await page.waitForSelector(".react-flow__node");
  await page.waitForTimeout(1500);
  return page;
}


const select = async (page: Page, id: string) => {
  await page.locator(".react-flow__pane").click({ position: { x: 5, y: 5 } });
  await page.locator(`.react-flow__node[data-id="${id}"]`).click({ force: true });
  await page.locator('aside[aria-label="Inspector"]').waitFor();
};
const settle = async (page: Page) => {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(600);
};
const showSection = async (page: Page) => {
  await page.locator("[data-slot=changes-on-step]").evaluate((el) => el.scrollIntoView({ block: "end" }));
  await settle(page);
};
const CHANGE = {
  id: "0b8f6f0e-6d0a-4d5e-9d57-2f1d1d2a9c11",
  name: "Check the pacing by machine",
  kind: "automation" as const,
  effects: [{ step: DISCOVERY, part: "automatable" as const, remove: 0.85, residualHours: 2 / 60 }],
  adoption: 0.7,
  ramp_months: 3,
  tiers: null,
  cost_monthly: 400,
};

describe("step change screenshots", () => {
  for (const theme of ["light", "dark"] as const) {
    it.skipIf(!dir)(`saves a solution's step panel with Automate and Augment (${theme})`, async () => {
      mkdirSync(dir!, { recursive: true });
      const page = await open(theme, { editorMode: "solution", solutionChanges: [] });
      await select(page, DISCOVERY);
      await showSection(page);
      await page.screenshot({ path: `${dir}/solution-step-panel-1440-${theme}.png` });
      await page.context().close();
    }, 300_000);

    it.skipIf(!dir)(`saves the automate form filled in (${theme})`, async () => {
      const page = await open(theme, { editorMode: "solution", solutionChanges: [] });
      await select(page, DISCOVERY);
      await page.locator("[data-change-automate]").click({ force: true });
      const dialog = page.locator("[data-step-change-dialog]");
      await dialog.waitFor();
      await dialog.locator("[data-change-name]").fill(CHANGE.name);
      await dialog.locator("[data-change-share]").fill("85");
      await dialog.locator("[data-change-checking]").fill("2");
      await dialog.locator("[data-change-adoption]").fill("70");
      await dialog.locator("[data-change-ramp]").fill("3");
      await dialog.locator("[data-change-cost]").fill("400");
      await dialog.getByLabel("T2").check();
      await settle(page);
      await page.screenshot({ path: `${dir}/automate-form-1440-${theme}.png` });
      await page.context().close();
    }, 300_000);

    it.skipIf(!dir)(`saves a step with a saved change (${theme})`, async () => {
      const page = await open(theme, { editorMode: "solution", solutionChanges: [CHANGE] });
      await select(page, DISCOVERY);
      await showSection(page);
      await page.screenshot({ path: `${dir}/step-with-change-1440-${theme}.png` });
      await page.context().close();
    }, 300_000);

    it.skipIf(!dir)(`saves the live process's Make a solution prompt (${theme})`, async () => {
      const page = await open(theme, { makeSolution: true });
      await select(page, DISCOVERY);
      await showSection(page);
      await page.screenshot({ path: `${dir}/make-a-solution-1440-${theme}.png` });
      await page.context().close();
    }, 300_000);
  }
});
