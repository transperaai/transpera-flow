import { mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser } from "playwright-core";
import { afterAll, beforeAll, describe, it } from "vitest";
import { bundleHarness } from "./build-harness";

// Screenshots for Q11 group B (not a check): `Q11B_SHOTS=<dir> pnpm vitest run test/q11b-shots.test.ts` saves the Set up and Settings pages
// at 1440 px light and dark and 400 px light. Skipped when Q11B_SHOTS is not set.
const dir = process.env.Q11B_SHOTS;
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
let css: string;

beforeAll(async () => {
  if (!dir) return;
  [script, css] = await Promise.all([bundleHarness(new URL("./q11b-shots-harness/entry.tsx", import.meta.url), META, { navigation: "navigation-url.ts" }), appCss()]);
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
}, 300_000);

afterAll(async () => {
  await browser?.close();
});

const PAGES = ["setup-clients", "setup-people", "settings", "purposes", "sidebar"];
const VIEWS = [
  { name: "light-1440", width: 1440, theme: "light" },
  { name: "dark-1440", width: 1440, theme: "dark" },
  { name: "light-400", width: 400, theme: "light" },
] as const;

describe("Q11 group B screenshots", () => {
  it.skipIf(!dir)("saves each page", async () => {
    mkdirSync(dir!, { recursive: true });
    for (const what of PAGES) {
      for (const v of VIEWS) {
        // The sidebar is a drawer on a phone: its tile is shown at desktop width only.
        if (what === "sidebar" && v.width < 1000) continue;
        const page = await browser.newPage({ viewport: { width: v.width, height: 1000 }, deviceScaleFactor: 2 });
        page.on("pageerror", (e) => console.log(what, "pageerror", e.message));
        await page.setContent(`<!doctype html><html data-theme="${v.theme}"><head><style>${css}</style></head><body><div id="root"></div></body></html>`);
        await page.addScriptTag({ content: script });
        await page.evaluate((w) => window.mountQ11b(w), what);
        await page.waitForSelector(what === "sidebar" ? "[data-sidebar]" : "h1", { timeout: 30_000 });
        await page.evaluate(() => document.fonts.ready);
        await page.setViewportSize({ width: v.width, height: await page.evaluate(() => document.documentElement.scrollHeight) });
        await page.screenshot({ path: `${dir}/${what}-${v.name}.png` });
        await page.close();
      }
    }
  }, 600_000);
});
