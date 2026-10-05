import { build } from "esbuild";
import { chromium, type Browser } from "playwright-core";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// "Missing for simulation" in a real browser (issue #167): the compact warning lists each gap in plain words, links each to its
// step or to Settings, each gap clears when its value is filled in, the warning goes when nothing is missing, and results carry
// "based on incomplete data" while any gap remains. The check itself is tested in packages/db/test/simulation-gaps.test.ts.

let browser: Browser;
let script: string;

beforeAll(async () => {
  const out = await build({
    entryPoints: [fileURLToPath(new URL("./gaps-harness/entry.tsx", import.meta.url))],
    bundle: true,
    format: "iife",
    platform: "browser",
    write: false,
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' },
    alias: { "@": fileURLToPath(new URL("../src", import.meta.url)) },
    logLevel: "silent",
  });
  script = out.outputFiles[0]!.text;
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
}, 120_000);

afterAll(async () => {
  await browser?.close();
});

async function mount(volume = false) {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.setContent(`<div id="root"></div>`);
  await page.addScriptTag({ content: script });
  await page.evaluate((v) => window.mountGaps({ volume: v }), volume);
  await page.waitForSelector("[data-results]");
  return { page, errors };
}

const lines = (page: Awaited<ReturnType<typeof mount>>["page"]) => page.locator("[data-gap-list] li").allInnerTexts();

describe("the Missing for simulation warning", () => {
  it("shows a compact count, opens to each gap in plain words, and says the results are based on incomplete data", async () => {
    const { page, errors } = await mount();
    expect((await page.locator("[data-missing-for-simulation] summary").innerText()).replace(/\s+/g, " ")).toContain("Missing for simulation (5)");
    expect(await page.locator("[data-missing-for-simulation]").evaluate((d) => (d as HTMLDetailsElement).open)).toBe(false);
    await page.locator("[data-missing-for-simulation] summary").click();
    expect(await lines(page)).toEqual([
      "Write proposal has no role",
      "Write proposal has no hands-on time",
      "Wait for payment has no wait time",
      "Client decides: branch odds missing",
      "No incoming volume: add lead volume in Settings or accept the suggestion",
    ]);
    expect(await page.locator("[data-incomplete-data]").innerText()).toBe("Based on incomplete data: 5 things are still missing for simulation (see the list above).");
    expect(errors).toEqual([]);
    await page.close();
  }, 60_000);

  it("each item links to its step, and the volume gap to the Settings section", async () => {
    const { page } = await mount();
    await page.locator("[data-missing-for-simulation] summary").click();
    await page.getByRole("button", { name: "Wait for payment has no wait time" }).click();
    expect(await page.evaluate(() => window.selected)).toEqual(["p"]);
    expect(await page.getByRole("link", { name: /No incoming volume/ }).getAttribute("href")).toBe("/w/acme/settings#demand");
    await page.close();
  }, 60_000);

  it("each gap clears once its value is filled in, and the warning and the note go with the last", async () => {
    const { page } = await mount(true);
    await page.locator("[data-missing-for-simulation] summary").click();
    expect(await lines(page)).toHaveLength(4);
    await page.getByRole("button", { name: "Give Write proposal a role" }).click();
    expect(await lines(page)).not.toContain("Write proposal has no role");
    await page.getByRole("button", { name: "Enter hands-on time" }).click();
    expect(await lines(page)).not.toContain("Write proposal has no hands-on time");
    await page.getByRole("button", { name: "Enter the wait" }).click();
    expect(await lines(page)).toEqual(["Client decides: branch odds missing"]);
    expect(await page.locator("[data-incomplete-data]").innerText()).toContain("1 thing is still missing");
    await page.getByRole("button", { name: "Enter the odds" }).click();
    expect(await page.locator("[data-missing-for-simulation]").count()).toBe(0);
    expect(await page.locator("[data-incomplete-data]").count()).toBe(0);
    await page.close();
  }, 60_000);
});
