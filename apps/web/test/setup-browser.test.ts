import { chromium, type Browser, type Locator, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bundleHarness } from "./build-harness";

// Set up, Tiers & clients and People & roles (capacity build P1), in a real browser (./setup-harness/entry.tsx): the tables render with their
// (i)s, an edit asks the server to save that field against what is stored, blank client cells show the tier's values greyed, a Viewer gets
// text and no inputs, and whoever can't see pay doesn't get the salary column. (The page has no stylesheet here, so the width on a phone is
// not measured: every table sits in the shared Table, which scrolls sideways on its own.)

let browser: Browser;
let script: string;

beforeAll(async () => {
  script = await bundleHarness(new URL("./setup-harness/entry.tsx", import.meta.url));
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
}, 120_000);

afterAll(async () => {
  await browser?.close();
});

async function mount(options: Parameters<Window["mountSetup"]>[0], width = 1440): Promise<{ page: Page; errors: string[] }> {
  const page = await browser.newPage({ viewport: { width, height: 1000 } });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.setContent(`<div id="root"></div>`);
  await page.addScriptTag({ content: script });
  await page.evaluate((o) => window.mountSetup(o), options);
  try {
    await page.waitForSelector("[data-setup]", { timeout: 15_000 });
  } catch (e) {
    throw new Error(`the page did not render: ${errors.join(" | ")} (${(e as Error).message})`);
  }
  return { page, errors };
}
/** The words of each column heading, without the (i) beside them. */
const headTexts = (scope: Locator) =>
  scope.locator("th").evaluateAll((ths) => ths.map((th) => Array.from((th.querySelector("span") ?? th).childNodes).filter((n) => n.nodeType === 3).map((n) => n.textContent ?? "").join("").trim()));
const calls = (page: Page) => page.evaluate(() => window.__serverActions ?? []);
const noise = (e: string) => /Not available|Failed to load resource/.test(e);

