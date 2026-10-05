import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bundleHarness } from "./build-harness";

// Process admin in a real browser (issue #182, B19 2/2): an editor chooses the type of a new process, renames a process,
// changes its type after reading what that changes for the simulation, archives it (it moves to Archived) and restores it. A
// process inside another, or holding others, can't be archived, and the dialog says why. A viewer sees the lists and changes
// nothing. The server is stood in for (process-admin-harness/entry.tsx); the writes are tested over PostgREST in
// packages/mcp/test/postgrest-process-admin.test.ts and the company map's versions in packages/db/test/process-archive.test.ts.

let browser: Browser;
let script: string;

beforeAll(async () => {
  script = await bundleHarness(new URL("./process-admin-harness/entry.tsx", import.meta.url));
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
}, 120_000);

afterAll(async () => {
  await browser?.close();
});

async function mount(opts: { canEdit: boolean; refuseArchive?: string }): Promise<{ page: Page; errors: string[] }> {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.route("https://processes.test/", (route) => route.fulfill({ contentType: "text/html", body: `<!doctype html><div id="root"></div>` }));
  await page.goto("https://processes.test/");
  await page.addScriptTag({ content: script });
  await page.evaluate((o) => window.mountProcessAdmin(o), opts);
  await page.waitForSelector("[data-process]");
  return { page, errors };
}

const calls = (page: Page) => page.evaluate(() => window.calls);
const names = (page: Page) => page.locator("[data-process] td:nth-child(2)").evaluateAll((els) => els.map((e) => e.textContent!.trim()));
const menu = async (page: Page, name: string, item: string) => {
  await page.getByRole("button", { name: `Change ${name}` }).click();
  await page.getByRole("menuitem", { name: item }).click();
};
const dialog = (page: Page) => page.getByRole("dialog");

