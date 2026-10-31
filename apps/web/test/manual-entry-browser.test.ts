import { build } from "esbuild";
import { chromium, type Browser, type Page } from "playwright-core";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Adding things by hand (issue #182, B19) in a real browser: an editor edits a named client (the part of a Set up row under "More"), gives it
// services and someone to look after it, and makes it inactive (there is no delete; adding one and the inactive list are tested in
// setup-browser.test.ts); an owner changes the workspace's name
// and currency; an editor deletes a solution after a confirm (saved scenarios are deleted in the Sandbox now). A viewer sees everything and can change
// nothing. The server is stood in for (manual-harness/entry.tsx); the writes are tested over PostgREST in
// packages/mcp/test/postgrest-manual-entry.test.ts.

let browser: Browser;
let script: string;

beforeAll(async () => {
  const out = await build({
    entryPoints: [fileURLToPath(new URL("./manual-harness/entry.tsx", import.meta.url))],
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

async function mount(opts: { canEdit: boolean; canManage: boolean }): Promise<{ page: Page; errors: string[] }> {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.setContent(`<div id="root"></div>`);
  await page.addScriptTag({ content: script });
  await page.evaluate((o) => window.mountManual(o), opts);
  await page.waitForSelector("#clients-heading");
  return { page, errors };
}

const calls = (page: Page) => page.evaluate(() => window.calls);

describe("a named client's fields", () => {
  it("an editor edits a client, sets its services and who looks after it, and makes it inactive (there is no delete)", async () => {
    const { page, errors } = await mount({ canEdit: true, canManage: false });
    const row = page.locator('[data-client="Harbour Lane Dental"]');
    await row.locator("summary").click();
    await row.getByLabel("PPC", { exact: true }).check();
    await row.getByLabel("Account director", { exact: true }).selectOption({ label: "Maya Collins" });
    await row.getByLabel("MRR", { exact: true }).fill("2600");
    await row.getByLabel("MRR", { exact: true }).press("Enter");
    await row.getByLabel("Status", { exact: true }).click();
    await expect.poll(() => calls(page)).toEqual(
      expect.arrayContaining([
        ["services", expect.any(String), expect.any(String), expect.arrayContaining(["10000000-0000-4000-8000-000000000002"])],
        ["assignment", expect.any(String), expect.any(String), "20000000-0000-4000-8000-000000000001", "30000000-0000-4000-8000-000000000001"],
        ["field", expect.any(String), "mrr", 2600],
        ["field", expect.any(String), "active", false],
      ]),
    );
    // Only the role's own people are offered, and "shared" is the way to name nobody.
    expect(await row.getByLabel("Account manager", { exact: true }).locator("option").allInnerTexts()).toEqual(["Shared by the role", "Tom Reid"]);
    expect(await row.getByRole("button", { name: /delete|remove/i }).count()).toBe(0);
    expect(errors).toEqual([]);
    await page.close();
  }, 60_000);
});

describe("the workspace's name and currency", () => {
  it("an owner changes both", async () => {
    const { page, errors } = await mount({ canEdit: true, canManage: true });
    const region = page.getByRole("region", { name: "Workspace" });
    await region.getByLabel("Name", { exact: true }).fill("Northbeam Digital");
    await region.getByLabel("Name", { exact: true }).press("Enter");
    await region.getByLabel("Currency", { exact: true }).selectOption("GBP");
    await expect.poll(() => calls(page)).toEqual([
      ["workspace name", "Northbeam Digital"],
      ["currency", "GBP"],
    ]);
    // Amounts are shown in the new currency.
    expect(await page.locator('[data-client="Harbour Lane Dental"] summary').innerText()).toContain("£3,600 a month");
    await page.locator('[data-client="Harbour Lane Dental"] summary').click();
    expect(await page.locator('[data-client="Harbour Lane Dental"]').innerText()).toContain("GBP a month");
    expect(errors).toEqual([]);
    await page.close();
  }, 60_000);

  it("an editor and a viewer see them but can't change them", async () => {
    for (const canEdit of [true, false]) {
      const { page } = await mount({ canEdit, canManage: false });
      const region = page.getByRole("region", { name: "Workspace" });
      expect(await region.getByLabel("Name", { exact: true }).isDisabled()).toBe(true);
      expect(await region.getByLabel("Currency", { exact: true }).isDisabled()).toBe(true);
      expect(await region.getByLabel("Overheads a month", { exact: true }).isDisabled()).toBe(true);
      expect(await region.getByText("Only Agency admins can change this.").count()).toBe(3);
      await page.close();
    }
  }, 60_000);
});

describe("overheads a month", () => {
  it("an owner sets them, and clears them with a blank field; the amount is in the workspace currency", async () => {
    const { page, errors } = await mount({ canEdit: true, canManage: true });
    const region = page.getByRole("region", { name: "Workspace" });
    const field = region.getByLabel("Overheads a month", { exact: true });
    expect(await field.isDisabled()).toBe(false);
    expect(await region.innerText()).toContain("AUD a month");
    await field.fill("18000");
    await field.press("Enter");
    await expect.poll(() => calls(page)).toEqual([["overheads", 18000]]);
    await field.fill("");
    await field.press("Enter");
    await expect.poll(() => calls(page)).toEqual([["overheads", 18000], ["overheads", null]]);
    // Negative amounts are refused before they are saved.
    await field.fill("-5");
    await field.press("Enter");
    expect(await calls(page)).toEqual([["overheads", 18000], ["overheads", null]]);
    expect(errors).toEqual([]);
    await page.close();
  }, 60_000);
});

describe("deleting", () => {
  it("an editor deletes a solution after a confirm that says what is kept", async () => {
    const { page, errors } = await mount({ canEdit: true, canManage: false });
    await page.getByRole("button", { name: "Delete solution" }).click();
    const dialog = page.locator("[data-delete-solution-dialog]");
    expect(await dialog.innerText()).toContain("The 2 issues it was linked to keep a note in their history, and its verdicts stay in the audit log.");
    expect(await dialog.innerText()).toContain("An issue being tested with no other solution goes back to Open.");
    await dialog.getByRole("button", { name: "Keep it" }).click();
    expect(await calls(page)).toEqual([]);
    await page.getByRole("button", { name: "Delete solution" }).click();
    await page.locator("[data-delete-solution-dialog]").getByRole("button", { name: "Delete", exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.deleted)).toEqual(["Second check"]);
    expect(await calls(page)).toEqual([["delete solution"]]);
    expect(errors).toEqual([]);
    await page.close();
  }, 60_000);
});

describe("a viewer", () => {
  it("sees a client's fields but can change and delete nothing", async () => {
    const { page, errors } = await mount({ canEdit: false, canManage: false });
    const row = page.locator('[data-client="Harbour Lane Dental"]');
    await row.locator("summary").click();
    for (const label of ["Name", "Status", "MRR", "Start date", "Account director"]) {
      expect(await row.getByLabel(label, { exact: true }).isDisabled(), label).toBe(true);
    }
    expect(await row.getByLabel("SEO", { exact: true }).isDisabled()).toBe(true);
    expect(await page.getByRole("button", { name: "Delete solution" }).count()).toBe(0);
    expect(await calls(page)).toEqual([]);
    expect(errors).toEqual([]);
    await page.close();
  }, 60_000);
});
