import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bundleHarness } from "./build-harness";
import type { SourcesHarnessOptions } from "./sources-harness/entry";

// The Sources library in a real browser (issue #176, B18), on the real page in demo mode: the table, search, the kind and
// process filters, "Not linked only", sort, the side panel (full text, links, "Link to…", the quotes citing it), and the empty
// state. The rules behind them are unit-tested in sources-library.test.ts. The page here has none of the app's stylesheet, so
// what is checked is what the page does, not how it looks (the screenshots in the PR cover that).

let browser: Browser;
let script: string;

beforeAll(async () => {
  script = await bundleHarness(new URL("./sources-harness/entry.tsx", import.meta.url));
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
}, 120_000);

afterAll(async () => {
  await browser?.close();
});

async function open(options: SourcesHarnessOptions = {}): Promise<{ page: Page; errors: string[] }> {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  // A secure origin, as the app is: ids come from crypto.randomUUID.
  await page.route("https://sources.test/", (route) => route.fulfill({ contentType: "text/html", body: `<!doctype html><div id="root"></div>` }));
  await page.goto("https://sources.test/");
  await page.addScriptTag({ content: script });
  await page.evaluate((o) => window.mountSources(o), options);
  await page.waitForSelector("[data-source-row], [data-no-sources]");
  return { page, errors };
}

const titles = (page: Page) => page.locator("[data-source-row] button[aria-label^='Open ']").evaluateAll((els) => els.map((e) => e.textContent!.trim()));
const count = (page: Page) => page.locator("[data-library-count]").innerText();
const panel = (page: Page) => page.locator("[data-source-panel]");
const search = (page: Page, text: string) => page.getByLabel("Search sources").fill(text);

