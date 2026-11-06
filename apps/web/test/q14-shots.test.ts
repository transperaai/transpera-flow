import { mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser } from "playwright-core";
import { afterAll, beforeAll, describe, it } from "vitest";
import { bundleHarness } from "./build-harness";

// Screenshots for Q14 (not a check): `Q14_SHOTS=<dir> pnpm vitest run test/q14-shots.test.ts` saves People & roles, a client-facing person's
// panel, a shared-team person's panel and a role's panel at 1440 px light and dark and 400 px light. Skipped when Q14_SHOTS is not set.
const dir = process.env.Q14_SHOTS;
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
  [script, css] = await Promise.all([bundleHarness(new URL("./q14-shots-harness/entry.tsx", import.meta.url), META), appCss()]);
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
}, 300_000);

afterAll(async () => {
  await browser?.close();
});

const VIEWS = [
  { name: "light-1440", width: 1440, theme: "light" },
  { name: "dark-1440", width: 1440, theme: "dark" },
  { name: "light-400", width: 400, theme: "light" },
] as const;
const SHOTS: { name: string; open?: "facing" | "shared"; role?: string }[] = [
  { name: "page" },
  { name: "panel-client-facing", open: "facing" },
  { name: "panel-shared-team", open: "shared" },
  { name: "panel-role", role: "SEO Manager" },
];

describe("Q14 screenshots", () => {
  it.skipIf(!dir)("saves the page and the panels", async () => {
    mkdirSync(dir!, { recursive: true });
    for (const shot of SHOTS) {
      for (const v of VIEWS) {
        const page = await browser.newPage({ viewport: { width: v.width, height: 1000 } });
        page.on("pageerror", (e) => console.log(shot.name, "pageerror", e.message));
        await page.setContent(`<!doctype html><html data-theme="${v.theme}"><head><style>${css}</style></head><body><div id="root"></div></body></html>`);
        await page.addScriptTag({ content: script });
        await page.evaluate((o) => window.mountQ14(o), { open: shot.open, role: shot.role });
        await page.waitForSelector("h1", { timeout: 30_000 });
        await page.waitForTimeout(800);
        await page.evaluate(() => document.fonts.ready);
        if (!shot.open && !shot.role) await page.setViewportSize({ width: v.width, height: Math.min(3000, await page.evaluate(() => document.documentElement.scrollHeight)) });
        await page.screenshot({ path: `${dir}/${shot.name}-${v.name}.png` });
        await page.close();
      }
    }
  }, 600_000);
});
