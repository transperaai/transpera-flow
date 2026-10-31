import { defineConfig } from "@playwright/test";

// Crawls every demo page at phone, tablet and dark settings against `next start` (issue #44). Needs a finished `next build`
// made WITHOUT NEXT_PUBLIC_ settings that change the app; the server below runs without a database or auth secret, which is demo mode.
export default defineConfig({
  testDir: "./e2e",
  testMatch: "*.spec.ts",
  fullyParallel: true,
  workers: process.env.CI ? 2 : 1,
  retries: 0,
  forbidOnly: !!process.env.CI,
  timeout: 60_000,
  reporter: process.env.CI ? [["github"], ["list"], ["html", { open: "never", outputFolder: "playwright-report" }]] : "list",
  use: {
    baseURL: "http://127.0.0.1:3210",
    locale: "en-GB",
    timezoneId: "Europe/London",
    launchOptions: { executablePath: process.env.CHROMIUM_PATH || undefined },
  },
  webServer: {
    command: "pnpm exec next start -p 3210 -H 127.0.0.1",
    url: "http://127.0.0.1:3210/privacy",
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    // No database URL or auth secret (lib/auth/env.ts treats "" as unset), even where CI sets DATABASE_URL: only the pages that need no sign-in open.
    env: { DATABASE_URL: "", BETTER_AUTH_SECRET: "" },
  },
});
