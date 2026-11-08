import { mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, it } from "vitest";
import { bundleHarness } from "./build-harness";
import type { TourHarnessOptions } from "./tour-harness/entry";

// Screenshots for the simpler editor (not a check): `SIMPLIFY_SHOTS=<dir> pnpm vitest run test/simplify-shots.test.ts` saves the editor with each
// node type, a decision with three branches and a go back, a problem mark, and the new-purpose form, at 1440 px, light and dark, at device scale 2.
// Skipped when SIMPLIFY_SHOTS is not set.
const dir = process.env.SIMPLIFY_SHOTS;

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
const AUDIT = "e0000000-0000-4000-8000-000000000003";
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

const node = (page: Page, id: string) => page.locator(`.react-flow__node[data-id="${id}"]`);
const pick = async (page: Page, id: string) => {
  await page.locator(".react-flow__pane").click({ position: { x: 5, y: 5 } });
  await node(page, id).click({ force: true });
};
const settle = async (page: Page) => {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(600);
};
const fit = async (page: Page) => {
  await page.getByRole("button", { name: /^Fit/ }).click();
  await settle(page);
};

describe("simpler editor screenshots", () => {
  for (const theme of ["light", "dark"] as const) {
    it.skipIf(!dir)(`saves the editor with each node type (${theme})`, async () => {
      mkdirSync(dir!, { recursive: true });
      const page = await open(theme);
      await pick(page, AUDIT);
      await page.getByRole("button", { name: "+ Wait", exact: true }).click();
      await fit(page);
      await page.screenshot({ path: `${dir}/node-types-1440-${theme}.png` });
      await page.context().close();
    }, 300_000);

    it.skipIf(!dir)(`saves a decision with three branches and a go back (${theme})`, async () => {
      const page = await open(theme);
      await pick(page, AUDIT);
      await page.getByRole("button", { name: "+ Decision", exact: true }).click();
      const panel = page.locator("[data-decision-panel]");
      await panel.waitFor();
      await page.getByRole("button", { name: "+ Add branch" }).click();
      await panel.locator("[data-branch]").nth(0).getByLabel("Name", { exact: true }).fill("Needs changes");
      await panel.locator("[data-branch]").nth(0).getByLabel("Name", { exact: true }).press("Enter");
      await panel.locator("[data-branch]").nth(0).getByLabel("Branch 1 goes to").selectOption({ value: `back:${AUDIT}` });
      await panel.locator("[data-branch]").nth(1).getByLabel("Name", { exact: true }).fill("Approved");
      await panel.locator("[data-branch]").nth(1).getByLabel("Name", { exact: true }).press("Enter");
      await panel.locator("[data-branch]").nth(2).getByLabel("Name", { exact: true }).fill("Dropped");
      await panel.locator("[data-branch]").nth(2).getByLabel("Name", { exact: true }).press("Enter");
      await panel.locator("[data-branch]").nth(2).getByLabel("Branch 3 goes to").selectOption({ label: "Lost" });
      await panel.locator("[data-branch]").nth(1).getByLabel("Share", { exact: true }).fill("60");
      await panel.locator("[data-branch]").nth(1).getByLabel("Share", { exact: true }).press("Enter");
      await page.locator('[data-tile="goback"]').waitFor();
      await fit(page);
      await page.locator("[data-branch-row]").first().click({ force: true });
      await settle(page);
      await page.screenshot({ path: `${dir}/decision-go-back-1440-${theme}.png` });
      await page.context().close();
    }, 300_000);

    it.skipIf(!dir)(`saves a problem mark with its reasons and the bar's line (${theme})`, async () => {
      const page = await open(theme);
      await pick(page, DISCOVERY);
      await page.getByRole("button", { name: "+ Step", exact: true }).click();
      await page.locator("[data-problems-line]").waitFor();
      // The new step stands by itself: nothing leaves it.
      await page.locator("[data-problem-mark] [role=img]").first().scrollIntoViewIfNeeded();
      await page.locator("[data-problem-mark] [role=img]").first().hover({ force: true });
      await settle(page);
      await page.screenshot({ path: `${dir}/problem-mark-1440-${theme}.png` });
      // Publish is disabled while something is left to fix (its reason is the button's tooltip, which a screenshot doesn't draw).
      await page.getByRole("button", { name: "Publish…" }).hover({ force: true });
      await settle(page);
      await page.screenshot({ path: `${dir}/publish-blocked-1440-${theme}.png`, clip: { x: 0, y: 0, width: 1440, height: 130 } });
      await page.context().close();
    }, 300_000);

    it.skipIf(!dir || theme === "dark")(`saves a step's inspector at Done again (${theme})`, async () => {
      const page = await open(theme);
      await pick(page, DISCOVERY);
      await page.getByLabel("Done again", { exact: false }).first().evaluate((el) => el.scrollIntoView({ block: "center" }));
      await settle(page);
      await page.screenshot({ path: `${dir}/step-rework-1440-${theme}.png` });
      await page.context().close();
    }, 300_000);

    it.skipIf(!dir || theme === "dark")(`saves the company map's left column (${theme})`, async () => {
      const page = await open(theme, { company: true });
      await page.locator("[data-library-new-name]").fill("Client offboarding");
      await page.locator("[data-library-new-category]").selectOption("onboarding");
      await page.locator("[data-library-new-category]").scrollIntoViewIfNeeded();
      await settle(page);
      await page.screenshot({ path: `${dir}/company-map-left-column-1440-${theme}.png` });
      await page.context().close();
    }, 300_000);

    it.skipIf(!dir)(`saves the new-purpose form (${theme})`, async () => {
      const page = await open(theme, { canAddPurpose: true });
      await pick(page, DISCOVERY);
      await page.locator("[data-new-purpose]").click();
      const form = page.locator("[data-new-purpose-form]");
      await form.getByRole("textbox", { name: "Name" }).fill("Chasing the client");
      await form.getByRole("textbox", { name: "Description" }).fill("Emails and calls to get answers or sign-off");
      await form.scrollIntoViewIfNeeded();
      await settle(page);
      await page.screenshot({ path: `${dir}/new-purpose-1440-${theme}.png` });
      await page.context().close();
    }, 300_000);
  }
});
