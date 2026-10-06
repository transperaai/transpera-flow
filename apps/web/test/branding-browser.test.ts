import { chromium, type Browser, type Page } from "playwright-core";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bundleHarness } from "./build-harness";

// Client branding (issue #34, B5) in a real browser: an owner types a colour that fails and is offered the nearest one that
// passes, resets, and sets a dark-mode colour of their own; a viewer can change nothing; the layout's <style> sets the tokens
// in both themes and takes them away again; the sidebar tile shows the logo, and the monogram when the logo won't load. The
// server is stood in for (branding-harness/entry.tsx); its writes are tested in branding-actions.test.ts and over Postgres in
// packages/db/test/branding.test.ts.

let browser: Browser;
let script: string;
const tokens = readFileSync(new URL("../src/styles/tokens.css", import.meta.url), "utf8");

beforeAll(async () => {
  script = await bundleHarness(new URL("./branding-harness/entry.tsx", import.meta.url));
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
}, 120_000);

afterAll(async () => {
  await browser?.close();
});

async function open(): Promise<{ page: Page; errors: string[] }> {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.setContent(`<div id="root"></div>`);
  await page.addStyleTag({ content: tokens });
  await page.addScriptTag({ content: script });
  return { page, errors };
}

type Opts = Parameters<Window["mountBranding"]>[0];
async function mount(opts: Opts) {
  const ctx = await open();
  await ctx.page.evaluate((o) => window.mountBranding(o), opts);
  await ctx.page.waitForSelector("#accent-heading");
  return ctx;
}
const calls = (page: Page) => page.evaluate(() => window.calls);
const token = (page: Page, name: string) => page.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name);

