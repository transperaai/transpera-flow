import { mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, it } from "vitest";
import { bundleHarness } from "./build-harness";

// Screenshots for the editor quick fixes (not a check): `QUICK_SHOTS=<dir> pnpm vitest run test/quick-shots.test.ts` saves the New process
// dialog and the editor bar (with undo and redo) at 1440 px, light and dark, at device scale 2. Skipped when QUICK_SHOTS is not set.
const dir = process.env.QUICK_SHOTS;

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
let admin: string;
let editor: string;
let css: string;

beforeAll(async () => {
  if (!dir) return;
  [admin, editor, css] = await Promise.all([
    bundleHarness(new URL("./process-admin-harness/entry.tsx", import.meta.url)),
    bundleHarness(new URL("./tour-harness/entry.tsx", import.meta.url)),
    appCss(),
  ]);
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
}, 300_000);

afterAll(async () => {
  await browser?.close();
});

async function open(theme: "light" | "dark"): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: theme });
  const page = await context.newPage();
  await page.route("https://shots.test/", (route) => route.fulfill({ contentType: "text/html", body: `<!doctype html><html data-theme="${theme}"><head><meta name="viewport" content="width=device-width"><style>${css}</style></head><body><div id="root"></div></body></html>` }));
  await page.goto("https://shots.test/");
  return page;
}

describe("quick fixes screenshots", () => {
  for (const theme of ["light", "dark"] as const) {
    it.skipIf(!dir)(`saves the New process dialog and the editor bar (${theme})`, async () => {
      mkdirSync(dir!, { recursive: true });
      let page = await open(theme);
      await page.addScriptTag({ content: admin });
      await page.evaluate(() => window.mountProcessAdmin({ canEdit: true }));
      await page.waitForSelector("[data-process]");
      await page.getByRole("button", { name: "New process" }).click();
      await page.getByRole("dialog").waitFor();
      await page.getByLabel("Name").fill("Quarterly review");
      await page.getByRole("radio", { name: /Routine client work/ }).check();
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(400);
      await page.screenshot({ path: `${dir}/new-process-dialog-1440-${theme}.png` });
      await page.context().close();

      page = await open(theme);
      await page.addScriptTag({ content: editor });
      await page.evaluate(() => window.mountEditor({ userId: "user-a", dismissed: true }));
      await page.waitForSelector("[data-editor]");
      await page.waitForSelector(".react-flow__node");
      // Let the demo draft open before the first edit.
      await page.waitForTimeout(1500);
      await page.getByRole("button", { name: "+ Step", exact: true }).click();
      await page.waitForFunction(() => document.querySelector("[data-undo]:not([disabled])"));
      await page.getByRole("button", { name: "+ Step", exact: true }).click();
      await page.locator("[data-undo]").click();
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(500);
      await page.screenshot({ path: `${dir}/editor-bar-1440-${theme}.png` });
      await page.screenshot({ path: `${dir}/editor-bar-crop-1440-${theme}.png`, clip: { x: 0, y: 0, width: 1440, height: 120 } });
      await page.context().close();
    }, 300_000);
  }
});
