import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bundleHarness } from "./build-harness";

// Phones are read only (issue #44), in a real browser: under 640px a form is disabled with one notice and the Editor is
// replaced by a notice; at 640px and wider nothing changes; turning the phone sideways re-enables everything live.

let browser: Browser;
let script: string;

beforeAll(async () => {
  script = await bundleHarness(new URL("./phone-harness/entry.tsx", import.meta.url));
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
}, 120_000);

afterAll(async () => {
  await browser?.close();
});

async function mount(what: Parameters<Window["mountPhone"]>[0], width: number): Promise<{ page: Page; errors: string[] }> {
  const page = await browser.newPage({ viewport: { width, height: 800 } });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.setContent(`<div id="root"></div>`);
  await page.addScriptTag({ content: script });
  await page.evaluate((w) => window.mountPhone(w), what);
  return { page, errors };
}

describe("PhoneReadOnly", () => {
  it("at 400px disables the fields and the buttons, and says why once", async () => {
    const { page, errors } = await mount("form", 400);
    await page.waitForSelector("[data-phone-read-only]");
    expect(await page.locator("input[name=name]").isDisabled()).toBe(true);
    expect(await page.getByRole("button", { name: "Save" }).isDisabled()).toBe(true);
    expect(await page.locator("[data-phone-notice]").count()).toBe(1);
    expect(await page.locator("[data-phone-notice]").innerText()).toMatch(/^Read only on a phone\./);
    expect(errors).toEqual([]);
    await page.close();
  }, 60_000);

  it("at 1024px leaves the form enabled and shows no notice", async () => {
    const { page, errors } = await mount("form", 1024);
    await page.waitForSelector("input[name=name]");
    expect(await page.locator("input[name=name]").isEnabled()).toBe(true);
    expect(await page.locator("[data-phone-notice], [data-phone-read-only]").count()).toBe(0);
    expect(errors).toEqual([]);
    await page.close();
  }, 60_000);

  it("at 639px is a phone and at 640px is not (the line is Tailwind's sm)", async () => {
    const a = await mount("form", 639);
    await a.page.waitForSelector("[data-phone-read-only]");
    await a.page.close();
    const b = await mount("form", 640);
    await b.page.waitForSelector("input[name=name]");
    expect(await b.page.locator("[data-phone-read-only]").count()).toBe(0);
    await b.page.close();
  }, 60_000);

  it("turning the phone sideways enables the form live, and back disables it again", async () => {
    const { page } = await mount("form", 400);
    await page.waitForSelector("[data-phone-read-only]");
    await page.setViewportSize({ width: 800, height: 400 });
    await expect.poll(() => page.locator("input[name=name]").isEnabled()).toBe(true);
    expect(await page.locator("[data-phone-notice]").count()).toBe(0);
    await page.setViewportSize({ width: 400, height: 800 });
    await expect.poll(() => page.locator("input[name=name]").isDisabled()).toBe(true);
    await page.close();
  }, 60_000);

  it("notice={false} disables the form and shows no notice of its own", async () => {
    const { page } = await mount("form-no-notice", 400);
    await page.waitForSelector("[data-phone-read-only]");
    expect(await page.locator("input[name=name]").isDisabled()).toBe(true);
    expect(await page.locator("[data-phone-notice]").count()).toBe(0);
    await page.close();
  }, 60_000);

  it("writes the notice into a status region that is there before it appears, so it is announced", async () => {
    const wide = await mount("notice", 1024);
    await wide.page.waitForSelector("[role=status]", { state: "attached" });
    expect(await wide.page.locator("[role=status]").count()).toBe(1);
    expect(await wide.page.locator("[role=status]").innerText()).toBe("");
    await wide.page.close();
    const phone = await mount("notice", 400);
    await phone.page.waitForSelector("[role=status] [data-phone-notice]");
    expect(await phone.page.locator("[role=status]").count()).toBe(1);
    await phone.page.close();
  }, 60_000);

  it("a disabled form takes its controls out of the tab order: Tab moves past them", async () => {
    const { page } = await mount("form", 400);
    await page.waitForSelector("[data-phone-read-only]");
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => document.activeElement?.tagName)).toBe("A");
    await page.close();
  }, 60_000);

  it("PhoneNotice alone shows only on a phone", async () => {
    const phone = await mount("notice", 400);
    await phone.page.waitForSelector("[data-phone-notice]");
    await phone.page.close();
    const wide = await mount("notice", 1024);
    await wide.page.waitForTimeout(200);
    expect(await wide.page.locator("[data-phone-notice]").count()).toBe(0);
    await wide.page.close();
  }, 60_000);
});

describe("EditorPhoneGate", () => {
  it("at 400px replaces the Editor with the notice and a way back", async () => {
    const { page, errors } = await mount("gate", 400);
    await page.waitForSelector("[data-phone-gate]");
    expect(await page.locator("[data-editor-child]").count()).toBe(0);
    expect(await page.getByText("Editing needs a wider screen").count()).toBe(1);
    expect(await page.getByRole("link", { name: "Back to the process" }).getAttribute("href")).toBe("/demo/p/1");
    // Announced: the notice sits in a status region.
    expect(await page.locator("[role=status] [data-phone-gate]").count()).toBe(1);
    expect(errors).toEqual([]);
    await page.close();
  }, 60_000);

  it("at 768px shows the Editor", async () => {
    const { page } = await mount("gate", 768);
    await page.waitForSelector("[data-editor-child]");
    expect(await page.locator("[data-phone-gate]").count()).toBe(0);
    await page.close();
  }, 60_000);
});
