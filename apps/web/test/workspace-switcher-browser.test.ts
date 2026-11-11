import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bundleHarness } from "./build-harness";

// The workspace switcher in a real browser (docs/adr/0024-one-workspace-per-deployment.md): with one workspace it is the name
// alone, nothing to open; with two or more it opens the list and "All workspaces".

let browser: Browser;
let script: string;

beforeAll(async () => {
  script = await bundleHarness(new URL("./switcher-harness/entry.tsx", import.meta.url));
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
}, 120_000);

afterAll(async () => {
  await browser?.close();
});

async function mount(count: number): Promise<{ page: Page; errors: string[] }> {
  const page = await browser.newPage({ viewport: { width: 1024, height: 700 } });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.setContent(`<div id="root"></div>`);
  await page.addScriptTag({ content: script });
  await page.evaluate((n) => window.mountSwitcher(n), count);
  return { page, errors };
}

describe("WorkspaceSwitcher", () => {
  it("with one workspace shows its name and opens no menu", async () => {
    const { page, errors } = await mount(1);
    const tile = page.locator("[data-workspace-name]");
    await tile.waitFor();
    expect(await tile.innerText()).toContain("Northbeam Digital");
    expect(await page.locator("button, [aria-haspopup]").count()).toBe(0);
    await tile.click();
    expect(await page.getByRole("menu").count()).toBe(0);
    expect(await page.getByText("All workspaces").count()).toBe(0);
    expect(await page.getByText("New workspace").count()).toBe(0);
    expect(errors).toEqual([]);
    await page.close();
  }, 60_000);

  it("with two workspaces opens the list and All workspaces", async () => {
    const { page, errors } = await mount(2);
    await page.getByRole("button", { name: "Workspace: Northbeam Digital" }).click();
    const menu = page.getByRole("menu");
    await menu.waitFor();
    expect(await menu.getByRole("menuitem").allInnerTexts()).toEqual(["Northbeam Digital", "Larkspur Studio", "All workspaces"]);
    expect(await page.locator("[data-workspace-name]").count()).toBe(0);
    expect(errors).toEqual([]);
    await page.close();
  }, 60_000);
});
