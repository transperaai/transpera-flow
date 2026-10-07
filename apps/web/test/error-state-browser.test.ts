import { readFileSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bundleHarness } from "./build-harness";

// The screen a page shows when it fails (issue #44), in a real browser: the real ErrorState bundled with esbuild (see
// ./build-harness.ts). It shows Next's reference for a server error, retries on "Try again", and links out to somewhere safe.

let browser: Browser;
let script: string;

beforeAll(async () => {
  script = await bundleHarness(new URL("./error-state-harness/entry.tsx", import.meta.url));
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
}, 120_000);

afterAll(async () => {
  await browser?.close();
});

async function mount(props: Parameters<Window["mountErrorState"]>[0] = {}): Promise<{ page: Page; errors: string[] }> {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.setContent(`<div id="root"></div>`);
  await page.addScriptTag({ content: script });
  await page.evaluate((p) => window.mountErrorState(p), props);
  return { page, errors };
}

describe("ErrorState in a browser", () => {
  it("shows the reference of a server error, an alert, and calls onRetry on Try again", async () => {
    const { page, errors } = await mount({ digest: "2814639521", homeHref: "/w/northbeam" });
    const alert = page.getByRole("alert");
    await alert.waitFor();
    expect(await alert.textContent()).toContain("Something went wrong");
    expect(await alert.textContent()).toContain("Reference: 2814639521");
    expect(await page.getByRole("link", { name: "Go to your workspaces" }).getAttribute("href")).toBe("/w/northbeam");
    expect(await page.evaluate(() => window.retries)).toBe(0);
    await page.getByRole("button", { name: "Try again" }).click();
    expect(await page.evaluate(() => window.retries)).toBe(1);
    expect(errors).toEqual([]);
    await page.close();
  });

  it("shows no reference without a digest, and links home by default", async () => {
    const { page } = await mount();
    await page.getByRole("alert").waitFor();
    expect(await page.getByRole("alert").textContent()).not.toContain("Reference");
    expect(await page.getByRole("link", { name: "Go to your workspaces" }).getAttribute("href")).toBe("/");
    await page.close();
  });

  it("has no Try again button when there is nothing to retry", async () => {
    const { page } = await mount({ withRetry: false });
    await page.getByRole("alert").waitFor();
    expect(await page.getByRole("button", { name: "Try again" }).count()).toBe(0);
    await page.close();
  });
});

describe("ErrorState's source", () => {
  it("imports no Sentry, so Storybook can render it", () => {
    const source = readFileSync(new URL("../src/components/shell/error-state.tsx", import.meta.url), "utf8");
    expect(source).not.toMatch(/@sentry/);
  });
});