describe("Tiers & clients", { timeout: 120_000 }, () => {
  it("shows one table per department with the department's fields, every heading with an (i)", async () => {
    const { page, errors } = await mount({ page: "clients", who: "owner" });
    const headings = (title: string) => headTexts(page.locator(`[role=region]`, { has: page.getByRole("heading", { name: title }) }).first());
    const organic = await headings("Organic (SEO) tiers");
    expect(organic).toEqual(["Tier", "Clients", "Fee a month", "Words", "Links", "Tech hours", "Meetings", "Chance of ad hoc %", "Requests if they ask", "Churn a month %", "More"]);
    const performance = await headings("Performance tiers");
    expect(performance).toContain("Channels");
    expect(performance).toContain("Builds");
    expect(performance).toContain("Creative sets");
    expect(performance).not.toContain("Words");
    // No "Hours a month" column: it needs the engine.
    expect(organic.join()).not.toMatch(/Hours a month/);
    expect(await page.locator("[data-slot=help]").count()).toBeGreaterThan(20);
    expect(errors.filter((e) => !noise(e))).toEqual([]);
    await page.close();
  });

  it("counts a tier's clients as the sum of the named clients and the portfolios, and shows 'missing' and the source in place", async () => {
    const { page } = await mount({ page: "clients", who: "owner" });
    // Organic T1 has Harbourline (named) only; Organic T2 has Karl's 6 in his portfolio.
    expect(await page.locator("[data-tier=T1][data-department='Organic (SEO)'] [data-tier-count]").innerText()).toContain("1");
    expect(await page.locator("[data-tier=T1][data-department='Organic (SEO)'] [data-tier-count]").innerText()).toContain("1 named");
    expect(await page.locator("[data-tier=T2][data-department='Organic (SEO)'] [data-tier-count]").innerText()).toBe("6");
    expect(await page.locator("[data-tier=T3][data-department='Organic (SEO)'] [data-tier-count]").innerText()).toBe("0");
    // Organic T2 has requests blank: missing. Its words came from an estimate.
    const t2 = page.locator("[data-tier=T2][data-department='Organic (SEO)']");
    expect(await t2.locator("[data-missing]").count()).toBe(1);
    expect(await t2.locator("[data-source]").first().innerText()).toBe("Estimate");
    await page.close();
  });

  it("an edit asks the server to save that field against what is stored", async () => {
    const { page } = await mount({ page: "clients", who: "owner" });
    const words = page.getByLabel("Organic (SEO) T2: Words", { exact: true });
    expect(await words.inputValue()).toBe("1500");
    await words.fill("1750");
    await words.blur();
    await page.waitForFunction(() => (window.__serverActions?.length ?? 0) > 0);
    expect((await calls(page))[0]).toEqual({ name: "saveSetupField", args: ["services", { id: "b0000000-0000-4000-8000-000000000002" }, "words", 1500, 1750] });
    // A percentage is typed as a percentage and stored as a share.
    const chance = page.getByLabel("Organic (SEO) T2: Chance of ad hoc", { exact: true });
    expect(await chance.inputValue()).toBe("70");
    await chance.fill("75");
    await chance.blur();
    await page.waitForFunction(() => (window.__serverActions?.length ?? 0) > 1);
    expect((await calls(page))[1]!.args.slice(2)).toEqual(["adhoc_chance", 0.7, 0.75]);
    await page.close();
  });

  it("a named client's blank cells show its tier's values greyed, and its own values stand", async () => {
    const { page } = await mount({ page: "clients", who: "owner" });
    const row = page.locator("tr[data-client='Harbourline Group']");
    // Own: hand-holding 3, chance 100%, requests 8, meetings 4. Blank: channels (not Performance), request size.
    expect(await row.getByLabel("Harbourline Group: Hand-holding h", { exact: true }).inputValue()).toBe("3");
    expect(await row.getByLabel("Harbourline Group: Chance of ad hoc %", { exact: true }).inputValue()).toBe("100");
    expect(await row.getByLabel("Harbourline Group: Meetings a month", { exact: true }).inputValue()).toBe("4");
    const size = row.getByLabel("Harbourline Group: Request size (min)", { exact: true });
    expect(await size.inputValue()).toBe("");
    expect(await size.getAttribute("placeholder")).toBe("the step's time");
    // The fee is its own (13000); with 0 it would show the tier's.
    expect(await row.getByLabel("Harbourline Group: Fee", { exact: true }).inputValue()).toBe("13000");
    await page.close();
  });

  it("+ Add a tier is there, and Remove shows only past three tiers", async () => {
    const three = await mount({ page: "clients", who: "owner" });
    expect(await three.page.getByRole("button", { name: "+ Add a tier" }).count()).toBe(1);
    expect(await three.page.getByRole("button", { name: /^Remove T/ }).count()).toBe(0);
    await three.page.getByRole("button", { name: "+ Add a tier" }).click();
    await three.page.waitForFunction(() => (window.__serverActions?.length ?? 0) > 0);
    expect((await calls(three.page))[0]!.name).toBe("addTierAction");
    await three.page.close();
    const four = await mount({ page: "clients", who: "owner", extraTiers: 1 });
    expect(await four.page.getByRole("button", { name: "Remove T4" }).count()).toBe(1);
    await four.page.close();
  });

  it("a Viewer sees the same tables as text: no inputs, no add or remove", async () => {
    const { page, errors } = await mount({ page: "clients", who: "viewer", extraTiers: 1 });
    expect(await page.locator("table input, table select").count()).toBe(0);
    expect(await page.getByRole("button", { name: /Add a tier|Remove T|Add a client/ }).count()).toBe(0);
    const text = await page.locator("[data-setup=clients]").innerText();
    expect(text).toContain("Harbourline Group");
    expect(text).toContain("1,500");
    expect(errors.filter((e) => !noise(e))).toEqual([]);
    await page.close();
  });

});

