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
    expect(await dialog(page).getByRole("radio").count()).toBe(5);
    await dialog(page).getByRole("radio", { name: /Routine client work/ }).check();
    await dialog(page).getByRole("button", { name: "Create" }).click();
    await expect.poll(() => calls(page)).toContainEqual(["create", "Quarterly review", "routine_client_work"]);
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

  it("Change type picks the category, with each one's help, and saves it without touching the simulation", async () => {
    const { page, errors } = await mount({ canEdit: true });
    await menu(page, "Monthly reporting", "Change type…");
    const radios = dialog(page).getByRole("radio");
    expect(await radios.count()).toBe(5);
    const text = await dialog(page).innerText();
    for (const line of ["Sales", "Onboarding", "Routine client work", "Ad hoc", "Internal"]) expect(text).toContain(line);
    expect(text).toContain("Work for the agency itself, not for a client.");
    expect(await dialog(page).getByRole("radio", { name: /Routine client work/ }).isChecked()).toBe(true);
    // Nothing changed yet: nothing to save.
    expect(await dialog(page).getByRole("button", { name: "Save" }).isDisabled()).toBe(true);
    await dialog(page).getByRole("radio", { name: /Internal/ }).check();
    await dialog(page).getByRole("button", { name: "Save" }).click();
    await expect.poll(() => calls(page)).toEqual([["category", "50000000-0000-4000-8000-000000000003", "internal"]]);
    await expect.poll(() => page.locator('[data-process="50000000-0000-4000-8000-000000000003"] td:nth-child(3)').innerText()).toBe("Internal");
    expect(await page.locator("[data-process-status]").innerText()).toBe("Monthly reporting is now Internal.");
    expect(errors).toEqual([]);
    await page.close();
  }, 60_000);

  it("how it's simulated is folded, says which kind the process is, and keeps the warning and the kind change", async () => {
    const { page } = await mount({ canEdit: true });
    await menu(page, "Ad-hoc requests", "Change type…");
    const fold = dialog(page).locator("[data-how-simulated]");
    expect(await fold.evaluate((el) => (el as HTMLDetailsElement).open)).toBe(false);
    await fold.getByText("How it's simulated").click();
    expect(await fold.locator("[data-simulated-as]").innerText()).toBe("Simulated as client work (it repeats for every client).");
    expect(await fold.locator("[data-kind-warning]").count()).toBe(0);
    await fold.getByRole("radio", { name: /Sales pipeline/ }).check();
    const warning = await fold.locator("[data-kind-warning]").innerText();
    expect(warning).toContain("What changes in the simulation");
    expect(warning).toContain("Leads start arriving at Ad-hoc requests from Demand");
    expect(warning).toContain("pipeline column of the company map");
    // Back to what it is now: nothing to warn about, nothing to save.
    await fold.getByRole("radio", { name: /Client work/ }).check();
    expect(await fold.locator("[data-kind-warning]").count()).toBe(0);
    expect(await dialog(page).getByRole("button", { name: "Save" }).isDisabled()).toBe(true);
    await fold.getByRole("radio", { name: /Sales pipeline/ }).check();
    await dialog(page).getByRole("button", { name: "Save" }).click();
    await expect.poll(() => calls(page)).toContainEqual(["kind", "50000000-0000-4000-8000-000000000004", "pipeline"]);
    // The engine kind changed; what people call the process (its category) is theirs to change and stays.
    await expect.poll(() => page.locator('[data-process="50000000-0000-4000-8000-000000000004"] td:nth-child(3)').innerText()).toBe("Ad hoc");
    expect((await calls(page)).some((c) => c[0] === "category")).toBe(false);
    await page.close();
  }, 60_000);

  it("the Type column shows each process's category, and a filter narrows the list to one", async () => {
    const { page, errors } = await mount({ canEdit: true });
    const types = () => page.locator("[data-process] td:nth-child(3)").allInnerTexts();
    expect(await types()).toEqual(["Sales", "Onboarding", "Routine client work", "Ad hoc"]);
    await page.locator("[data-filter=type]").click();
    const menu = page.locator("[data-filter-menu=type]");
    expect((await menu.locator("label").allInnerTexts()).map((t) => t.replace(/\s+/g, ""))).toEqual(["Sales1", "Onboarding1", "Routineclientwork1", "Adhoc1"]);
    await menu.locator("[data-option=onboarding]").check();
    expect(await names(page)).toEqual(["Onboarding"]);
    await menu.locator("[data-option=onboarding]").uncheck();
    expect((await names(page)).length).toBe(4);
    expect(errors).toEqual([]);
    await page.close();
  }, 60_000);

  it("archives a process (it moves to Archived) and restores it", async () => {
    const { page, errors } = await mount({ canEdit: true });
    await menu(page, "Monthly reporting", "Archive…");
    expect(await dialog(page).innerText()).toContain("Nothing is deleted");
    await dialog(page).getByRole("button", { name: "Archive" }).click();
    await expect.poll(() => names(page)).not.toContain("Monthly reporting");
    expect(await page.getByRole("radio", { name: "Archived (2)" }).isVisible()).toBe(true);
    await page.getByRole("radio", { name: "Archived (2)" }).click();
    expect(await page.locator("[data-archived-process]").evaluateAll((els) => els.map((e) => e.getAttribute("data-archived-process")))).toEqual(["Monthly reporting", "Old audit"]);
    await page.getByRole("button", { name: "Restore Monthly reporting" }).click();
    await expect.poll(() => page.locator("[data-archived-process]").count()).toBe(1);
    await page.getByRole("radio", { name: /^In use/ }).click();
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
    await page.getByRole("radio", { name: "Archived (1)" }).click();
    expect(await page.locator("[data-archived-process]").count()).toBe(1);
    expect(await page.getByRole("button", { name: /Restore/ }).count()).toBe(0);
    expect(errors).toEqual([]);
    await page.close();
  }, 60_000);
});

describe("an archived process's page", () => {
  async function banner(opts: { canEdit: boolean; refuse?: string }) {
    const page = await browser.newPage();
    await page.route("https://processes.test/", (route) => route.fulfill({ contentType: "text/html", body: `<!doctype html><div id="root"></div>` }));
    await page.goto("https://processes.test/");
    await page.addScriptTag({ content: script });
    await page.evaluate((o) => window.mountArchivedBanner(o), opts);
    await page.waitForSelector("[data-archived-banner]");
    return page;
  }

  it("says when it was archived and that it is read only; an editor restores it, and a refusal is shown", async () => {
    const page = await banner({ canEdit: true, refuse: "Another process is called Monthly reporting. Rename that one, then restore this." });
    expect(await page.locator("[data-archived-banner]").innerText()).toContain("Archived on 3 Oct. Monthly reporting is off the company map, the lists and the simulation, and read only.");
    await page.getByRole("button", { name: "Restore Monthly reporting" }).click();
    expect(await page.getByRole("alert").innerText()).toBe("Another process is called Monthly reporting. Rename that one, then restore this.");
    expect(await calls(page)).toEqual([["restore", "50000000-0000-4000-8000-000000000003"]]);
    await page.close();
  }, 60_000);

  it("offers a viewer no Restore", async () => {
    const page = await banner({ canEdit: false });
    expect(await page.getByRole("button").count()).toBe(0);
    await page.close();
  }, 60_000);
});