describe("the Sources library table", () => {
  it("lists each source with its title, kind, date, speakers and what it is linked to, and flags the one linked to nothing", async () => {
    const { page, errors } = await open();
    expect(await page.locator("table[aria-label=Sources] thead th").allInnerTexts()).toEqual(["Title", "Kind", "Date", "Speakers", "Linked to"]);
    expect(await titles(page)).toEqual(["Notes: ops walkthrough with Leah", "Sales team notes", "Strategy walkthrough"]);
    const cells = await page.locator("[data-source-row]", { hasText: "Strategy walkthrough" }).locator("td").allInnerTexts();
    expect(cells[1]).toBe("Transcript");
    expect(cells[2]).toBe("2026-09-12");
    expect(cells[3]).toBe("Maya Collins, Rosa Diaz");
    expect(cells[4]!.replace(/\s+/g, " ")).toMatch(/Processes .*Issues #\d+/);
    expect(await page.locator("[data-source-row][data-linked=false]").count()).toBe(1);
    expect(await page.locator("[data-source-row][data-linked=false] td:nth-child(5) [data-unlinked-flag]").count()).toBe(1);
    expect(await page.locator("[data-source-row][data-linked=true] [data-unlinked-flag]").count()).toBe(0);
    expect(await count(page)).toBe("3 sources.");
    expect(errors).toEqual([]);
    await page.close();
  }, 60_000);

  it("searches as you type, over the title, speakers, text and links, and says how many it found", async () => {
    const { page } = await open({ sources: "many" });
    expect(await count(page)).toBe("12 sources.");
    await search(page, "banana");
    expect(await titles(page)).toEqual(["Interview E"]);
    expect(await count(page)).toBe("Showing 1 of 12 sources.");
    await search(page, "leah");
    expect(await titles(page)).toContain("Notes: ops walkthrough with Leah");
    await search(page, "sam okafor interview");
    expect((await titles(page)).length).toBe(4);
    await page.close();
  }, 60_000);

  it("says so when nothing matches, and 'Clear filters' brings everything back", async () => {
    const { page } = await open({ sources: "many" });
    await search(page, "zzzz nothing like this");
    expect(await page.locator("[data-library-empty]").innerText()).toContain("No sources match");
    expect(await page.locator("[data-source-row]").count()).toBe(0);
    await page.getByRole("button", { name: "Clear filters" }).click();
    expect(await page.locator("[data-source-row]").count()).toBe(12);
    expect(await page.getByLabel("Search sources").inputValue()).toBe("");
    expect(await page.getByRole("button", { name: "Clear filters" }).count()).toBe(0);
    await page.close();
  }, 60_000);

  it("filters by kind, by process, and to the sources linked to nothing, alone or together", async () => {
    const { page } = await open({ sources: "many" });
    await page.getByLabel("Filter by kind").selectOption("data");
    const data = await titles(page);
    expect(data.length).toBe(2);
    expect(await page.locator("[data-source-row] td:nth-child(2)").allInnerTexts()).toEqual(["Data", "Data"]);
    await page.getByLabel("Filter by kind").selectOption("all");

    const processName = (await page.getByLabel("Filter by process").locator("option").allInnerTexts())[1]!;
    await page.getByLabel("Filter by process").selectOption({ label: processName });
    const inProcess = await titles(page);
    expect(inProcess.length).toBeGreaterThan(0);
    expect(inProcess.length).toBeLessThan(12);
    for (const row of await page.locator("[data-source-row] td:nth-child(5)").allInnerTexts()) expect(row).toContain(processName);
    await page.getByLabel("Filter by process").selectOption("all");

    await page.getByRole("checkbox", { name: "Not linked only" }).check();
    expect((await titles(page)).sort()).toEqual(["Interview H", "Interview I", "Notes: ops walkthrough with Leah"]);
    expect(await count(page)).toBe("Showing 3 of 12 sources.");
    // With a kind as well: only the notes among them.
    await page.getByLabel("Filter by kind").selectOption("notes");
    expect(await titles(page)).toEqual(expect.arrayContaining(["Notes: ops walkthrough with Leah"]));
    for (const kind of await page.locator("[data-source-row] td:nth-child(2)").allInnerTexts()) expect(kind).toBe("Notes");
    await page.close();
  }, 60_000);

  it("sorts by date or by title, either way round", async () => {
    const { page } = await open({ sources: "many" });
    const dates = () => page.locator("[data-source-row] td:nth-child(3)").allInnerTexts();
    // Newest first is the way it opens.
    let list = await dates();
    expect(list).toEqual([...list].sort().reverse());
    await page.getByLabel("Sort sources").selectOption("oldest");
    list = await dates();
    expect(list).toEqual([...list].sort());
    await page.getByLabel("Sort sources").selectOption("title");
    let names = await titles(page);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base", numeric: true })));
    await page.getByLabel("Sort sources").selectOption("title-desc");
    names = await titles(page);
    expect(names[0]).toBe("Strategy walkthrough");
    await page.close();
  }, 60_000);

  it("says what to do when there are no sources at all", async () => {
    const { page, errors } = await open({ sources: "none" });
    expect(await page.getByText("No sources yet. Add the audit's transcripts and notes").count()).toBe(1);
    expect(await page.locator("table").count()).toBe(0);
    expect(errors).toEqual([]);
    await page.close();
  }, 60_000);
});

describe("the side panel", () => {
  it("opens from a row with the full text, what it is linked to, the quotes citing it and 'Link to…'", async () => {
    const { page, errors } = await open();
    expect(await panel(page).count()).toBe(0);
    await page.locator("[data-source-row]", { hasText: "Strategy walkthrough" }).click();
    await panel(page).waitFor();
    expect(await panel(page).getByRole("heading", { name: "Strategy walkthrough" }).count()).toBe(1);
    // All of the text, not an excerpt: the third line is past where an excerpt would stop.
    const text = await page.locator("[data-full-text]").innerText();
    expect(text).toContain("A proper audit and proposal is a day's work");
    expect(text).toContain("Kickoffs are quicker, half a day.");
    expect(await panel(page).getByRole("list", { name: "Linked to" }).locator("li").count()).toBeGreaterThanOrEqual(2);
    // The values that quote it, with who said it.
    const cited = (await panel(page).getByRole("list", { name: "Values citing this source" }).innerText()).replace(/\s+/g, " ");
    expect(cited).toContain("From the time logs it looks more like twelve hours");
    expect(cited).toContain("Rosa Diaz");
    expect(await panel(page).getByRole("button", { name: "Link Strategy walkthrough to something" }).innerText()).toBe("Link to…");
    // The row it came from is marked.
    expect(await page.locator("[data-source-row][data-open=true]").count()).toBe(1);
    expect(errors).toEqual([]);
    await page.close();
  }, 60_000);

  it("closes with Escape or its close button, and opens another source in its place", async () => {
    const { page } = await open();
    await page.getByRole("button", { name: "Open Sales team notes" }).click();
    await panel(page).waitFor();
    await page.keyboard.press("Escape");
    await panel(page).waitFor({ state: "detached" });
    await page.getByRole("button", { name: "Open Sales team notes" }).click();
    await panel(page).waitFor();
    await panel(page).getByRole("button", { name: "Close" }).click();
    await panel(page).waitFor({ state: "detached" });
    await page.close();
  }, 60_000);

  it("warns on a source linked to nothing, and linking it from the panel updates the panel and the table", async () => {
    const { page, errors } = await open();
    await page.getByRole("button", { name: "Open Notes: ops walkthrough with Leah" }).click();
    await panel(page).waitFor();
    expect(await panel(page).innerText()).toContain("Not linked to anything yet. Link it, or it won't count as evidence.");
    await panel(page).getByRole("button", { name: /^Link Notes: ops walkthrough with Leah to something/ }).click();
    const dialog = page.locator("[data-source-dialog]");
    await dialog.waitFor();
    expect(await dialog.getByRole("heading", { name: "Link source" }).count()).toBe(1);
    await dialog.getByRole("button", { name: "A process" }).click();
    await dialog.locator("#src-target").selectOption({ index: 1 });
    await dialog.getByRole("button", { name: "Link", exact: true }).click();
    await dialog.waitFor({ state: "detached" });
    // The panel is still open, now with a chip and no warning; the table row has lost its flag.
    expect(await panel(page).count()).toBe(1);
    expect(await panel(page).getByRole("list", { name: "Linked to" }).locator("li").count()).toBe(1);
    expect(await panel(page).innerText()).not.toContain("Not linked to anything yet");
    expect(await page.locator("[data-source-row][data-linked=false]").count()).toBe(0);
    expect(errors).toEqual([]);
    await page.close();
  }, 60_000);

  it("keeps the table's filters when the panel opens and closes", async () => {
    const { page } = await open({ sources: "many" });
    await search(page, "interview");
    const before = await titles(page);
    await page.getByRole("button", { name: `Open ${before[0]}` }).click();
    await panel(page).waitFor();
    await page.keyboard.press("Escape");
    await panel(page).waitFor({ state: "detached" });
    expect(await titles(page)).toEqual(before);
    expect(await page.getByLabel("Search sources").inputValue()).toBe("interview");
    await page.close();
  }, 60_000);

  it("can open on arrival, and is read-only for a viewer: no 'Link to…', no way to remove a link or delete", async () => {
    const { page } = await open({ mode: "readonly", open: "30000000-0000-4000-8000-000000000001" });
    await panel(page).waitFor();
    expect(await panel(page).getByRole("heading", { name: "Strategy walkthrough" }).count()).toBe(1);
    expect(await page.getByRole("button", { name: /Link .* to something/ }).count()).toBe(0);
    expect(await page.getByRole("button", { name: /Remove link/ }).count()).toBe(0);
    expect(await page.getByRole("button", { name: /Delete source/ }).count()).toBe(0);
    expect(await page.getByRole("button", { name: "+ Add source" }).count()).toBe(0);
    await page.close();
  }, 60_000);

  it("deletes a source from the panel after asking, and the table loses its row", async () => {
    const { page } = await open();
    await page.getByRole("button", { name: "Open Sales team notes" }).click();
    await panel(page).waitFor();
    await panel(page).getByText("Details and edit").click();
    await panel(page).getByRole("button", { name: "Delete source…" }).click();
    expect(await panel(page).getByRole("alertdialog").innerText()).toContain("Delete this source?");
    await panel(page).getByRole("button", { name: "Delete source", exact: true }).click();
    await panel(page).waitFor({ state: "detached" });
    expect(await titles(page)).toEqual(["Notes: ops walkthrough with Leah", "Strategy walkthrough"]);
    await page.close();
  }, 60_000);
});