describe("People & roles", { timeout: 120_000 }, () => {
  it("shows the roles, the shared teams without rates, and the people with a count per tier", async () => {
    const { page, errors } = await mount({ page: "people", who: "owner" });
    const roles = (await page.locator("tr[data-role]").allInnerTexts()).join("\n");
    expect(roles).toContain("SEO Manager");
    expect(await page.getByLabel("SEO Manager: max-clients rule", { exact: true }).inputValue()).toBe("10");
    expect(await page.getByLabel("SEO Manager: line (busy %)", { exact: true }).inputValue()).toBe("85");
    // The rule of thumb is for client-facing roles, the unit for shared teams.
    expect(await page.getByLabel("Content team: unit of work", { exact: true }).inputValue()).toBe("words");
    expect(await page.getByLabel("Content team: max-clients rule").count()).toBe(0);
    expect(await page.locator("[data-shared-role] [data-rate-missing]").count()).toBe(2);
    expect(await page.locator("[data-shared-role]").first().innerText()).toContain("Rate not entered yet");
    // A shared role without a unit is flagged missing.
    expect(await page.locator("tr[data-role='Technical SEO'] [data-missing]").count()).toBe(1);
    const head = await headTexts(page.locator("[role=region]", { has: page.getByRole("heading", { name: "People", exact: true }) }).first());
    expect(head).toEqual(["Person", "Role", "Hours a week", "Team time %", "Salary a month", "Serves tiers", "T1", "T2", "T3", "Named", "Label", "More"]);
    // Karl: team time 20%, salary 10000, a portfolio of 6 on T2; Harbourline listed as his named client.
    const karl = page.locator("tr[data-person='Karl']");
    expect(await karl.getByLabel("Karl: team time %", { exact: true }).inputValue()).toBe("20");
    expect(await karl.getByLabel("Karl: salary a month", { exact: true }).inputValue()).toBe("10000");
    expect(await karl.getByLabel("Karl: T2 clients", { exact: true }).inputValue()).toBe("6");
    expect(await karl.getByLabel("Karl: T3 clients", { exact: true }).inputValue()).toBe("0");
    expect(await karl.innerText()).toContain("Harbourline Group");
    // The ramp default and the DLER switch, with the to-confirm tag.
    expect(await page.getByLabel("Ramp-up default for new starters", { exact: true }).inputValue()).toBe("40, 60, 80");
    expect(await page.locator("[data-to-confirm]").innerText()).toBe("To confirm with the client");
    expect(errors.filter((e) => !noise(e))).toEqual([]);
    await page.close();
  });

  it("an edit asks the server to save that field; a portfolio count goes to its own action", async () => {
    const { page } = await mount({ page: "people", who: "owner" });
    const karl = page.locator("tr[data-person='Karl']");
    const share = karl.getByLabel("Karl: team time %", { exact: true });
    await share.fill("25");
    await share.blur();
    await page.waitForFunction(() => (window.__serverActions?.length ?? 0) > 0);
    expect((await calls(page))[0]).toEqual({ name: "saveSetupField", args: ["people", { id: "f0000000-0000-4000-8000-000000000001" }, "reserved_share", 0.2, 0.25] });
    const t3 = karl.getByLabel("Karl: T3 clients", { exact: true });
    await t3.fill("4");
    await t3.blur();
    await page.waitForFunction(() => (window.__serverActions?.length ?? 0) > 1);
    expect((await calls(page))[1]).toMatchObject({ name: "savePortfolioCount" });
    expect((await calls(page))[1]!.args.slice(3)).toEqual([0, 4]);
    await page.close();
  });

  it("a Viewer sees text and no inputs, and the salary column is gone", async () => {
    const { page, errors } = await mount({ page: "people", who: "viewer" });
    expect(await page.locator("table input, table select").count()).toBe(0);
    const text = await page.locator("[data-setup=people]").innerText();
    expect(text).toContain("Karl");
    expect(text).not.toContain("Salary a month");
    expect(text).not.toContain("10000");
    expect(text).not.toContain("10,000");
    expect(await page.getByRole("button", { name: /Add person|Add role/ }).count()).toBe(0);
    expect(errors.filter((e) => !noise(e))).toEqual([]);
    await page.close();
  });

});
