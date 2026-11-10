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

describe("a tier's typed client count (Q13) and what Set up no longer shows (D45 to D47)", { timeout: 120_000 }, () => {
  it("typing a total saves services.client_total against what is stored; clearing it saves null", async () => {
    const { page } = await mount({ page: "clients", who: "owner", scenario: "totals" });
    const cell = page.getByLabel("Organic (SEO) T3: Clients", { exact: true });
    expect(await cell.inputValue()).toBe("");
    await cell.fill("20");
    await cell.blur();
    await page.waitForFunction(() => (window.__serverActions?.length ?? 0) > 0);
    expect((await calls(page))[0]).toEqual({ name: "saveSetupField", args: ["services", { id: "b0000000-0000-4000-8000-000000000003" }, "client_total", null, 20] });
    const typed = page.getByLabel("Organic (SEO) T1: Clients", { exact: true });
    expect(await typed.inputValue()).toBe("13");
    await typed.fill("");
    await typed.blur();
    await page.waitForFunction(() => (window.__serverActions?.length ?? 0) > 1);
    expect((await calls(page))[1]!.args.slice(2)).toEqual(["client_total", 13, null]);
    await page.close();
  });

  it("shows 'over' as a warning pill and 'unassigned' as a note, each with its sentence", async () => {
    const { page } = await mount({ page: "clients", who: "owner", scenario: "totals" });
    const org = (tier: string) => page.locator(`[data-tier=${tier}][data-department='Organic (SEO)']`);
    // T1: total 13, one named client and nothing in portfolios: 12 are in nobody's portfolio.
    const unassigned = org("T1").locator("[data-discrepancy=unassigned]");
    expect(await unassigned.count()).toBe(1);
    expect(await unassigned.getAttribute("title")).toBe("12 clients aren't in anyone's portfolio.");
    expect(await unassigned.innerText()).toContain("12 unassigned");
    // T2: total 4 but 6 in portfolios: 2 too many, and the model counts the portfolios as they are.
    const over = org("T2").locator("[data-discrepancy=over]");
    expect(await over.count()).toBe(1);
    expect(await over.getAttribute("title")).toBe("Portfolios and named clients add up to 6, but the tier has 4 (2 too many). The model counts the portfolios as they are.");
    expect(await over.innerText()).toContain("2 too many");
    // T3 has no total: no pill. The effective count of T1 is its total.
    expect(await org("T3").locator("[data-discrepancy]").count()).toBe(0);
    expect(await org("T1").locator("[data-tier-count]").getAttribute("data-count")).toBe("13");
    expect(await org("T2").locator("[data-tier-count]").getAttribute("data-count")).toBe("6");
    await page.close();
  });

  it("People & roles shows the same pill beside the tier's portfolio total", async () => {
    const { page } = await mount({ page: "people", who: "owner", scenario: "totals" });
    const t2 = page.locator("[data-portfolio-total=T2]");
    expect(await t2.locator("b").innerText()).toBe("6");
    const pill = t2.locator("[data-discrepancy=over]");
    expect(await pill.count()).toBe(1);
    expect(await pill.getAttribute("title")).toContain("Organic (SEO): Portfolios and named clients add up to 6, but the tier has 4 (2 too many).");
    expect(await page.locator("[data-portfolio-total=T1] [data-discrepancy=unassigned]").count()).toBe(1);
    await page.close();
    const plain = await mount({ page: "people", who: "owner" });
    expect(await plain.page.locator("[data-discrepancy]").count()).toBe(0);
    expect(await plain.page.locator("[data-portfolio-total=T2] b").innerText()).toBe("6");
    await plain.page.close();
  });

  it("a Viewer sees the typed total and the pill as text, with no input", async () => {
    const { page } = await mount({ page: "clients", who: "viewer", scenario: "totals" });
    expect(await page.getByLabel("Organic (SEO) T1: Clients", { exact: true }).innerText()).toBe("13");
    expect(await page.locator("input[aria-label='Organic (SEO) T1: Clients']").count()).toBe(0);
    expect(await page.locator("[data-discrepancy]").count()).toBe(2);
    await page.close();
  });

  it("D45: Named clients are folded away when there are none, and open when there are some", async () => {
    const line = "Name a client only when it behaves differently from its tier: its own fee, channels, hand-holding or ad hoc.";
    const none = await mount({ page: "clients", who: "owner", scenario: "no-named" });
    expect(await none.page.locator("[data-setup=clients]").innerText()).toContain(line);
    expect(await none.page.locator("[data-named-body]").count()).toBe(0);
    expect(await none.page.locator("[data-add-named-client]").count()).toBe(0);
    await none.page.getByRole("button", { name: "Show named clients" }).click();
    expect(await none.page.locator("[data-add-named-client]").count()).toBe(1);
    await none.page.close();
    const some = await mount({ page: "clients", who: "owner" });
    expect(await some.page.locator("[data-setup=clients]").innerText()).toContain(line);
    expect(await some.page.locator("[data-named-body]").count()).toBe(1);
    await some.page.getByRole("button", { name: "Hide named clients" }).click();
    expect(await some.page.locator("[data-named-body]").count()).toBe(0);
    await some.page.close();
  });

  it("D46 and D47: no Other services section and no client health benchmark; one muted line when there are other services", async () => {
    const plain = await mount({ page: "clients", who: "owner" });
    const text = await plain.page.locator("[data-setup=clients]").innerText();
    expect(text).not.toMatch(/Other services|client health benchmark|Client health benchmark|Health benchmark/i);
    expect(await plain.page.locator("#other-services").count()).toBe(0);
    expect(await plain.page.locator("[data-other-services]").count()).toBe(0);
    await plain.page.close();
    const other = await mount({ page: "clients", who: "owner", scenario: "other-services" });
    expect(await other.page.locator("[data-other-services]").innerText()).toBe("This workspace also has 2 other services (projects or hourly work) that aren't tiers. They still count in the simulation.");
    expect(await other.page.locator("#other-services").count()).toBe(0);
    expect(await other.page.locator("[data-setup=clients]").innerText()).not.toMatch(/Website project|Hourly work/);
    await other.page.close();
  });
});

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
    const count = (tier: string) => page.locator(`[data-tier=${tier}][data-department='Organic (SEO)'] [data-tier-count]`);
    expect(await count("T1").getAttribute("data-count")).toBe("1");
    expect(await count("T1").innerText()).toContain("1 named");
    expect(await count("T2").getAttribute("data-count")).toBe("6");
    expect(await count("T3").getAttribute("data-count")).toBe("0");
    // Nothing typed: the worked-out count is the greyed placeholder in the Clients cell, and there is no pill.
    expect(await page.getByLabel("Organic (SEO) T2: Clients", { exact: true }).getAttribute("placeholder")).toBe("6");
    expect(await page.getByLabel("Organic (SEO) T2: Clients", { exact: true }).inputValue()).toBe("");
    expect(await page.locator("[data-discrepancy]").count()).toBe(0);
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

  it("adds a named client with its tier, MRR and start date; the form asks the server once and clears", async () => {
    const { page } = await mount({ page: "clients", who: "owner" });
    const form = page.locator("[data-add-named-client]");
    await form.getByLabel("New client name", { exact: true }).fill("Bright Smile Ortho");
    await form.getByLabel("New client tier", { exact: true }).selectOption({ label: "T2" });
    await form.getByLabel("New client MRR", { exact: true }).fill("2400");
    await form.getByLabel("New client start date", { exact: true }).fill("2026-09-01");
    await form.getByRole("button", { name: "+ Add a client" }).click();
    await page.waitForFunction(() => (window.__serverActions?.length ?? 0) > 0);
    // Organic (the first department) T2: its service id (b...2).
    expect((await calls(page))[0]).toEqual({ name: "addNamedClient", args: ["00000000-0000-4000-8000-000000000001", "b0000000-0000-4000-8000-000000000002", "Bright Smile Ortho", { mrr: "2400", start_date: "2026-09-01" }] });
    await page.close();
  });

  it("inactive clients are hidden until asked for; an inactive role says so; and the page says which clients drive the simulation", async () => {
    const { page } = await mount({ page: "clients", who: "owner" });
    expect(await page.locator("tr[data-client='Old Mill Bakery']").count()).toBe(0);
    await page.getByRole("button", { name: "Show 1 inactive client" }).click();
    expect(await page.locator("tr[data-client='Old Mill Bakery']").count()).toBe(1);
    await page.getByRole("button", { name: "Hide inactive clients" }).click();
    expect(await page.locator("tr[data-client='Old Mill Bakery']").count()).toBe(0);
    // The one-line rule that used to head the full Clients list now sits under Named clients.
    expect(await page.locator("[data-setup=clients]").innerText()).toMatch(/A process whose services have clients counted/);
    // Nothing is folded away any more.
    expect(await page.locator("[data-setup=clients] details").count()).toBe(0);
    await page.close();
    const people = await mount({ page: "people", who: "owner" });
    expect(await people.page.locator("[data-role='Old analyst']").innerText()).toContain("Inactive");
    // Nothing is folded away on People & roles either (the Advanced card went with D48 and D49).
    expect(await people.page.locator("[data-setup=people] details").count()).toBe(0);
    await people.page.close();
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
  it("shows one standard row per person and per role, the shared teams without rates, and no Advanced card", async () => {
    const { page, errors } = await mount({ page: "people", who: "owner" });
    // Every person has the same columns; the heading row names them (with an (i) each).
    const heads = await page.locator("[data-people-list] th > span:first-child").allInnerTexts();
    expect(heads.map((h) => h.trim())).toEqual(["Person", "Role", "Department", "Hours a week", "Team time", "Salary a month", "Label"]);
    const karl = page.locator("[data-person='Karl']");
    expect(await karl.innerText()).toContain("SEO Manager");
    expect(await karl.locator("[data-cell=department]").innerText()).toBe("Organic (SEO)");
    expect(await karl.locator("[data-cell=hours]").innerText()).toBe("38");
    expect(await karl.locator("[data-cell=team-time]").innerText()).toBe("20%");
    expect(await karl.locator("[data-cell=salary]").innerText()).toMatch(/10,000/);
    // Sarah is in a shared team: the same columns, nothing extra.
    expect(await page.locator("[data-person='Sarah'] [data-cell]").count()).toBe(await karl.locator("[data-cell]").count());
    // No inputs in a row, and no sideways scroll.
    expect(await page.locator("[data-people-list] input, [data-roles-list] input").count()).toBe(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    // Roles: name, department, kind, busy line, people.
    const roles = page.locator("[data-role='SEO Manager']");
    expect(await roles.locator("[data-cell=kind]").innerText()).toBe("Client-facing");
    expect(await roles.locator("[data-cell=line]").innerText()).toBe("85%");
    expect(await roles.locator("[data-cell=people]").innerText()).toBe("1");
    // A shared role without a unit is flagged missing.
    expect(await page.locator("[data-role='Technical SEO'] [data-missing]").count()).toBe(1);
    // The shared teams card.
    expect(await page.locator("[data-shared-role] [data-rate-missing]").count()).toBe(2);
    expect(await page.locator("[data-shared-role]").first().innerText()).toContain("Rate not entered yet");
    // D48 and D49: no DLER switch, no ramp-up setting, no Advanced card.
    const text = await page.locator("[data-setup=people]").innerText();
    expect(text).not.toMatch(/Ramp-up|ramp/i);
    expect(await page.getByLabel(/Directors and managers count|includes leadership/i).count()).toBe(0);
    expect(await page.locator("[data-advanced], [data-to-confirm]").count()).toBe(0);
    expect(errors.filter((e) => !noise(e))).toEqual([]);
    await page.close();
  });

  it("a click opens the person panel with Basics, Clients, Time and More; a shared-team person has no Clients group", async () => {
    const { page, errors } = await mount({ page: "people", who: "owner" });
    await page.locator("[data-person='Karl']").click();
    const panel = page.locator("[data-person-panel='Karl']");
    await panel.waitFor();
    expect(await panel.locator("[data-panel-group]").evaluateAll((g) => g.map((x) => x.getAttribute("data-panel-group")))).toEqual(["basics", "clients", "time", "more"]);
    expect(await panel.getByLabel("Team time %", { exact: true }).inputValue()).toBe("20");
    expect(await panel.getByLabel("Salary a month", { exact: true }).inputValue()).toBe("10000");
    expect(await panel.getByLabel("Hours a week", { exact: true }).inputValue()).toBe("38");
    expect(await panel.getByLabel("T2 clients", { exact: true }).inputValue()).toBe("6");
    expect(await panel.getByLabel("T3 clients", { exact: true }).inputValue()).toBe("0");
    expect(await panel.locator("[data-named-clients]").innerText()).toContain("Harbourline Group");
    expect(await panel.innerText()).toContain("Only people in client-facing roles look after clients.");
    // No own-ramp field any more (D49).
    expect(await panel.getByLabel("Ramp-up for a new starter").count()).toBe(0);
    await page.keyboard.press("Escape");
    await page.locator("[data-person-panel]").waitFor({ state: "detached" });
    await page.locator("[data-person='Sarah']").click();
    const sarah = page.locator("[data-person-panel='Sarah']");
    await sarah.waitFor();
    expect(await sarah.locator("[data-panel-group]").evaluateAll((g) => g.map((x) => x.getAttribute("data-panel-group")))).toEqual(["basics", "time", "more"]);
    expect(errors.filter((e) => !noise(e))).toEqual([]);
    await page.close();
  });

  it("an edit in the panel asks the server to save that field; a portfolio count goes to its own action", async () => {
    const { page } = await mount({ page: "people", who: "owner" });
    await page.locator("[data-person='Karl']").click();
    const panel = page.locator("[data-person-panel='Karl']");
    const share = panel.getByLabel("Team time %", { exact: true });
    await share.fill("25");
    await share.blur();
    await page.waitForFunction(() => (window.__serverActions?.length ?? 0) > 0);
    expect((await calls(page))[0]).toEqual({ name: "saveSetupField", args: ["people", { id: "f0000000-0000-4000-8000-000000000001" }, "reserved_share", 0.2, 0.25] });
    const t3 = panel.getByLabel("T3 clients", { exact: true });
    await t3.fill("4");
    await t3.blur();
    await page.waitForFunction(() => (window.__serverActions?.length ?? 0) > 1);
    expect((await calls(page))[1]).toMatchObject({ name: "savePortfolioCount" });
    expect((await calls(page))[1]!.args.slice(3)).toEqual([0, 4]);
    await page.close();
  });

  it("a role's panel holds the rest: rule of thumb for client-facing, unit for shared", async () => {
    const { page } = await mount({ page: "people", who: "owner" });
    await page.locator("[data-role='SEO Manager']").click();
    const seo = page.locator("[data-role-panel='SEO Manager']");
    await seo.waitFor();
    expect(await seo.getByLabel("Rule of thumb: most clients", { exact: true }).inputValue()).toBe("10");
    expect(await seo.getByLabel("Utilisation threshold %", { exact: true }).inputValue()).toBe("85");
    expect(await seo.getByLabel("Unit of work").count()).toBe(0);
    expect(await seo.getByLabel("Leadership", { exact: true }).count()).toBe(1);
    await page.keyboard.press("Escape");
    await page.locator("[data-role-panel]").waitFor({ state: "detached" });
    await page.locator("[data-role='Content team']").click();
    const content = page.locator("[data-role-panel='Content team']");
    await content.waitFor();
    expect(await content.getByLabel("Unit of work", { exact: true }).inputValue()).toBe("words");
    expect(await content.getByLabel("Rule of thumb: most clients").count()).toBe(0);
    await page.close();
  });

  it("search and the Role filter narrow the people", async () => {
    const { page } = await mount({ page: "people", who: "owner" });
    expect(await page.locator("[data-people-list] [data-person]").count()).toBe(2);
    await page.getByLabel("Search people").fill("sar");
    expect(await page.locator("[data-people-list] [data-person]").count()).toBe(1);
    await page.getByRole("button", { name: "Clear filters" }).click();
    await page.getByRole("button", { name: /^Role/ }).click();
    await page.locator("[data-filter-menu=role] [data-option]").first().check();
    expect(await page.locator("[data-people-list] [data-person]").count()).toBe(1);
    await page.close();
  });

  it("+ Add person and + Add role open a dialog with the form", async () => {
    const { page } = await mount({ page: "people", who: "owner" });
    await page.getByRole("button", { name: "+ Add person" }).click();
    expect(await page.getByRole("dialog").getByLabel("Name").count()).toBe(1);
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "+ Add role" }).click();
    expect(await page.getByRole("dialog").getByRole("button", { name: "Add role" }).count()).toBe(1);
    await page.close();
  });

  it("a Viewer sees the rows and a read-only panel, and the salary column is gone", async () => {
    const { page, errors } = await mount({ page: "people", who: "viewer" });
    const text = await page.locator("[data-setup=people]").innerText();
    expect(text).toContain("Karl");
    expect(text).not.toContain("Salary a month");
    expect(text).not.toContain("10000");
    expect(text).not.toContain("10,000");
    expect(await page.getByRole("button", { name: /Add person|Add role/ }).count()).toBe(0);
    await page.locator("[data-person='Karl']").click();
    const panel = page.locator("[data-person-panel='Karl']");
    await panel.waitFor();
    expect(await panel.getByLabel("Salary a month").count()).toBe(0);
    expect(await panel.locator("input:not([disabled]), select:not([disabled]), textarea:not([disabled])").count()).toBe(0);
    expect(errors.filter((e) => !noise(e))).toEqual([]);
    await page.close();
  });

  it("at 400 px the page does not scroll sideways (the collapse itself is in the screenshots: the harness has no stylesheet)", async () => {
    const { page } = await mount({ page: "people", who: "owner" }, 400);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.close();
  });
});
