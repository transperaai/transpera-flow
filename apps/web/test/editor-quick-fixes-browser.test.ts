import { mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bundleHarness } from "./build-harness";
import type { TourHarnessOptions } from "./tour-harness/entry";

// Austin's editor QA (7 Nov), in a real browser on the real Editor (demo mode) and the real New process dialog: Undo and Redo on
// the editor bar, disabled when there is nothing to take back or put back and named by the edit in their tooltip; the palette
// with no "+ Group". With QUICK_FIXES_SHOTS=<dir> it also saves the screenshots (the dialog and the editor bar, at 1440 px,
// light and dark).

const shots = process.env.QUICK_FIXES_SHOTS;

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
let editorScript: string;
let adminScript: string;
let css: string;

beforeAll(async () => {
  [editorScript, adminScript, css] = await Promise.all([
    bundleHarness(new URL("./tour-harness/entry.tsx", import.meta.url)),
    bundleHarness(new URL("./process-admin-harness/entry.tsx", import.meta.url)),
    appCss(),
  ]);
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
}, 300_000);

afterAll(async () => {
  await browser?.close();
});

const ORIGIN = "https://editor.test/";

async function open(mount: (page: Page) => Promise<void>, ready: string, scheme: "light" | "dark" = "light"): Promise<{ page: Page; errors: string[] }> {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: scheme, deviceScaleFactor: shots ? 2 : 1 });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.route(ORIGIN, (route) => route.fulfill({ contentType: "text/html", body: `<!doctype html><meta name="viewport" content="width=device-width"><div id="root"></div>` }));
  await page.goto(ORIGIN);
  await page.addStyleTag({ content: css });
  await mount(page);
  await page.waitForSelector(ready);
  await page.evaluate(() => document.fonts.ready);
  return { page, errors };
}

const editor = (scheme?: "light" | "dark") =>
  open(
    async (page) => {
      await page.addScriptTag({ content: editorScript });
      // The tour has been seen already, so it does not cover the bar.
      await page.evaluate((o) => window.mountEditor(o), { dismissed: true } satisfies TourHarnessOptions);
    },
    ".react-flow__node",
    scheme,
  );

const admin = (scheme?: "light" | "dark") =>
  open(
    async (page) => {
      await page.addScriptTag({ content: adminScript });
      await page.evaluate(() => window.mountProcessAdmin({ canEdit: true }));
    },
    "[data-process]",
    scheme,
  );

const undo = (page: Page) => page.locator("[data-history=undo]");
const redo = (page: Page) => page.locator("[data-history=redo]");
const nodes = (page: Page) => page.locator(".react-flow__node").count();
/** The tooltip a button shows on hover, read from its wrapper (a disabled button takes no pointer events). */
async function tip(page: Page, which: "undo" | "redo"): Promise<string> {
  // Let the last tooltip close first, so the one read is this button's.
  await page.mouse.move(720, 160, { steps: 8 });
  await page.locator("[data-slot=tooltip-content]").waitFor({ state: "detached" });
  await page.locator(`[data-history-tip=${which}]`).hover();
  const t = page.locator("[data-slot=tooltip-content]");
  await t.waitFor();
  return (await t.innerText()).trim();
}

describe("Undo and Redo on the editor bar", () => {
  it("are disabled with nothing to undo or redo, name the edit in their tooltip, and undo and redo it", async () => {
    const { page, errors } = await editor();
    const bar = page.locator("header [data-undo-redo]");
    expect(await bar.count()).toBe(1);
    expect(await undo(page).isDisabled()).toBe(true);
    expect(await redo(page).isDisabled()).toBe(true);
    expect(await tip(page, "undo")).toBe("Nothing to undo");
    expect(await tip(page, "redo")).toBe("Nothing to redo");

    const before = await nodes(page);
    await page.getByRole("button", { name: "+ Step", exact: true }).click();
    await expect.poll(() => nodes(page)).toBe(before + 1);
    expect(await undo(page).isDisabled()).toBe(false);
    expect(await redo(page).isDisabled()).toBe(true);
    expect(await tip(page, "undo")).toBe("Undo: Added New task");
    expect(await undo(page).getAttribute("aria-label")).toBe("Undo: Added New task");

    await undo(page).click();
    await expect.poll(() => nodes(page)).toBe(before);
    expect(await undo(page).isDisabled()).toBe(true);
    expect(await redo(page).isDisabled()).toBe(false);
    expect(await tip(page, "redo")).toBe("Redo: Added New task");

    await redo(page).click();
    await expect.poll(() => nodes(page)).toBe(before + 1);
    expect(await undo(page).isDisabled()).toBe(false);
    expect(await redo(page).isDisabled()).toBe(true);
    expect(errors).toEqual([]);
    await page.close();
  }, 120_000);

  it("the palette adds steps, decisions and waits, and no longer an empty group; grouping stays", async () => {
    const { page } = await editor();
    const add = page.locator('section[aria-label="Add to the process"]');
    expect((await add.getByRole("button").allInnerTexts()).filter((t) => t.startsWith("+"))).toEqual(["+ Step", "+ Decision", "+ Wait", "+ Process"]);
    expect(await page.getByRole("button", { name: "Group selected steps" }).count()).toBe(1);
    expect(await page.getByRole("button", { name: "Ungroup" }).count()).toBe(1);
    await page.close();
  }, 120_000);
});

describe.skipIf(!shots)("screenshots for Austin", () => {
  for (const scheme of ["light", "dark"] as const) {
    it(`the New process dialog and the editor bar, 1440 ${scheme}`, async () => {
      mkdirSync(shots!, { recursive: true });
      const a = await admin(scheme);
      await a.page.getByRole("button", { name: "New process" }).click();
      const dialog = a.page.getByRole("dialog");
      await dialog.getByLabel("Name").fill("Client onboarding");
      await dialog.getByRole("radio", { name: /Onboarding/ }).check();
      await a.page.waitForTimeout(400);
      await a.page.screenshot({ path: `${shots}/dialog-${scheme}-1440.png` });
      expect(a.errors).toEqual([]);
      await a.page.close();

      const e = await editor(scheme);
      await e.page.getByRole("button", { name: "+ Step", exact: true }).click();
      await e.page.waitForTimeout(400);
      expect(await tip(e.page, "undo")).toBe("Undo: Added New task");
      await e.page.waitForTimeout(300);
      await e.page.screenshot({ path: `${shots}/editor-bar-${scheme}-1440.png` });
      expect(e.errors).toEqual([]);
      await e.page.close();
    }, 300_000);
  }
});