describe("process admin", () => {
  it("asks for the type of a new process", async () => {
    const { page, errors } = await mount({ canEdit: true });
    await page.getByRole("button", { name: "New process" }).click();
    await dialog(page).getByLabel("Name").fill("Quarterly review");
    expect(await dialog(page).getByRole("radio").count()).toBe(2);
    await dialog(page).getByRole("radio", { name: /Client work/ }).check();
    await dialog(page).getByRole("button", { name: "Create" }).click();
    await expect.poll(() => calls(page)).toContainEqual(["create", "Quarterly review", "servicing"]);
    expect(errors).toEqual([]);
    await page.close();
  }, 60_000);

  it("an editor renames a process, and a name already taken is refused", async () => {
    const { page, errors } = await mount({ canEdit: true });
    await menu(page, "Monthly reporting", "Rename…");
    await dialog(page).getByLabel("Name").fill("Sales");
    await dialog(page).getByRole("button", { name: "Save" }).click();
    expect(await dialog(page).getByRole("alert").innerText()).toBe("There is already a process called 'Sales'.");
    await dialog(page).getByLabel("Name").fill("Client reporting");
    await dialog(page).getByRole("button", { name: "Save" }).click();
    await expect.poll(() => names(page)).toContain("Client reporting");
    expect(await page.locator("[data-process-status]").innerText()).toBe("Renamed Monthly reporting to Client reporting.");
    expect(await calls(page)).toContainEqual(["rename", "50000000-0000-4000-8000-000000000003", "Client reporting"]);
    expect(errors).toEqual([]);
    await page.close();
  }, 60_000);

  it("changing the type says what changes for the simulation first", async () => {
    const { page } = await mount({ canEdit: true });
    await menu(page, "Ad-hoc requests", "Change type…");
    expect(await dialog(page).getByRole("radio", { name: /Sales pipeline/ }).isChecked()).toBe(true);
    const warning = await dialog(page).locator("[data-kind-warning]").innerText();
    expect(warning).toContain("What changes in the simulation");
    expect(warning).toContain("Leads start arriving at Ad-hoc requests from Demand");
    expect(warning).toContain("pipeline column of the company map");
    // Back to what it is now: nothing to warn about, nothing to save.
    await dialog(page).getByRole("radio", { name: /Client work/ }).check();
    expect(await dialog(page).locator("[data-kind-warning]").count()).toBe(0);
    expect(await dialog(page).getByRole("button", { name: "Change type" }).isDisabled()).toBe(true);
    await dialog(page).getByRole("radio", { name: /Sales pipeline/ }).check();
    await dialog(page).getByRole("button", { name: "Change type" }).click();
    await expect.poll(() => calls(page)).toContainEqual(["kind", "50000000-0000-4000-8000-000000000004", "pipeline"]);
    await expect.poll(() => page.locator('[data-process="50000000-0000-4000-8000-000000000004"] td:nth-child(3)').innerText()).toBe("Sales pipeline");
    await page.close();
  }, 60_000);

  it("archives a process (it moves to Archived) and restores it", async () => {
    const { page, errors } = await mount({ canEdit: true });
    await menu(page, "Monthly reporting", "Archive…");
    expect(await dialog(page).innerText()).toContain("Nothing is deleted");
    await dialog(page).getByRole("button", { name: "Archive" }).click();
    await expect.poll(() => names(page)).not.toContain("Monthly reporting");
    expect(await page.getByRole("button", { name: "Archived (2)" }).isVisible()).toBe(true);
    await page.getByRole("button", { name: "Archived (2)" }).click();
    expect(await page.locator("[data-archived-process]").evaluateAll((els) => els.map((e) => e.getAttribute("data-archived-process")))).toEqual(["Monthly reporting", "Old audit"]);
    await page.getByRole("button", { name: "Restore Monthly reporting" }).click();
    await expect.poll(() => page.locator("[data-archived-process]").count()).toBe(1);
    await page.getByRole("button", { name: /^In use/ }).click();
    expect(await names(page)).toContain("Monthly reporting");
    expect(await calls(page)).toEqual([
      ["archive", "50000000-0000-4000-8000-000000000003"],
      ["restore", "50000000-0000-4000-8000-000000000003"],
    ]);
    expect(errors).toEqual([]);
    await page.close();
  }, 60_000);

  it("won't archive a process inside another or holding others, and names them; passes on the database's refusal", async () => {
    const { page } = await mount({ canEdit: true, refuseArchive: "Monthly reporting holds Audit. Take Audit out of Monthly reporting and publish, then archive it." });
    await menu(page, "Onboarding", "Archive…");
    expect(await dialog(page).locator("[data-archive-blocked]").innerText()).toBe("Onboarding sits inside Sales. Take it out of Sales and publish, then archive it.");
    expect(await dialog(page).getByRole("button", { name: "Archive" }).count()).toBe(0);
    await dialog(page).locator("form").getByRole("button", { name: "Close" }).click();
    await menu(page, "Sales", "Archive…");
    expect(await dialog(page).locator("[data-archive-blocked]").innerText()).toBe("Sales holds Onboarding. Take it out of Sales and publish, then archive it.");
    await dialog(page).locator("form").getByRole("button", { name: "Close" }).click();
    // What only the database knows (a draft published elsewhere meanwhile) comes back as its message.
    await menu(page, "Monthly reporting", "Archive…");
    await dialog(page).getByRole("button", { name: "Archive" }).click();
    expect(await dialog(page).getByRole("alert").innerText()).toBe("Monthly reporting holds Audit. Take Audit out of Monthly reporting and publish, then archive it.");
    expect(await names(page)).toContain("Monthly reporting");
    expect(await calls(page)).toEqual([["archive", "50000000-0000-4000-8000-000000000003"]]);
    await page.close();
  }, 60_000);

  it("a viewer sees the processes and the archived ones, and can change nothing", async () => {
    const { page, errors } = await mount({ canEdit: false });
    expect(await page.getByRole("button", { name: /^Change / }).count()).toBe(0);
    expect(await page.getByRole("button", { name: "New process" }).count()).toBe(0);
    await page.getByRole("button", { name: "Archived (1)" }).click();
    expect(await page.locator("[data-archived-process]").count()).toBe(1);
    expect(await page.getByRole("button", { name: /Restore/ }).count()).toBe(0);
    expect(errors).toEqual([]);
    await page.close();
  }, 60_000);
});
