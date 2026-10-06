import { chromium, type Browser, type Locator, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { larkspurBundle, larkspurPersonIds, type PersonCapacityFactorRow } from "@transpera-flow/db";
import { bundleHarness } from "./build-harness";

// Settings -> Simulation and People (C6, issue #198), in a real browser (./settings-harness/entry.tsx): who can switch
// Per-person times, when the per-person fields appear, what an editor can type, and what a member's own row shows.

let browser: Browser;
let script: string;

beforeAll(async () => {
  script = await bundleHarness(new URL("./settings-harness/entry.tsx", import.meta.url));
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
}, 120_000);

afterAll(async () => {
  await browser?.close();
});

const live = larkspurBundle();
const WS = live.workspace.id;
const JESS = larkspurPersonIds.jess!;
const jessRoles = new Set(live.personRoles.filter((r) => r.person_id === JESS).map((r) => r.role_id));
const own = live.steps.find((s) => s.role_id && jessRoles.has(s.role_id))!;
const foreign = live.steps.find((s) => s.role_id && !jessRoles.has(s.role_id))!;
const row = (person: string, step: string | null, factor: number): PersonCapacityFactorRow => ({ person_id: person, workspace_id: WS, step_id: step, factor, source: "entered" });
const GONE = "00000000-0000-4000-8000-00000000dead";

async function mount(options: Parameters<Window["mountSettings"]>[0], width = 1440): Promise<{ page: Page; errors: string[] }> {
  const page = await browser.newPage({ viewport: { width, height: 1000 } });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.setContent(`<div id="root"></div>`);
  await page.addScriptTag({ content: script });
  await page.evaluate((o) => window.mountSettings(o), options);
  await page.waitForSelector("#simulation-heading");
  return { page, errors };
}

/** Opens a person's row (a <details>) and returns it. */
async function openPerson(page: Page, name: string): Promise<Locator> {
  const details = page.locator("details", { hasText: name }).first();
  await details.locator("summary").click();
  return details;
}
const calls = (page: Page) => page.evaluate(() => window.__serverActions ?? []);
const field = (scope: Locator | Page, label: string) => scope.getByLabel(label, { exact: true });

describe("Settings: Per-person times switch", { timeout: 120_000 }, () => {
  it("an owner can change the switch, the floor and the cap", async () => {
    const { page, errors } = await mount({ who: "owner" });
    expect(await field(page, "Per-person times").isDisabled()).toBe(false);
    expect(await field(page, "Availability floor").isDisabled()).toBe(false);
    expect(await field(page, "Overtime cap").isDisabled()).toBe(false);
    expect(await page.locator("#simulation-heading").locator("xpath=ancestor::*[@role='region']").innerText()).toContain("Limits on how the simulation treats people's time.");
    expect(errors).toEqual([]);
    await page.close();
  });

  it("an editor can change the switch, but the floor and the cap stay owner-only", async () => {
    const { page, errors } = await mount({ who: "editor" });
    expect(await field(page, "Per-person times").isDisabled()).toBe(false);
    expect(await field(page, "Availability floor").isDisabled()).toBe(true);
    expect(await field(page, "Overtime cap").isDisabled()).toBe(true);
    // Switching it asks the server to save true against the stored (off).
    await field(page, "Per-person times").check();
    await page.waitForFunction(() => (window.__serverActions?.length ?? 0) > 0);
    expect((await calls(page))[0]).toEqual({ name: "saveCapacityFactorsEnabled", args: [WS, false, true] });
    expect(errors.filter((e) => !/Not available|Failed to load resource/.test(e))).toEqual([]);
    await page.close();
  });

  it("a member can't change it, and is told who can; the (i) is there", async () => {
    const { page, errors } = await mount({ who: "member" });
    expect(await field(page, "Per-person times").isDisabled()).toBe(true);
    expect(await page.locator("#simulation-heading").locator("xpath=ancestor::*[@role='region']").innerText()).toContain("Only owners and editors can change this.");
    expect(await page.getByRole("button", { name: "About Per-person times" }).count()).toBe(1);
    expect(errors).toEqual([]);
    await page.close();
  });
});

describe("Settings: a person's time on each step", { timeout: 120_000 }, () => {
  it("switch off: no editor; a person with stored times gets one muted line and no values; a person with none gets nothing", async () => {
    const { page, errors } = await mount({ who: "editor", switch: false, factors: [row(JESS, null, 0.85), row(JESS, own.id, 1.15)] });
    const jess = await openPerson(page, "Jess Monroe");
    expect(await page.locator("[data-capacity-factors-editor]").count()).toBe(0);
    expect(await jess.locator("[data-factors-off]").innerText()).toBe("Per-person times are off, so these aren't used.");
    const text = await page.locator("#root").innerText();
    expect(text).not.toMatch(/0\.85|1\.15|Time on each step/);
    const hana = await openPerson(page, "Hana Whitfield");
    expect(await hana.locator("[data-factors-off]").count()).toBe(0);
    expect(errors).toEqual([]);
    await page.close();
  });

  it("switch on, an editor: Every step then one field per step they do, in order, each with an (i) and its words", async () => {
    const { page, errors } = await mount({ who: "editor", switch: true, factors: [row(JESS, null, 0.9), row(JESS, own.id, 1.25)] });
    const jess = await openPerson(page, "Jess Monroe");
    const box = jess.locator("[data-capacity-factors-editor]");
    expect(await box.locator("legend").innerText()).toContain("Time on each step");
    expect(await box.getByRole("button", { name: "About Time on each step" }).count()).toBe(1);
    const every = field(box, "Every step");
    expect(await every.inputValue()).toBe("0.9");
    expect(await every.getAttribute("min")).toBe("0.5");
    expect(await every.getAttribute("max")).toBe("2");
    expect(await every.getAttribute("step")).toBe("0.05");
    expect(await every.getAttribute("placeholder")).toBe("1 (normal)");
    expect(await box.getByRole("button", { name: "About Every step" }).count()).toBe(1);
    const stepField = field(box, own.name);
    expect(await stepField.inputValue()).toBe("1.25");
    expect(await box.getByRole("button", { name: `About ${own.name}` }).count()).toBe(1);
    const words = await box.locator("[data-factor-words]").allInnerTexts();
    expect(words).toEqual(["10% faster", "25% slower"]);
    // The step fields come in the steps' own order, after "Every step" (never by value).
    const labels = await box.locator("label").allInnerTexts();
    expect(labels[0]).toBe("Every step");
    const order = live.steps.filter((s) => s.role_id && jessRoles.has(s.role_id)).map((s) => s.name);
    expect(labels.slice(1)).toEqual(order);
    // A step with no time of its own says it follows the default.
    const other = order.find((n) => n !== own.name);
    if (other) expect(await field(box, other).getAttribute("placeholder")).toBe("Same as every step");
    // Typing a value asks the server to save it: no stored time, so base null.
    await field(box, other ?? own.name).fill("0.8");
    await field(box, other ?? own.name).blur();
    await page.waitForFunction(() => (window.__serverActions?.length ?? 0) > 0);
    const [call] = await calls(page);
    expect(call).toMatchObject({ name: "savePersonCapacityFactor" });
    expect(call!.args[0]).toBe(JESS);
    expect(call!.args[3]).toBe(0.8);
    expect(errors.filter((e) => !/Not available|Failed to load resource/.test(e))).toEqual([]);
    await page.close();
  });

  it("stored times for steps they can't do or that have left are listed under Not used now, with Remove", async () => {
    const { page, errors } = await mount({ who: "editor", switch: true, factors: [row(JESS, foreign.id, 1.4), row(JESS, GONE, 0.7)] });
    const jess = await openPerson(page, "Jess Monroe");
    const stale = jess.locator("[data-factors-not-used]");
    const text = await stale.innerText();
    expect(text).toContain("Not used now");
    expect(text).toContain(foreign.name);
    expect(text).toContain("A step no longer in a live process");
    expect(await stale.getByRole("button", { name: "Remove" }).count()).toBe(2);
    expect(await jess.getByRole("button", { name: "About Not used now" }).count()).toBe(1);
    // Those steps are not offered as fields.
    expect(await jess.locator("[data-capacity-factors-editor] label", { hasText: foreign.name }).count()).toBe(0);
    await stale.getByRole("button", { name: "Remove" }).first().click();
    await page.waitForFunction(() => (window.__serverActions?.length ?? 0) > 0);
    const [call] = await calls(page);
    expect(call).toEqual({ name: "savePersonCapacityFactor", args: [JESS, foreign.id, 1.4, null] });
    expect(errors.filter((e) => !/Not available|Failed to load resource/.test(e))).toEqual([]);
    await page.close();
  });

  for (const width of [1440, 400]) {
    it(`a member's own row shows their times read-only, without Remove (${width}px)`, async () => {
      const { page, errors } = await mount({ who: "member", switch: true, factors: [row(JESS, null, 0.9), row(JESS, foreign.id, 1.4), row(larkspurPersonIds.hana!, null, 1.35)] }, width);
      expect(await page.locator("details").count()).toBe(1);
      const jess = await openPerson(page, "Jess Monroe");
      const box = jess.locator("[data-capacity-factors-editor]");
      expect(await field(box, "Every step").inputValue()).toBe("0.9");
      for (const input of await box.locator("input").all()) expect(await input.isDisabled()).toBe(true);
      expect(await box.getByRole("button", { name: "Remove" }).count()).toBe(0);
      expect(await page.locator("#root").innerText()).not.toContain("1.35");
      expect(errors).toEqual([]);
      await page.close();
    });
  }
});
