import { chromium, type Browser, type Locator, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bundleHarness } from "./build-harness";

// The import wizard (issue #40, C1) on Settings → Historical data, in a real browser: the real cards from ./csv-import-harness
// bundled with esbuild (see ../build-harness.ts), the file reading in a real Web Worker. Mapping a file's columns, the rows it
// reads and leaves out, matching names to the model, what is never shown (clients and people, amounts for viewers), the read of
// 50,000 rows going through the worker, and Stop on 200,000 while the page stays responsive.

let browser: Browser;
let script: string;
let workers: Record<string, string>;

// The bundle has no `import.meta.url`: give it one under which `../../workers/<name>.ts` names the worker file.
const META = { "import.meta.url": JSON.stringify("http://harness.test/src/lib/x/") };

beforeAll(async () => {
  [script, workers] = await Promise.all([
    bundleHarness(new URL("./csv-import-harness/entry.tsx", import.meta.url), META),
    Promise.all(["csv-import.worker.ts", "churn-calibration.worker.ts"].map(async (f) => [f, await bundleHarness(new URL(`../src/workers/${f}`, import.meta.url))] as const)).then(Object.fromEntries),
  ]);
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
}, 180_000);

afterAll(async () => {
  await browser?.close();
});

type Options = Parameters<Window["mountImport"]>[0];

async function mount(options: Options = {}): Promise<{ page: Page; errors: string[] }> {
  const page = await browser.newPage({ viewport: { width: 1300, height: 1600 } });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.setContent(`<div id="root"></div>`);
  await page.evaluate((w) => (window.importWorkerScripts = w), workers);
  await page.addScriptTag({ content: script });
  await page.evaluate((o) => window.mountImport(o), options);
  return { page, errors };
}

const wizard = (page: Page, id: string) => page.locator(`[data-import-wizard="${id}"]`);
const step = (page: Page, id: string, name: "file" | "columns" | "rows") => wizard(page, id).locator(`[data-import-step="${name}"]`);
const column = (page: Page, id: string, name: string) => step(page, id, "columns").locator(`[data-column="${name}"]`);
const picked = (select: Locator) => select.evaluate((el) => (el as HTMLSelectElement).options[(el as HTMLSelectElement).selectedIndex]!.text);

const csv = (text: string, name = "file.csv") => ({ name, mimeType: "text/csv", buffer: Buffer.from(text) });

async function choose(page: Page, id: string, kind: string | null, file: ReturnType<typeof csv>) {
  if (kind) await wizard(page, id).locator(`#${id}-kind`).selectOption({ label: kind });
  await page.locator(`#${id}-file`).setInputFiles(file);
  await step(page, id, "columns").waitFor({ timeout: 60_000 });
}

async function readIt(page: Page, id: string) {
  await step(page, id, "columns").getByRole("button", { name: "Continue" }).click();
  await step(page, id, "rows").waitFor({ timeout: 120_000 });
}

const D = (day: number, hour = 9) => new Date(Date.UTC(2026, 3, 1 + day, hour)).toISOString().slice(0, 16).replace("T", " ");

/** A HubSpot-like deals export: each deal enters "Qualified lead" and "Discovery call" (exact in the model), some then a CRM-only stage. */
function hubspotDeals(n = 24): string {
  const lines = ["Record ID,Deal Name,Deal Stage,Date entered stage,Date left,Original Source,Amount,Deal owner"];
  for (let i = 0; i < n; i++) {
    const day = Math.floor(i * 3.5);
    const tail = `Website enquiries,£${9000 + i},Jane Secretperson`;
    lines.push(`${i},ACME-DEAL-${i},Qualified lead,${D(day)},${D(day, 11)},${tail}`);
    lines.push(`${i},ACME-DEAL-${i},Discovery call,${D(day + 1)},${D(day + 2)},${tail}`);
    lines.push(`${i},ACME-DEAL-${i},${i % 2 ? "Closed won" : "Closed lost"},${D(day + 3)},,${tail}`);
  }
  return lines.join("\n");
}