describe("the accent colour", () => {
  it("an owner types a colour that fails, is offered the nearest that passes, takes it, and resets", async () => {
    const { page, errors } = await mount({ mode: "live" });
    const box = page.getByRole("textbox", { name: "Accent colour", exact: true });
    await box.fill("#ffff00");
    await expect.poll(() => page.getByText(/Too light to read on a white page/).count()).toBe(1);
    // Nothing is saved while it fails.
    await box.press("Enter");
    await box.blur();
    expect(await calls(page)).toEqual([]);
    const use = page.getByRole("button", { name: /^Use #[0-9a-f]{6}$/ });
    const suggestion = (await use.innerText()).replace("Use ", "");
    await use.click();
    await expect.poll(() => calls(page)).toEqual([["accent", "light", null, suggestion]]);
    await expect.poll(() => page.getByText(/^Light theme: \d\.\d:1 on the page\. Passes\.$/).count()).toBe(1);
    expect(await box.inputValue()).toBe(suggestion);
    // The dark one is automatic, and passes.
    expect(await page.locator("[data-dark-readout]").innerText()).toMatch(/^Dark theme \(automatic\): #[0-9a-f]{6}, \d+\.\d:1 on the page\. Passes\.$/);

    await page.getByRole("button", { name: "Reset to default" }).click();
    await expect.poll(async () => (await calls(page)).at(-1)).toEqual(["accent", "light", suggestion, null]);
    expect(await box.inputValue()).toBe("");
    expect(errors).toEqual([]);
    await page.close();
  }, 60_000);

  it("saves a good colour on Enter, lower-cased and normalised; says what isn't a colour", async () => {
    const { page, errors } = await mount({ mode: "live" });
    const box = page.getByRole("textbox", { name: "Accent colour", exact: true });
    await box.fill("0B6E8A");
    await box.press("Enter");
    await expect.poll(() => calls(page)).toEqual([["accent", "light", null, "#0b6e8a"]]);
    await box.fill("red");
    await expect.poll(() => page.getByText("Enter a colour as six hex digits, like #0b6e8a.").count()).toBe(1);
    await box.press("Enter");
    expect(await calls(page)).toHaveLength(1);
    await box.press("Escape");
    expect(await box.inputValue()).toBe("#0b6e8a");
    expect(errors).toEqual([]);
    await page.close();
  }, 60_000);

  it("a dark-mode colour of its own: it must pass on the dark page, and Use automatic clears it", async () => {
    const { page, errors } = await mount({ mode: "live", branding: { accent: "#0b6e8a" } });
    await page.getByText("Use a different colour in dark mode").click();
    const dark = page.getByLabel("Dark mode accent", { exact: true });
    await dark.fill("#000080");
    await expect.poll(() => page.getByText(/Too dark to read on the dark page/).count()).toBe(1);
    await dark.press("Enter");
    expect(await calls(page)).toEqual([]);
    await dark.fill("#4cc3e0");
    await dark.press("Enter");
    await expect.poll(() => calls(page)).toEqual([["accent", "dark", null, "#4cc3e0"]]);
    expect(await page.locator("[data-dark-readout]").innerText()).toMatch(/^Dark theme \(your colour\): #4cc3e0, /);
    await page.getByRole("button", { name: "Use automatic" }).click();
    await expect.poll(async () => (await calls(page)).at(-1)).toEqual(["accent", "dark", "#4cc3e0", null]);
    expect(errors).toEqual([]);
    await page.close();
  }, 60_000);

  it("a saved colour that fails is shown with its readout and a fix, and says it isn't being used", async () => {
    const { page } = await mount({ mode: "live", branding: { accent: "#ffff00" } });
    await expect.poll(() => page.getByText(/Too light to read on a white page/).count()).toBe(1);
    expect(await page.getByText(/This saved colour isn't being used/).count()).toBe(1);
    await page.getByRole("button", { name: /^Use #[0-9a-f]{6}$/ }).click();
    await expect.poll(async () => (await calls(page)).at(-1)).toEqual(["accent", "light", "#ffff00", expect.stringMatching(/^#[0-9a-f]{6}$/)]);
    await page.close();
  }, 60_000);

  it("notes a colour close to the purple of editing screens, and still saves it", async () => {
    const { page } = await mount({ mode: "live" });
    const box = page.getByRole("textbox", { name: "Accent colour", exact: true });
    await box.fill("#6d3fc4");
    await expect.poll(() => page.getByText(/close to the purple that marks editing screens; people may misread it/).count()).toBe(1);
    await box.press("Enter");
    await expect.poll(() => calls(page)).toEqual([["accent", "light", null, "#6d3fc4"]]);
    await page.close();
  }, 60_000);
});

describe("the logo", () => {
  it("an owner uploads one, then removes it", async () => {
    const { page, errors } = await mount({ mode: "live" });
    await page.locator('input[type="file"]').setInputFiles({ name: "mark.png", mimeType: "image/png", buffer: Buffer.from("x") });
    await expect.poll(() => page.locator("[data-logo-status]").innerText()).toBe("Logo saved.");
    expect(await calls(page)).toEqual([["upload", "mark.png", "image/png", 1, null]]);
    expect(await page.locator("[data-logo-preview] img").count()).toBe(3);
    await page.getByRole("button", { name: "Upload logo" }).click({ trial: true });
    await page.getByRole("button", { name: "Remove" }).click();
    await expect.poll(() => page.locator("[data-logo-status]").innerText()).toBe("Logo removed.");
    expect((await calls(page)).at(-1)).toEqual(["remove", expect.stringMatching(/\.png$/)]);
    expect(await page.locator("[data-logo-preview] img").count()).toBe(0);
    expect(errors).toEqual([]);
    await page.close();
  }, 60_000);

  it("says why a logo was refused, and keeps what it had", async () => {
    const { page } = await mount({ mode: "live", upload: "error" });
    await page.locator('input[type="file"]').setInputFiles({ name: "big.png", mimeType: "image/png", buffer: Buffer.from("x") });
    await expect.poll(() => page.locator("[data-logo-status]").innerText()).toBe("That image is over 512 KB.");
    expect(await page.locator("[data-logo-preview] img").count()).toBe(0);
    await page.close();
  }, 60_000);
});

describe("a viewer", () => {
  it("sees the page and can change nothing", async () => {
    const { page, errors } = await mount({ mode: "readonly", branding: { accent: "#0b6e8a" } });
    expect(await page.getByRole("textbox", { name: "Accent colour", exact: true }).inputValue()).toBe("#0b6e8a");
    expect(await page.getByRole("textbox", { name: "Accent colour", exact: true }).isDisabled()).toBe(true);
    expect(await page.getByLabel("Accent colour, colour picker").isDisabled()).toBe(true);
    for (const name of ["Upload logo", "Remove", "Reset to default"]) expect(await page.getByRole("button", { name }).isDisabled(), name).toBe(true);
    expect(await page.getByText("Only workspace owners can change this.").count()).toBeGreaterThan(0);
    expect(errors).toEqual([]);
    await page.close();
  }, 60_000);
});

describe("the preview", () => {
  it("sets the tokens on its own panels only, in each theme", async () => {
    const { page } = await mount({ mode: "live", branding: { accent: "#0b6e8a", accent_dark: "#4cc3e0" } });
    const accentOf = (label: string) => page.getByRole("group", { name: label }).evaluate((el) => getComputedStyle(el).getPropertyValue("--accent").trim());
    expect(await accentOf("Light theme preview")).toBe("#0b6e8a");
    expect(await accentOf("Dark theme preview")).toBe("#4cc3e0");
    // The page itself is untouched.
    expect(await token(page, "--accent")).toBe("oklch(0.52 0.105 223.128)");
    await page.close();
  }, 60_000);
});

describe("the injected style", () => {
  it("sets --accent and --primary in the light theme and the dark one, and goes away when unmounted", async () => {
    const { page, errors } = await open();
    await page.evaluate(() => window.mountBranding({ mode: "live" }));
    const defaults = { accent: await token(page, "--accent"), primary: await token(page, "--primary") };
    expect(defaults.accent).toBe("oklch(0.52 0.105 223.128)");
    expect(defaults.primary).toBe(defaults.accent);

    const css = await page.evaluate(() => window.setBrandStyle({ accent: "#7a1fa2" }));
    expect(css).toMatch(/^:root\{--accent:#7a1fa2;/);
    const dark = /prefers-color-scheme: dark\)\{:root:not\(\[data-theme="light"\]\)\{--accent:(#[0-9a-f]{6});/.exec(css!)![1]!;
    await page.emulateMedia({ colorScheme: "light" });
    expect(await token(page, "--accent")).toBe("#7a1fa2");
    expect(await token(page, "--primary")).toBe("#7a1fa2");
    expect(await token(page, "--ring")).toBe("#7a1fa2");
    expect(await token(page, "--sidebar-primary")).toBe("#7a1fa2");
    await page.emulateMedia({ colorScheme: "dark" });
    expect(await token(page, "--accent")).toBe(dark);
    expect(await token(page, "--primary")).toBe(dark);
    // The rest of the theme is untouched: neutrals, status colours, the Editor's purple.
    expect(await token(page, "--bg")).toBe("oklch(0.145 0 0)");
    expect(await token(page, "--edit")).toBe("#a37ef0");

    // Switching to a workspace with no branding clears it, with no reload.
    await page.evaluate(() => window.setBrandStyle(null));
    expect(await page.locator("style[data-brand]").count()).toBe(0);
    expect(await token(page, "--accent")).toBe("oklch(0.715 0.143 215.221)");
    await page.emulateMedia({ colorScheme: "light" });
    expect(await token(page, "--accent")).toBe(defaults.accent);
    expect(await token(page, "--primary")).toBe(defaults.primary);
    expect(errors).toEqual([]);
    await page.close();
  }, 60_000);

  it("a data-theme=dark page gets the dark colours; an accent that fails contrast is ignored", async () => {
    const { page } = await open();
    await page.evaluate(() => window.mountBranding({ mode: "live" }));
    await page.emulateMedia({ colorScheme: "light" });
    const css = await page.evaluate(() => window.setBrandStyle({ accent: "#0b6e8a", accent_dark: "#4cc3e0" }));
    expect(css).toContain(':root[data-theme="dark"]{--accent:#4cc3e0;');
    await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
    expect(await token(page, "--accent")).toBe("#4cc3e0");
    await page.evaluate(() => document.documentElement.removeAttribute("data-theme"));
    // A stored colour that fails contrast is not applied at all.
    expect(await page.evaluate(() => window.setBrandStyle({ accent: "#ffff00", accent_dark: "#000080" }))).toMatch(/^@media/);
    expect(await token(page, "--accent")).toBe("oklch(0.52 0.105 223.128)");
    await page.close();
  }, 60_000);
});

describe("the workspace switcher", () => {
  it("shows the logo on a white tile, and falls back to the monogram when it won't load", async () => {
    const { page, errors } = await open();
    const pixel = await page.evaluate(() => {
      window.mountSwitcher("data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==");
      return true;
    });
    expect(pixel).toBe(true);
    const trigger = page.getByRole("button", { name: "Workspace: Northbeam Digital" });
    await trigger.waitFor();
    await trigger.locator("img").waitFor();
    expect(await trigger.locator("img").getAttribute("alt")).toBe("");
    expect(await trigger.getByText("N", { exact: true }).count()).toBe(0);
    expect(errors).toEqual([]);

    await page.evaluate(() => window.mountSwitcher("data:image/png;base64,AAAA"));
    await expect.poll(() => trigger.locator("img").count()).toBe(0);
    expect(await trigger.getByText("N", { exact: true }).count()).toBe(1);

    await page.evaluate(() => window.mountSwitcher(null));
    await expect.poll(() => trigger.getByText("N", { exact: true }).count()).toBe(1);
    expect(await trigger.locator("img").count()).toBe(0);
    await page.close();
  }, 60_000);
});
