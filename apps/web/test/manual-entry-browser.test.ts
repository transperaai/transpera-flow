import { build } from "esbuild";
import { chromium, type Browser, type Page } from "playwright-core";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Adding things by hand (issue #182, B19) in a real browser: an editor adds a client, edits it, gives it services and
// someone to look after it, and makes it inactive, which hides it (there is no delete); an owner changes the workspace's name
// and currency; an editor deletes a saved scenario and a solution after a confirm. A viewer sees everything and can change
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

async function mount(opts: { canEdit: boolean; canManage: boolean; simulated?: boolean }): Promise<{ page: Page; errors: string[] }> {
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
const clientsRegion = (page: Page) => page.getByRole("region", { name: "Clients" });

describe("clients by hand", () => {
  it("an editor adds a client, edits it, sets its services and who looks after it", async () => {
    const { page, errors } = await mount({ canEdit: true, canManage: false });
    const region = clientsRegion(page);
    await region.locator("[data-add-client] input[name=name]").fill("Bright Smile Ortho");
    await region.locator("[data-add-client] input[name=mrr]").fill("2400");
    await region.locator("[data-add-client] input[name=start_date]").fill("2026-09-01");
    await region.getByRole("button", { name: "Add client" }).click();
    const row = page.locator('[data-client="Bright Smile Ortho"]');
    await row.waitFor();
    expect(await row.locator("summary").innerText()).toContain("A$2,400 a month · since 2026-09-01");

    await row.locator("summary").click();
    await row.getByLabel("SEO", { exact: true }).check();
    await row.getByLabel("Account director", { exact: true }).selectOption({ label: "Maya Collins" });
    await row.getByLabel("MRR", { exact: true }).fill("2600");
    await row.getByLabel("MRR", { exact: true }).press("Enter");
    await expect.poll(() => calls(page)).toEqual(
      expect.arrayContaining([
        ["add", expect.any(String), "Bright Smile Ortho", "2400", "2026-09-01"],
        ["services", expect.any(String), expect.any(String), ["10000000-0000-4000-8000-000000000001"]],
        ["assignment", expect.any(String), expect.any(String), "20000000-0000-4000-8000-000000000001", "30000000-0000-4000-8000-000000000001"],
        ["field", expect.any(String), "mrr", 2600],
      ]),
    );
    // Only the role's own people are offered, and "shared" is the way to name nobody.
    expect(await row.getByLabel("Account manager", { exact: true }).locator("option").allInnerTexts()).toEqual(["Shared by the role", "Tom Reid"]);
    expect(errors).toEqual([]);
    await page.close();
  }, 60_000);

  it("refuses a client with no name, and says why", async () => {
    const { page } = await mount({ canEdit: true, canManage: false });
    const region = clientsRegion(page);
    await region.locator("[data-add-client] input[name=name]").fill("   ");
    await region.locator("[data-add-client] input[name=mrr]").fill("100");
    await page.evaluate(() => document.querySelector<HTMLFormElement>("[data-add-client]")!.noValidate = true);
    await region.getByRole("button", { name: "Add client" }).click();
    expect(await region.getByRole("alert").innerText()).toBe("Enter the client's name.");
    await page.close();
  }, 60_000);

  it("making a client inactive hides it, and there is no way to delete one", async () => {
    const { page } = await mount({ canEdit: true, canManage: false });
    const region = clientsRegion(page);
    expect(await region.locator("[data-clients=active] [data-client]").count()).toBe(1);
    expect(await region.locator('[data-client="Old Mill Bakery"]').count()).toBe(0);
    const row = page.locator('[data-client="Harbour Lane Dental"]');
    await row.locator("summary").click();
    // A click, not uncheck(): the row moves to the hidden list at once, so there is no checkbox left to re-check.
    await row.getByLabel("Status", { exact: true }).click();
    await expect.poll(() => region.locator("[data-clients=active] [data-client]").count()).toBe(0);
    expect(await region.getByText("No active clients yet.").isVisible()).toBe(true);
    await region.getByRole("button", { name: "Show 2 inactive clients" }).click();
    expect(await region.locator("[data-clients=inactive] [data-client]").evaluateAll((els) => els.map((e) => e.getAttribute("data-client")))).toEqual(["Harbour Lane Dental", "Old Mill Bakery"]);
    expect(await region.getByRole("button", { name: /delete|remove/i }).count()).toBe(0);
    await page.close();
  }, 60_000);

  it("says whether the list is simulated", async () => {
    const groups = await mount({ canEdit: true, canManage: false, simulated: false });
    expect(await groups.page.locator("#clients-heading ~ *").first().innerText()).toContain("Your client groups drive the simulation");
    await groups.page.close();
    const named = await mount({ canEdit: true, canManage: false, simulated: true });
    expect(await named.page.locator("#clients-heading ~ *").first().innerText()).toContain("the simulation uses the active clients on this list");
    await named.page.close();
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
    expect(errors).toEqual([]);
    await page.close();
  }, 60_000);

  it("an editor and a viewer see them but can't change them", async () => {
    for (const canEdit of [true, false]) {
      const { page } = await mount({ canEdit, canManage: false });
      const region = page.getByRole("region", { name: "Workspace" });
      expect(await region.getByLabel("Name", { exact: true }).isDisabled()).toBe(true);
      expect(await region.getByLabel("Currency", { exact: true }).isDisabled()).toBe(true);
      expect(await region.getByText("Only workspace owners can change this.").count()).toBe(2);
      await page.close();
    }
  }, 60_000);
});

describe("deleting", () => {
  it("an editor deletes a saved scenario after confirming, and can change their mind", async () => {
    const { page } = await mount({ canEdit: true, canManage: false });
    const region = page.locator("[data-saved-scenarios]");
    await region.getByRole("button", { name: "Delete Hire a strategist" }).click();
    await region.getByRole("button", { name: "Keep" }).click();
    expect(await calls(page)).toEqual([]);
    await region.getByRole("button", { name: "Delete More leads" }).click();
    await region.getByRole("button", { name: "Delete", exact: true }).click();
    await expect.poll(() => region.locator("[data-scenario]").evaluateAll((els) => els.map((e) => e.getAttribute("data-scenario")))).toEqual(["Hire a strategist"]);
    expect(await calls(page)).toEqual([["delete scenario", "50000000-0000-4000-8000-000000000002"]]);
    await page.close();
  }, 60_000);

  it("an editor deletes a solution after a confirm that says what is kept", async () => {
    const { page, errors } = await mount({ canEdit: true, canManage: false });
    await page.getByRole("button", { name: "Delete solution" }).click();
    const dialog = page.locator("[data-delete-solution-dialog]");
    expect(await dialog.innerText()).toContain("The 2 issues it was linked to keep a note in their history, and its verdicts stay in the audit log.");
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
  it("sees clients and scenarios but can add, change and delete nothing", async () => {
    const { page, errors } = await mount({ canEdit: false, canManage: false });
    const region = clientsRegion(page);
    expect(await region.getByRole("button", { name: "Add client" }).count()).toBe(0);
    expect(await region.getByText("You can view clients here; owners and editors can change them.").isVisible()).toBe(true);
    const row = page.locator('[data-client="Harbour Lane Dental"]');
    await row.locator("summary").click();
    for (const label of ["Name", "Status", "MRR", "Start date", "Account director"]) {
      expect(await row.getByLabel(label, { exact: true }).isDisabled(), label).toBe(true);
    }
    expect(await row.getByLabel("SEO", { exact: true }).isDisabled()).toBe(true);
    expect(await page.locator("[data-saved-scenarios]").getByRole("button").count()).toBe(0);
    expect(await page.getByRole("button", { name: "Delete solution" }).count()).toBe(0);
    expect(await calls(page)).toEqual([]);
    expect(errors).toEqual([]);
    await page.close();
  }, 60_000);
});
