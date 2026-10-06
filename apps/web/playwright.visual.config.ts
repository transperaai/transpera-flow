import { defineConfig } from "@playwright/test";
import { readFileSync } from "node:fs";

const baselines = process.env.VISUAL_BASELINES === "1";

// Baselines are only ever made in the pinned Playwright image, so they are byte-stable. A Playwright bump without an image bump
// would give slightly different pixels, so it fails loudly instead.
if (baselines) {
  // Read from the working directory (apps/web), where pnpm links the package: `require` and `import.meta` are both off the table in a config Playwright loads.
  const { version } = JSON.parse(readFileSync("node_modules/@playwright/test/package.json", "utf8")) as { version: string };
  if (process.env.PLAYWRIGHT_IMAGE !== `v${version}-noble`) {
    throw new Error(`VISUAL_BASELINES=1 needs PLAYWRIGHT_IMAGE=v${version}-noble (the image tag must match @playwright/test ${version}); got "${process.env.PLAYWRIGHT_IMAGE ?? ""}".`);
  }
}

export default defineConfig({
  testDir: "./visual",
  testMatch: "*.spec.ts",
  fullyParallel: true,
  workers: process.env.CI ? 4 : 2,
  retries: 0,
  forbidOnly: !!process.env.CI,
  timeout: 30_000,
  // Only the pinned container sets VISUAL_BASELINES=1, so a local run can never write or compare against the committed
  // baselines with the wrong Chromium.
  snapshotPathTemplate: baselines ? "{testDir}/__screenshots__/{arg}{ext}" : "{testDir}/.local-screenshots/{arg}{ext}",
  reporter: process.env.CI ? [["github"], ["list"], ["html", { open: "never", outputFolder: "playwright-report" }]] : "list",
  expect: {
    toHaveScreenshot: { animations: "disabled", caret: "hide", scale: "css", maxDiffPixels: 0, threshold: 0.2 },
  },
  use: {
    baseURL: "http://127.0.0.1:6007",
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
    locale: "en-GB",
    timezoneId: "Europe/London",
    reducedMotion: "reduce",
    launchOptions: { executablePath: process.env.VISUAL_BASELINES ? undefined : process.env.CHROMIUM_PATH || undefined },
  },
  webServer: {
    command: "node visual/serve.mjs storybook-static 6007",
    url: "http://127.0.0.1:6007/index.json",
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
