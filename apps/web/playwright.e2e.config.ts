import { defineConfig } from "@playwright/test";

// Crawls every demo page at phone, tablet and dark settings against `next start` (issue #44). Needs a finished `next build`
// made WITHOUT Supabase settings (a build with them inlines them, and the demo then wouldn't be the demo).
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
    url: "http://127.0.0.1:3210/demo",
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    // Empty Supabase settings force demo mode (lib/supabase/env.ts treats "" as unset).
    env: { NEXT_PUBLIC_SUPABASE_URL: "", NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "" },
  },
});