const timeLogs = (n: number) =>
  ["Job,Task,Date,Hours,Person,Client", ...Array.from({ length: n }, (_, i) => `J-${i},Qualify lead,2026-04-${String((i % 27) + 1).padStart(2, "0")},1.5,Jane Secretperson ${i},ACME-SECRET-CLIENT-${i}`)].join("\n");

const text = (page: Page) => page.locator("body").innerText();

describe("the import wizard", () => {
  it("suggests every column of a HubSpot-like deals file, and keeps a column that was changed", async () => {
    const { page, errors } = await mount();
    await choose(page, "cal-log", "Deals from your CRM", csv(hubspotDeals()));
    const mapped: Record<string, string> = { deal: "Record ID", stage: "Deal Stage", entered: "Date entered stage", left: "Date left", source: "Original Source", amount: "Amount", owner: "Deal owner" };
    for (const [id, header] of Object.entries(mapped)) {
      const c = column(page, "cal-log", id);
      expect(await picked(c.locator("select")), id).toBe(header);
      // Every column with a header is suggested; a name match is "Suggested".
      expect(await c.innerText(), id).toContain("Suggested");
    }
    // Change one: it is kept (through a read, and when another column changes).
    const owner = column(page, "cal-log", "owner").locator("select");
    await owner.selectOption({ label: "Not in this file" });
    await column(page, "cal-log", "source").locator("select").selectOption({ label: "Deal Name" });
    expect(await picked(owner)).toBe("Not in this file");
    expect(await column(page, "cal-log", "owner").innerText()).not.toContain("Suggested");
    await readIt(page, "cal-log");
    expect(await picked(column(page, "cal-log", "owner").locator("select"))).toBe("Not in this file");
    expect(await picked(column(page, "cal-log", "source").locator("select"))).toBe("Deal Name");
    expect(errors).toEqual([]);
    await page.close();
  }, 120_000);

  it("blocks Continue when a required column has no header, or one header is chosen twice", async () => {
    const { page, errors } = await mount();
    await choose(page, "cal-log", "Deals from your CRM", csv(hubspotDeals()));
    const cont = step(page, "cal-log", "columns").getByRole("button", { name: "Continue" });
    expect(await cont.isEnabled()).toBe(true);
    await column(page, "cal-log", "stage").locator("select").selectOption({ value: "" });
    expect(await cont.isEnabled()).toBe(false);
    expect(await column(page, "cal-log", "stage").innerText()).toContain("Choose a column for Stage.");
    await column(page, "cal-log", "stage").locator("select").selectOption({ label: "Deal Stage" });
    expect(await cont.isEnabled()).toBe(true);
    // The same header for the deal and for the date entered.
    await column(page, "cal-log", "entered").locator("select").selectOption({ label: "Record ID" });
    expect(await cont.isEnabled()).toBe(false);
    expect(await column(page, "cal-log", "entered").innerText()).toContain("Used for Deal too");
    expect(await column(page, "cal-log", "deal").innerText()).toContain("Used for Date entered too");
    expect(errors).toEqual([]);
    await page.close();
  }, 120_000);

  it("previews 20 rows and labels clients and people, never showing the file's", async () => {
    const { page, errors } = await mount();
    await choose(page, "cal-log", "Time logs", csv(timeLogs(40)));
    // The mapper counts clients and people; it doesn't show them.
    const mapperText = await step(page, "cal-log", "columns").innerText();
    expect(mapperText).toMatch(/\d different values? in the first 5 rows/);
    expect(mapperText).not.toContain("ACME-SECRET");
    expect(mapperText).not.toContain("Jane Secretperson");
    expect(mapperText).not.toContain("J-0");
    await readIt(page, "cal-log");
    const rows = step(page, "cal-log", "rows");
    expect(await rows.locator("[data-import-preview] tbody tr").count()).toBe(20);
    const body = await rows.locator("[data-import-preview] tbody").innerText();
    expect(body).toContain("Client 1");
    expect(body).toContain("Client 20");
    expect(body).toContain("Person 1");
    // A job's id is labelled too: ids often hold names ("Smith v Jones").
    expect(body).toContain("Job 1");
    expect(body).not.toContain("J-0");
    expect(await rows.locator("[data-import-preview] caption").innerText()).toContain("Client and person names are never shown or kept. They are used only to count.");
    const all = await text(page);
    expect(all).not.toContain("ACME-SECRET");
    expect(all).not.toContain("Jane Secretperson");
    expect(await page.content()).not.toContain("ACME-SECRET");
    expect(errors).toEqual([]);
    await page.close();
  }, 120_000);

  it("lists the rows it leaves out by line", async () => {
    const { page, errors } = await mount();
    const bad = ["deal,stage,entered", "D1,Qualify lead,2026-04-02", ",Qualify lead,2026-04-03", "", "D3,Qualify lead,someday", "D4,Qualify lead,2026-04-05"].join("\n");
    await choose(page, "cal-log", "Deals from your CRM", csv(bad));
    await readIt(page, "cal-log");
    const rows = step(page, "cal-log", "rows");
    const left = await rows.locator("[data-import-errors]").textContent();
    expect(left).toContain("Line 3: Missing deal.");
    expect(left).toContain("Line 5: Can't read the date entered \"someday\"");
    expect(await rows.innerText()).toContain("Read 2 rows. 2 left out.");
    expect(errors).toEqual([]);
    await page.close();
  }, 120_000);

  it("asks which way round ambiguous dates are, and reads again when told", async () => {
    const { page, errors } = await mount();
    await choose(page, "cal-log", "Deals from your CRM", csv("deal,stage,entered\nD1,Qualify lead,02/03/2026\nD2,Qualify lead,04/05/2026"));
    await readIt(page, "cal-log");
    const rows = step(page, "cal-log", "rows");
    expect(await rows.innerText()).toContain("Is 02/03/2026 in the file the 2nd of March or the 3rd of February?");
    expect(await rows.locator("[data-import-preview]").count()).toBe(0);
    await rows.getByText("Day first (2 March)").click();
    await rows.locator("[data-import-preview]").waitFor({ timeout: 30_000 });
    expect(await rows.innerText()).toContain("Dates read day first.");
    expect(await rows.locator("[data-import-preview] tbody").innerText()).toContain("2 Mar 2026");
    expect(errors).toEqual([]);
    await page.close();
  }, 120_000);

  it("matches names to the model: no exact match leaves a stage out; choosing a step keeps it, and the panel measures it", async () => {
    const { page, errors } = await mount();
    await choose(page, "cal-log", "Deals from your CRM", csv(hubspotDeals()));
    await readIt(page, "cal-log");
    const rows = step(page, "cal-log", "rows");
    const names = rows.locator("[data-import-names]");
    const select = (value: string) => names.getByLabel(new RegExp(`^${value} \\(`));
    // "Discovery call" is a step's name as it is; "Qualified lead" and the CRM's closing stages are not.
    expect(await picked(select("Discovery call"))).toBe("Discovery call");
    expect(await picked(select("Qualified lead"))).toBe("Leave out");
    expect(await picked(select("Closed won"))).toBe("Leave out");
    expect(await rows.innerText()).toContain("more left out because their name isn't matched");
    await select("Qualified lead").selectOption({ label: "Qualify lead" });
    await select("Closed won").selectOption({ label: "Won" });
    await select("Closed lost").selectOption({ label: "Lost" });
    expect(await picked(select("Qualified lead"))).toBe("Qualify lead");
    expect(await rows.innerText()).not.toContain("more left out because their name isn't matched");
    await rows.getByRole("button", { name: "Use these rows", exact: true }).click();
    // The panel measures the rows: Qualify lead is a step it proposes changes for.
    const diff = page.locator("#cal-diff-heading");
    await diff.waitFor({ timeout: 60_000 });
    const card = page.locator('section[aria-label="What the rows measure"]');
    expect(await card.innerText()).toContain("72 rows");
    expect(await page.locator('[aria-labelledby="cal-diff-heading"]').innerText()).toContain("Qualify lead");
    expect(errors).toEqual([]);
    await page.close();
  }, 120_000);

  it("reads a Windows-1252 file with a note, and splits a semicolon file on its own", async () => {
    const { page, errors } = await mount();
    const win = ["deal;stage;entered", "D1;Qualifié;2026-04-02", "D2;Qualifié;2026-04-03"].join("\n");
    await choose(page, "cal-log", "Deals from your CRM", { name: "win.csv", mimeType: "text/csv", buffer: Buffer.from(win, "latin1") });
    // Split on its semicolons: three columns, each matched.
    expect(await picked(column(page, "cal-log", "deal").locator("select"))).toBe("deal");
    expect(await picked(column(page, "cal-log", "stage").locator("select"))).toBe("stage");
    expect(await picked(column(page, "cal-log", "entered").locator("select"))).toBe("entered");
    expect(await step(page, "cal-log", "columns").innerText()).toContain("isn't UTF-8");
    await readIt(page, "cal-log");
    expect(await step(page, "cal-log", "rows").locator("[data-import-preview] tbody").innerText()).toContain("Qualifié");
    expect(errors).toEqual([]);
    await page.close();
  }, 120_000);

  it("asks for the unit of a plain number in the hours column, and warns when seconds were read as hours", async () => {
    const { page, errors } = await mount();
    const seconds = ["Job,Task,Date,Hours", ...Array.from({ length: 12 }, (_, i) => `J${i},Qualify lead,2026-04-${String(i + 1).padStart(2, "0")},${1800 + i * 300}`)].join("\n");
    await choose(page, "cal-log", "Time logs", csv(seconds));
    await readIt(page, "cal-log");
    expect(await step(page, "cal-log", "rows").innerText()).toMatch(/middle entry is [\d,]+ hours long/);
    await page.locator("#cal-log-unit").selectOption({ label: "Seconds" });
    // The old answer is hidden until it is read again.
    expect(await step(page, "cal-log", "rows").count()).toBe(0);
    await readIt(page, "cal-log");
    expect(await step(page, "cal-log", "rows").innerText()).not.toContain("middle entry");
    expect(await step(page, "cal-log", "rows").locator("[data-import-preview] tbody").innerText()).toContain("0.5");
    expect(errors).toEqual([]);
    await page.close();
  }, 120_000);

  it("reads 50,000 rows in the worker, showing progress before the preview", async () => {
    const { page, errors } = await mount();
    const lines = ["Record ID,Deal Name,Deal Stage,Date entered stage"];
    const stages = ["Qualified lead", "Discovery call", "Proposal sent", "Negotiation", "Closed won"];
    for (let i = 0; i < 10_000; i++) for (let s = 0; s < 5; s++) lines.push(`${i},Deal ${i},${stages[s]},${new Date(Date.UTC(2026, 0, 1) + (i + s) * 3_600_000).toISOString().slice(0, 16).replace("T", " ")}`);
    await choose(page, "cal-log", "Deals from your CRM", csv(lines.join("\n")));
    await page.evaluate(() => {
      const w = window as unknown as { sawReading: boolean };
      w.sawReading = false;
      new MutationObserver(() => {
        if (/Reading… [\d,]+ of 50,000 rows/.test(document.body.innerText)) w.sawReading = true;
      }).observe(document.body, { subtree: true, childList: true, characterData: true });
    });
    await readIt(page, "cal-log");
    expect(await page.evaluate(() => (window as unknown as { sawReading: boolean }).sawReading)).toBe(true);
    const posts = await page.evaluate(() => [...window.importWorkerPosts]);
    expect(posts.filter((p) => p.file === "csv-import.worker.ts" && p.op === "read")).toHaveLength(1);
    expect(posts.filter((p) => p.file === "csv-import.worker.ts" && p.op === "load")).toHaveLength(1);
    const rows = step(page, "cal-log", "rows");
    expect(await rows.innerText()).toContain("Read 50,000 rows. 0 left out.");
    expect(await rows.locator("[data-import-preview] tbody tr").count()).toBe(20);
    expect(errors).toEqual([]);
    await page.close();
  }, 180_000);

  it("stops a read of 200,000 rows and returns to matching the columns, the page answering throughout", async () => {
    const { page, errors } = await mount();
    const lines = ["deal,stage,entered"];
    for (let i = 0; i < 200_000; i++) lines.push(`D${i},Qualify lead,2026-04-${String((i % 27) + 1).padStart(2, "0")} 09:00`);
    await choose(page, "cal-log", "Deals from your CRM", csv(lines.join("\n")));
    const columns = step(page, "cal-log", "columns");
    await columns.getByRole("button", { name: "Continue" }).click();
    const stop = columns.getByRole("button", { name: "Stop" });
    await stop.waitFor({ timeout: 30_000 });
    // The main thread answers while the worker reads: a timer fires and the page paints.
    const answered = await page.evaluate(() => new Promise<boolean>((r) => setTimeout(() => r(true), 20)));
    expect(answered).toBe(true);
    await stop.click();
    await columns.getByRole("button", { name: "Continue" }).waitFor({ timeout: 30_000 });
    expect(await step(page, "cal-log", "rows").count()).toBe(0);
    expect(await columns.innerText()).toContain("Match the columns");
    expect(await columns.innerText()).not.toContain("Reading…");
    // The columns the person matched are still there, and reading again works (a new worker loads the file again).
    expect(await picked(column(page, "cal-log", "stage").locator("select"))).toBe("stage");
    await columns.getByRole("button", { name: "Continue" }).click();
    await step(page, "cal-log", "rows").waitFor({ timeout: 150_000 });
    expect(await step(page, "cal-log", "rows").innerText()).toContain("Read 200,000 rows.");
    const posts = await page.evaluate(() => [...window.importWorkerPosts]);
    expect(posts.filter((p) => p.op === "load").length).toBeGreaterThanOrEqual(2);
    expect(errors).toEqual([]);
    await page.close();
  }, 300_000);

  it("fills the columns from the last import, with a badge, and falls back for a header that has gone", async () => {
    const { page, errors } = await mount({ previous: { deals: { deal: "Deal Name", stage: "Pipeline Status", entered: "Moved on", left: "Gone column" } } });
    const file = ["Record ID,Deal Name,Deal Stage,Pipeline Status,Moved on,Date entered", "1,D1,Qualified lead,Qualify lead,2026-04-02,2026-04-01"].join("\n");
    await choose(page, "cal-log", "Deals from your CRM", csv(file));
    const stage = column(page, "cal-log", "stage");
    expect(await picked(stage.locator("select"))).toBe("Pipeline Status");
    expect(await stage.innerText()).toContain("From your last import");
    expect(await picked(column(page, "cal-log", "entered").locator("select"))).toBe("Moved on");
    expect(await column(page, "cal-log", "entered").innerText()).toContain("From your last import");
    // "Gone column" isn't in this file: the date left is simply not matched.
    expect(await picked(column(page, "cal-log", "left").locator("select"))).toBe("Not in this file");
    expect(errors).toEqual([]);
    await page.close();
  }, 120_000);

  it("gives every field an (i), step by step", async () => {
    const { page, errors } = await mount({ samples: true });
    const help = (l: Locator) => l.locator('button[data-slot="help"]').count();
    const controls = (l: Locator) => l.locator("select, textarea, input").count();
    // Step 1: the kind, the file, the pasted rows, the delimiter and the header row: five fields, five (i)s.
    const file = step(page, "cal-log", "file");
    expect(await controls(file)).toBe(5);
    expect(await help(file)).toBe(5);
    await choose(page, "cal-log", "Deals from your CRM", csv(hubspotDeals()));
    // Step 2: one (i) for each column of the kind.
    const columns = step(page, "cal-log", "columns");
    expect(await columns.locator("[data-column]").count()).toBe(7);
    expect(await help(columns)).toBe(7);
    expect(await columns.locator("select").count()).toBe(7);
    await readIt(page, "cal-log");
    // Step 3: matching the names (one heading for the list) and using the rows.
    const rows = step(page, "cal-log", "rows");
    expect(await help(rows)).toBe(2);
    expect(await rows.locator("[data-import-names]").locator('button[data-slot="help"]').count()).toBe(1);
    // The date order question gives its own (i)s.
    await rows.getByRole("button", { name: "Start again" }).click();
    await choose(page, "cal-log", "Deals from your CRM", csv("deal,stage,entered\nD1,Qualify lead,02/03/2026"));
    await readIt(page, "cal-log");
    expect(await help(step(page, "cal-log", "rows"))).toBe(3);
    expect(errors).toEqual([]);
    await page.close();
  }, 120_000);

  it("on a read-only page hides Save the import and shows amounts as a dash", async () => {
    const { page, errors } = await mount({ mode: "readonly" });
    // A deals file: the mapper doesn't show amounts, and the preview shows a dash.
    await choose(page, "cal-log", "Deals from your CRM", csv(hubspotDeals(4)));
    expect(await column(page, "cal-log", "amount").innerText()).toContain("Amounts are shown to owners and editors only.");
    expect(await column(page, "cal-log", "amount").innerText()).not.toContain("9000");
    await readIt(page, "cal-log");
    const preview = step(page, "cal-log", "rows").locator("[data-import-preview]");
    const headers = await preview.locator("thead th").allInnerTexts();
    const amount = headers.indexOf("Amount");
    expect(amount).toBeGreaterThan(-1);
    const cells = await preview.locator(`tbody tr td:nth-child(${amount + 1})`).allInnerTexts();
    expect(cells.length).toBeGreaterThan(0);
    expect(cells.every((c) => c === "—")).toBe(true);
    expect(await text(page)).not.toContain("£9000");
    // Invoices: the card summarises them, and offers no Save for a viewer.
    const invoices = ["Invoice,Client,Date issued,Date due,Date paid,Amount", "I1,C1,2026-03-01,2026-03-15,2026-03-20,£1200", "I2,C2,2026-03-02,2026-03-16,,£800"].join("\n");
    await choose(page, "cal-other", "Invoices", csv(invoices));
    await readIt(page, "cal-other");
    await step(page, "cal-other", "rows").getByRole("button", { name: "Use these rows", exact: true }).click();
    await page.locator("#co-invoices").waitFor({ timeout: 30_000 });
    expect(await page.getByRole("button", { name: "Save the import", exact: true }).count()).toBe(0);
    expect(await page.locator("#co-invoices").locator("xpath=..").innerText()).toContain("Late payments aren't simulated yet, so nothing is changed.");
    expect(errors).toEqual([]);
    await page.close();
  }, 120_000);

  it("shows an owner Save the import for leads, as a check beside Settings", async () => {
    const { page, errors } = await mount({ samples: true });
    await wizard(page, "cal-other").getByRole("button", { name: "Use a sample" }).click();
    await step(page, "cal-other", "columns").waitFor({ timeout: 30_000 });
    await readIt(page, "cal-other");
    const rows = step(page, "cal-other", "rows");
    // The sample has a source the model lacks ("Podcast"): matched by hand it is left out.
    expect(await rows.locator("[data-import-names]").innerText()).toContain("Podcast");
    await rows.getByRole("button", { name: "Use these rows", exact: true }).click();
    await page.locator("#co-leads").waitFor({ timeout: 30_000 });
    const leads = page.locator("#co-leads").locator("xpath=..");
    expect(await leads.innerText()).toContain("Check only");
    expect(await leads.innerText()).toContain("Leads a week in the file");
    expect(await leads.innerText()).toContain("To change leads a week, read a stage history or deals in the card above.");
    expect(await page.getByRole("button", { name: "Save the import", exact: true }).count()).toBe(1);
    expect(errors).toEqual([]);
    await page.close();
  }, 120_000);
});
