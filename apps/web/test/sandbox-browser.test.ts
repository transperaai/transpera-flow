import { chromium, type Browser, type Locator, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bundleHarness } from "./build-harness";

// The Sandbox in a real browser, with the simulation in a real Web Worker (./sandbox-harness/entry.tsx), in the demo (scenarios kept
// in the tab): create, rename, duplicate, build on (an inherited change is read-only) and delete (refused with a child); a whole-run
// change and a timed one that is dragged along the months; leave on a Monday; a solution from a month; the horizon presets and the
// custom field (1, 24 and 25, which is refused); comparing three scenarios with "No changes", one of them failing; a Viewer, who
// can open, run and compare but not change anything; a phone, which is read only; and `?plan=` opening a scenario by the id the
// migration kept. At 1440, 640 and 400 px. Every case checks for console errors.

let browser: Browser;
let script: string;
let workers: Record<string, string>;

const META = { "import.meta.url": JSON.stringify("http://harness.test/src/lib/x/") };
// Just enough CSS for the page to lay out: the sr-only tables hidden, as in the app.
const CSS = `body { margin: 0; font: 14px sans-serif } .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0) }`;
const JANUARY = "50000000-0000-4000-8000-000000000005";
const MARCH = "50000000-0000-4000-8000-000000000006";
const THEN_LEADS = "50000000-0000-4000-8000-000000000007";

beforeAll(async () => {
  [script, workers] = await Promise.all([
    bundleHarness(new URL("./sandbox-harness/entry.tsx", import.meta.url), META, { navigation: "navigation-url.ts" }),
    Promise.all(["simulate.worker.ts"].map(async (f) => [f, await bundleHarness(new URL(`../src/workers/${f}`, import.meta.url))] as const)).then(Object.fromEntries),
  ]);
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
}, 120_000);

afterAll(async () => {
  await browser?.close();
});

interface Options {
  mode?: "demo" | "readonly";
  url?: string;
  broken?: boolean;
  many?: boolean;
  dan?: boolean;
  nobody?: boolean;
  leah?: boolean;
  rise?: boolean;
}

async function mount(width: number, o: Options = {}): Promise<{ page: Page; errors: string[] }> {
  const page = await browser.newPage({ viewport: { width, height: 1000 } });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.setContent(`<style>${CSS}</style><div id="root"></div>`);
  await page.evaluate((w) => (window.workerScripts = w), workers);
  await page.addScriptTag({ content: script });
  await page.evaluate((opts) => window.mountSandbox({ mode: "demo", ...opts }), o);
  try {
    await page.waitForSelector("[data-forecast-timeline], [data-sandbox-compare]", { timeout: 90_000 });
  } catch (e) {
    // Say what the page showed and what it complained about, not just that it timed out.
    const el = page.locator("[data-sandbox-compare]");
    throw new Error(`${(e as Error).message}\nErrors: ${errors.join(" | ")}\nStatus: ${await el.getAttribute("data-compare-status")}; progress: ${await page.locator("[data-compare-progress]").innerText()}; url: ${await page.evaluate(() => window.__harnessUrl)}`);
  }
  return { page, errors };
}

/** Waits for the compare view to finish; when it doesn't, says what it showed. */
async function compareDone(page: Page, errors: string[]) {
  try {
    await page.waitForSelector('[data-sandbox-compare][data-compare-status="done"]', { timeout: 90_000 });
  } catch (e) {
    const el = page.locator("[data-sandbox-compare]");
    const status = await el.getAttribute("data-compare-status");
    const progress = await page.locator("[data-compare-progress]").innerText();
    const url = await page.evaluate(() => window.__harnessUrl);
    throw new Error(`${(e as Error).message.split("\n")[0]}\nErrors: ${errors.join(" | ")}\nStatus: ${status}; progress: ${progress}; url: ${url}`);
  }
}

const TIMELINE = "[data-forecast-timeline]";
const runs = async (page: Page) => Number(await page.locator(TIMELINE).getAttribute("data-plan-run"));
/** Waits until the scenario has been run `n` times in all and the run is finished. */
const waitRuns = (page: Page, n: number) =>
  page.waitForFunction(
    (count) => {
      const el = document.querySelector("[data-forecast-timeline]");
      return Number(el?.getAttribute("data-plan-run")) >= count && el?.getAttribute("data-plan-status") === "done";
    },
    n,
    { timeout: 90_000 },
  );
const pick = (page: Page, label: string) => page.locator("[data-scenario-select]").selectOption({ label });
const marker = (page: Page, kind?: string) => page.locator(kind ? `[data-plan-marker][data-kind="${kind}"]` : "[data-plan-marker]").first();
/** What a marker says: a slider's value text; a marker that can't be moved is an image, whose label says it all. */
const valuetext = async (m: Locator) => (await m.getAttribute("aria-valuetext")) ?? (await m.getAttribute("aria-label")) ?? "";
const button = (page: Page, name: string) => page.locator("[data-scenario-bar]").getByRole("button", { name, exact: true });
/** Waits for the status line to say just "Saved" (a rerun after a save says "Updating the forecast…" first). */
const isSaved = (page: Page) => page.waitForFunction(() => document.querySelector("[data-scenario-status-line]")?.textContent === "Saved", undefined, { timeout: 90_000 });
const status = (page: Page) => page.locator("[data-scenario-status-line]").innerText();
const options = (page: Page) => page.locator("[data-scenario-select] option").allInnerTexts();
const changes = (page: Page) => page.locator("[data-change-list] [data-change]");

/** A role's cell for a month, from the chart's table for screen readers: "63% (60% to 70%)" as the average, 63. */
const busyCell = (page: Page, role: string, month: string) =>
  page.evaluate(
    ([r, mo]) => {
      const table = document.querySelector("[data-forecast-timeline] table")!;
      const col = [...table.querySelectorAll("thead th")].findIndex((h) => h.textContent === r);
      const row = [...table.querySelectorAll("tbody tr")].find((tr) => tr.querySelector("th")!.textContent === mo)!;
      return Number(/^(\d+)%/.exec(row.children[col]!.textContent!)![1]);
    },
    [role, month] as const,
  );

async function openAdd(page: Page) {
  await page.locator("[data-change-add]").click();
  await page.waitForSelector("[data-change-dialog]");
}
async function addHire(page: Page, month = "January 2027") {
  await openAdd(page);
  await page.getByLabel("What to change", { exact: true }).selectOption({ label: "Hire" });
  await page.getByLabel("On", { exact: true }).selectOption({ label: "PPC specialist" });
  await page.getByLabel("From a month").check();
  await page.getByLabel("From month", { exact: true }).selectOption({ label: month });
  await page.locator("[data-change-dialog] button[type=submit]").click();
  await page.waitForSelector("[data-plan-marker]");
}
async function newScenario(page: Page) {
  await page.locator("[data-scenario-new]").click();
  await page.waitForSelector("[data-change-list]");
}

/** Drag a marker with the mouse to the middle of month column `toColumn` (0 is the first month). */
async function dragTo(page: Page, m: Locator, toColumn: number, { release = true } = {}) {
  await m.scrollIntoViewIfNeeded();
  const b = (await m.boundingBox())!;
  const cx = b.x + b.width / 2;
  const cy = b.y + b.height / 2;
  const svg = (await page.locator(`${TIMELINE} > svg`).boundingBox())!;
  const compact = svg.width < 520;
  const col = (svg.width - (compact ? 2 : 176) - (compact ? 40 : 48)) / 12;
  const tx = svg.x + (compact ? 2 : 176) + (toColumn + 0.5) * col;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) await page.mouse.move(cx + ((tx - cx) * i) / 12, cy);
  if (release) await page.mouse.up();
}

describe("the Sandbox", { timeout: 180_000 }, () => {
  for (const width of [1440, 640, 400]) {
    describe(`at ${width}px`, () => {
      // A phone (under 640px) is read only (issue #44): it opens, runs and compares, but cannot add, move, save or delete. The
      // cases that change something run from 640px up; the phone's own cases are in "on a phone" below.
      const onTablet = width >= 640 ? it : () => {};

      onTablet("starts a scenario, adds a whole-run change and a timed one, and drags the timed one: dropping it runs again", async () => {
        const { page, errors } = await mount(width);
        expect(await page.locator("[data-plan-lane]").count()).toBe(0);
        await newScenario(page);
        expect(await page.locator("[data-changes-empty='scenario']").innerText()).toContain("No changes yet");
        await waitRuns(page, 1);
        // A whole-run change: opportunities x1.25.
        await openAdd(page);
        // Every greyed lever can't be picked, so its reason is listed under the list. The demo's clients are counted per service, and since
        // sandbox phase 3 "Clients on the book" and "Base churn" act on them, and "Role cost" is offered: nothing is greyed here.
        const levers = page.locator("[data-change-dialog] select[aria-label='What to change'] option");
        const disabled = await page.locator("[data-change-dialog] select[aria-label='What to change'] option:disabled").allInnerTexts();
        const greyed = (await page.locator("[data-greyed-levers]").count()) ? await page.locator("[data-greyed-levers]").innerText() : "";
        for (const label of disabled) expect(greyed).toContain(label.replace(" (does nothing here)", ""));
        const offered = await levers.allInnerTexts();
        for (const label of ["Clients on the book", "Base churn", "Role cost", "Price rise", "Churn driver as a chance", "Client value range", "Conversion rate", "Hours available", "Hiring delay"]) {
          expect(offered.some((o) => o.startsWith(label)), label).toBe(true);
          expect(disabled.some((o) => o.startsWith(label)), `${label} is greyed`).toBe(false);
        }
        await page.getByLabel("What to change", { exact: true }).selectOption({ label: "Opportunities coming in" });
        await page.getByLabel("How", { exact: true }).selectOption({ label: "Multiply by" });
        await page.getByLabel("Value", { exact: true }).fill("1.25");
        await page.locator("[data-change-dialog] button[type=submit]").click();
        await page.waitForSelector("[data-change-list] [data-change]");
        expect(await changes(page).first().innerText()).toContain("Opportunities coming in ×1.25");
        expect(await changes(page).first().innerText()).toContain("the whole run");
        // The whole-run change is not a point on the lane.
        expect(await page.locator("[data-plan-marker]").count()).toBe(0);
        // A timed one: a hire from January.
        await addHire(page);
        await waitRuns(page, 2);
        expect(await changes(page).count()).toBe(2);
        const m = marker(page, "hire");
        expect(await valuetext(m)).toContain("New PPC specialist starts, 1 January 2027");
        expect(await m.getAttribute("aria-label")).toBe("Hire: New PPC specialist");
        const before = await busyCell(page, "PPC specialist", "February 2027");
        await dragTo(page, m, 6);
        expect(await valuetext(m)).toContain("1 April 2027");
        await waitRuns(page, 3);
        expect(await busyCell(page, "PPC specialist", "February 2027")).toBeGreaterThan(before);
        expect(await changes(page).first().innerText()).toContain("Opportunities coming in ×1.25");
        expect(await changes(page).nth(1).innerText()).toContain("from Apr 2027");
        expect(await status(page)).toContain("Unsaved changes");
        expect(errors).toEqual([]);
        await page.close();
      });

      onTablet("adds a price rise from a month: the trade-off shows its tiles, break-even, chart and table", async () => {
        const { page, errors } = await mount(width);
        await newScenario(page);
        await waitRuns(page, 1);
        expect(await page.locator("[data-price-rise]").count()).toBe(0);
        await openAdd(page);
        await page.getByLabel("What to change", { exact: true }).selectOption({ label: "Price rise" });
        expect(await page.locator("[data-price-rise-note]").count()).toBe(1);
        await page.getByLabel("Value", { exact: true }).fill("8");
        await page.getByLabel("From a month").check();
        await page.getByLabel("From month", { exact: true }).selectOption({ label: "March 2027" });
        await page.locator("[data-change-dialog] button[type=submit]").click();
        await page.waitForSelector("[data-change-list] [data-change]");
        expect(await changes(page).first().innerText()).toContain("Price rise of 8%");
        await page.waitForSelector("[data-price-rise] [data-price-rise-tile]", { timeout: 90_000 });
        const section = page.locator("[data-price-rise]");
        expect(await section.locator("[data-price-rise-tile]").evaluateAll((els) => els.map((e) => e.getAttribute("data-price-rise-tile")))).toHaveLength(4);
        expect(await section.locator("[data-price-rise-break-even]").innerText()).toContain("pays for itself");
        expect(await section.locator("[data-price-rise-chart]").count()).toBe(1);
        expect(await section.locator("[data-price-rise-row]").evaluateAll((els) => els.map((e) => e.getAttribute("data-price-rise-row")))).toEqual(["gained", "lost", "net", "leavers"]);
        // Months before the rise are exactly zero in the net row.
        const net = await section.locator('[data-price-rise-row="net"] td').allInnerTexts();
        expect(net.slice(0, 5)).toEqual(["+£0", "+£0", "+£0", "+£0", "+£0"]);
        expect(errors).toEqual([]);
        await page.close();
      });

      onTablet("adds a churn driver chance and a timed role cost: Today names each, and the timed change is one run", async () => {
        const { page, errors } = await mount(width);
        await newScenario(page);
        await waitRuns(page, 1);
        await openAdd(page);
        const lever = (label: string) => page.getByLabel("What to change", { exact: true }).selectOption({ label });
        const today = () => page.locator("[data-change-dialog] [data-today]").innerText();
        await lever("Client value range");
        await page.getByLabel("On", { exact: true }).selectOption({ index: 0 });
        expect(await today()).toMatch(/^Today: £[\d,]+ a month, no range$/);
        await lever("Role cost");
        await page.getByLabel("On", { exact: true }).selectOption({ index: 0 });
        expect(await today()).toMatch(/^Today: £[\d,]+ an hour/);
        await lever("Hours available");
        expect(await today()).toMatch(/^Today: [\d.]+ FTE across \d+ people/);
        await lever("Hiring delay");
        expect(await today()).toBe("Today: none: new hires start on their date");
        // Part months are refused in the dialog, as the database would at Save.
        await page.getByLabel("Value", { exact: true }).fill("2.5");
        await page.locator("[data-change-dialog] button[type=submit]").click();
        expect(await page.locator("[data-change-dialog] [role=alert]").innerText()).toBe("A hiring delay is 0 to 6 whole months.");
        await lever("Churn driver as a chance");
        await page.getByLabel("On", { exact: true }).selectOption({ label: "Late or missed servicing work" });
        expect(await today()).toMatch(/^Today: Late or missed servicing work: counted by its weight \(1\)/);
        await page.getByLabel("Value", { exact: true }).fill("50");
        await page.getByLabel("Chance a month (%)").fill("10");
        await page.locator("[data-change-dialog] button[type=submit]").click();
        await page.waitForSelector("[data-change-list] [data-change]");
        expect(await changes(page).first().innerText()).toContain("raises churn 50%, 10% chance a month");
        await waitRuns(page, 2);
        // A timed role cost is a channel: one more run, however many months.
        const before = await page.evaluate(() => window.__simRuns ?? 0);
        await openAdd(page);
        await lever("Role cost");
        await page.getByLabel("How", { exact: true }).selectOption({ label: "Multiply by" });
        await page.getByLabel("Value", { exact: true }).fill("1.1");
        await page.getByLabel("From a month").check();
        await page.getByLabel("From month", { exact: true }).selectOption({ label: "April 2027" });
        await page.locator("[data-change-dialog] button[type=submit]").click();
        await waitRuns(page, 3);
        expect((await page.evaluate(() => window.__simRuns ?? 0)) - before).toBeLessThanOrEqual(2);
        expect(errors).toEqual([]);
        await page.close();
      });

      onTablet("shows what each lever stands at today before it is changed", async () => {
        const { page, errors } = await mount(width);
        await newScenario(page);
        await openAdd(page);
        const today = () => page.locator("[data-change-dialog] [data-today]").innerText();
        const lever = (label: string) => page.getByLabel("What to change", { exact: true }).selectOption({ label });
        expect(await today()).toBe("Today: about 30 opportunities a month");
        await lever("Fees");
        await page.getByLabel("On", { exact: true }).selectOption({ label: "SEO retainer" });
        expect(await today()).toBe("Today: £3,500 a month");
        await page.getByLabel("On", { exact: true }).selectOption({ label: "PPC management" });
        expect(await today()).toBe("Today: £4,200 a month");
        await lever("Headcount by role");
        await page.getByLabel("On", { exact: true }).selectOption({ label: "PPC specialist" });
        expect(await today()).toBe("Today: 3 people");
        await lever("Rework");
        expect(await today()).toMatch(/^Today: done again [\d.]+% of the time$/);
        // A lever with nothing to say shows no line.
        await lever("Solution goes live");
        expect(await page.locator("[data-change-dialog] [data-today]").count()).toBe(0);
        expect(errors).toEqual([]);
        await page.close();
      });

      onTablet("sets traffic by type as a percentage of all traffic, shows the split, and reads it back as a percentage", async () => {
        const { page, errors } = await mount(width);
        await newScenario(page);
        await openAdd(page);
        await page.getByLabel("What to change", { exact: true }).selectOption({ label: "Traffic by type" });
        expect(await page.locator("[data-change-dialog] [data-today]").innerText()).toBe("Today: SEO retainer 55%, PPC management 45%");
        // Only "Set to" is offered, in percent.
        expect(await page.getByLabel("How", { exact: true }).count()).toBe(0);
        expect(await page.locator("[data-change-dialog]").innerText()).toContain("% of all opportunities");
        await page.getByLabel("On", { exact: true }).selectOption({ label: "SEO retainer" });
        await page.getByLabel("Share (%)", { exact: true }).fill("100");
        await page.locator("[data-change-dialog] button[type=submit]").click();
        expect(await page.locator("[data-change-dialog-error]").innerText()).toContain("0% to 99%");
        await page.getByLabel("Share (%)", { exact: true }).fill("40");
        await page.locator("[data-change-dialog] button[type=submit]").click();
        await page.waitForSelector("[data-change-list] [data-change]");
        expect(await changes(page).first().innerText()).toContain("Traffic by type, SEO retainer → 40%");
        // Stored as the weight that makes it 40% beside the other type's 0.45.
        await waitRuns(page, 1);
        await changes(page).first().getByRole("button", { name: /^Edit/ }).click();
        await page.waitForSelector("[data-change-dialog]");
        expect(await page.getByLabel("Share (%)", { exact: true }).inputValue()).toBe("40");
        await page.keyboard.press("Escape");
        expect(errors).toEqual([]);
        await page.close();
      });

      onTablet("explains a result that looks worse because a role is full, and links to a hire for that role", async () => {
        const { page, errors } = await mount(width);
        await newScenario(page);
        await waitRuns(page, 1);
        // Nothing is full and nothing is worse with no changes: no note.
        expect(await page.locator("[data-full-note]").count()).toBe(0);
        // Twice the opportunities fills the strategist, and fewer deals are won than with no changes.
        await openAdd(page);
        await page.getByLabel("How", { exact: true }).selectOption({ label: "Multiply by" });
        await page.getByLabel("Value", { exact: true }).fill("2");
        await page.locator("[data-change-dialog] button[type=submit]").click();
        await waitRuns(page, 2);
        const note = page.locator("[data-with-this-scenario] [data-full-note]").first();
        await note.waitFor();
        expect(await note.innerText()).toMatch(/^The strategist role is full from \w+ 20\d\d, so new work waits and fewer deals are won \(\d+ against \d+ with no changes\)\./);
        // The link opens a hire for that role, from the month it is full.
        await note.getByRole("button", { name: "Try a hire for this role" }).click();
        await page.waitForSelector("[data-change-dialog]");
        expect(await page.getByLabel("What to change", { exact: true }).inputValue()).toBe("D1");
        expect(await page.getByLabel("On", { exact: true }).evaluate((el: HTMLSelectElement) => el.selectedOptions[0]!.textContent)).toBe("Strategist");
        expect(await page.getByLabel("From a month").isChecked()).toBe(true);
        await page.locator("[data-change-dialog] button[type=submit]").click();
        await page.waitForSelector('[data-plan-marker][data-kind="hire"]');
        expect(await changes(page).last().innerText()).toContain("New Strategist starts");
        expect(errors).toEqual([]);
        await page.close();
      });

      onTablet("moves a change by keyboard: a month a key press, three months a page, Delete removes", async () => {
        const { page, errors } = await mount(width);
        await newScenario(page);
        await addHire(page, "April 2027");
        await waitRuns(page, 1);
        const m = marker(page, "hire");
        await m.focus();
        await page.keyboard.press("ArrowLeft");
        await page.keyboard.press("ArrowLeft");
        expect(await valuetext(m)).toContain("1 February 2027");
        expect(await page.locator("[data-plan-announce]").innerText()).toContain("New PPC specialist starts moved to 1 February 2027. Updating the forecast…");
        await waitRuns(page, 2);
        await page.keyboard.press("PageDown");
        expect(await valuetext(m)).toContain("1 May 2027");
        await page.keyboard.press("Home");
        expect(await valuetext(m)).toContain("1 October 2026");
        await page.keyboard.press("End");
        expect(await valuetext(m)).toContain("1 September 2027");
        expect(await page.evaluate(() => document.activeElement?.getAttribute("data-plan-marker") !== null)).toBe(true);
        const done = await runs(page);
        await page.keyboard.press("Delete");
        expect(await page.locator("[data-plan-marker]").count()).toBe(0);
        expect(await changes(page).count()).toBe(0);
        await waitRuns(page, done + 1);
        expect(errors).toEqual([]);
        await page.close();
      });

      onTablet("treats a short click as a click: it opens the change, Escape closes it, nothing moved; Escape cancels a drag", async () => {
        const { page, errors } = await mount(width);
        await newScenario(page);
        await addHire(page);
        // The empty scenario ran once, and the hire runs it again.
        await waitRuns(page, 2);
        const base = await runs(page);
        const m = marker(page, "hire");
        const before = await valuetext(m);
        await m.click();
        await page.waitForSelector("[data-change-dialog]");
        expect(await page.locator("[data-change-dialog]").innerText()).toContain("Change this change");
        await page.keyboard.press("Escape");
        await page.waitForSelector("[data-change-dialog]", { state: "detached" });
        expect(await valuetext(m)).toBe(before);
        expect(await runs(page)).toBe(base);
        await dragTo(page, m, 8, { release: false });
        expect(await page.locator("[data-plan-ghost]").count()).toBe(1);
        await page.keyboard.press("Escape");
        await page.mouse.up();
        expect(await page.locator("[data-plan-ghost]").count()).toBe(0);
        expect(await valuetext(m)).toBe(before);
        await page.waitForTimeout(600);
        expect(await runs(page)).toBe(base);
        expect(errors).toEqual([]);
        await page.close();
      });

      onTablet("adds leave as a bar on a Monday that moves by whole weeks", async () => {
        const { page, errors } = await mount(width);
        await newScenario(page);
        await openAdd(page);
        await page.getByLabel("What to change", { exact: true }).selectOption({ label: "Leave" });
        await page.getByLabel("On", { exact: true }).selectOption({ label: "Dan Okafor" });
        await page.getByLabel("From", { exact: true }).fill("2027-02-10");
        expect(await page.locator("[data-change-dialog]").innerText()).toContain("Monday 8 February 2027");
        await page.getByLabel("For (weeks)", { exact: true }).fill("3");
        await page.locator("[data-change-dialog] button[type=submit]").click();
        await page.waitForSelector('[data-plan-marker][data-kind="leave"]');
        await waitRuns(page, 1);
        const m = marker(page, "leave");
        expect(await valuetext(m)).toContain("Dan Okafor on leave for 3 weeks, 8 February 2027");
        await dragTo(page, m, 7);
        await waitRuns(page, 2);
        const date = /, (\d+ \w+ \d{4})/.exec(await valuetext(m))![1]!;
        expect(new Date(`${date} UTC`).getUTCDay()).toBe(1);
        expect(new Date(`${date} UTC`).getTime()).toBeGreaterThan(Date.parse("2027-04-01"));
        await m.focus();
        await page.keyboard.press("ArrowRight");
        const next = /, (\d+ \w+ \d{4})/.exec(await valuetext(m))![1]!;
        expect((Date.parse(`${next} UTC`) - Date.parse(`${date} UTC`)) / 86_400_000).toBe(7);
        expect(errors).toEqual([]);
        await page.close();
      });

      onTablet("puts a solution live from a month, and a date that is not a Monday is moved back to one", async () => {
        const { page, errors } = await mount(width);
        await newScenario(page);
        await openAdd(page);
        await page.getByLabel("What to change", { exact: true }).selectOption({ label: "Solution goes live" });
        await page.getByLabel("On", { exact: true }).selectOption({ label: "Faster PPC campaign setup" });
        await page.getByLabel("From a month").check();
        await page.getByLabel("From month", { exact: true }).selectOption({ label: "April 2027" });
        await page.locator("[data-change-dialog] button[type=submit]").click();
        await page.waitForSelector('[data-plan-marker][data-kind="solution"]');
        await waitRuns(page, 1);
        expect(await valuetext(marker(page, "solution"))).toContain("Faster PPC campaign setup goes live, 1 April 2027");
        expect(await page.locator("[data-scenario-problems], [data-needs-attention]").count()).toBe(0);
        expect(await page.locator("[data-with-this-scenario]").innerText()).toContain("With this scenario");
        expect(errors).toEqual([]);
        await page.close();
      });

      it("opens a saved scenario with a solution, and shows its changes", async () => {
        const { page, errors } = await mount(width);
        await pick(page, "Hire in March");
        await waitRuns(page, 1);
        expect(await page.locator('[data-plan-marker][data-kind="solution"]').count()).toBe(1);
        expect(await changes(page).count()).toBe(2);
        expect(await page.locator("[data-with-this-scenario]").innerText()).toContain("With this scenario");
        expect(await page.evaluate(() => window.__harnessUrl)).toContain(`scenario=${MARCH}`);
        expect(errors).toEqual([]);
        await page.close();
      });

      onTablet("renames, saves, duplicates, builds on and deletes scenarios; a parent with a child can't be deleted", async () => {
        const { page, errors } = await mount(width);
        await pick(page, "Hire in January");
        await waitRuns(page, 1);
        // Rename: saved at once, not left as an unsaved change.
        await button(page, "Rename").click();
        await page.getByLabel("Scenario name").fill("Hire early");
        await page.locator("[data-sandbox-name-dialog] button[type=submit]").click();
        await page.waitForSelector("[data-sandbox-name-dialog]", { state: "detached" });
        expect(await status(page)).toBe("Saved");
        expect(await options(page)).toEqual(["No changes", "Hire early", "Hire in March", "Hire in March, then more leads"]);
        expect(await page.locator("[data-scenario-select] option:checked").innerText()).toBe("Hire early");
        expect(await page.locator("[data-scenario-save]").count()).toBe(0);
        // A rename to a name that is taken is refused in the dialog.
        await button(page, "Rename").click();
        await page.getByLabel("Scenario name").fill("hire in march");
        await page.locator("[data-sandbox-name-dialog] button[type=submit]").click();
        expect(await page.locator("[data-sandbox-name-dialog]").innerText()).toContain("A scenario with that name already exists.");
        await page.getByRole("button", { name: "Cancel" }).click();
        // An edit that is not saved yet: switching away asks first.
        await waitRuns(page, 1);
        await marker(page, "hire").focus();
        await page.keyboard.press("ArrowRight");
        expect(await status(page)).toContain("Unsaved changes");
        await pick(page, "No changes");
        expect(await page.getByRole("dialog").innerText()).toContain("Discard your changes to “Hire early”?");
        await page.getByRole("button", { name: "Keep editing" }).click();
        await page.locator("[data-scenario-save]").click();
        await page.waitForFunction(() => document.querySelector("[data-scenario-status-line]")?.textContent?.includes("Saved"));
        expect(await options(page)).toEqual(["No changes", "Hire early", "Hire in March", "Hire in March, then more leads"]);
        // Duplicate: the same changes, a new name.
        await button(page, "Duplicate").click();
        expect(await page.locator("[data-sandbox-name-dialog] input").inputValue()).toBe("Hire early (copy)");
        await page.locator("[data-sandbox-name-dialog] button[type=submit]").click();
        await page.waitForFunction(() => document.querySelector("[data-scenario-select]")?.textContent?.includes("Hire early (copy)"));
        expect(await changes(page).count()).toBe(1);
        expect(await status(page)).toContain("Saved");
        // A name already taken is refused in the dialog.
        await button(page, "Duplicate").click();
        await page.locator("[data-sandbox-name-dialog] input").fill("hire early");
        await page.locator("[data-sandbox-name-dialog] button[type=submit]").click();
        expect(await page.locator("[data-sandbox-name-dialog]").innerText()).toContain("A scenario with that name already exists.");
        await page.getByRole("button", { name: "Cancel" }).click();
        // Build on: a new scenario with the parent's change shown read-only, and none of its own.
        await button(page, "Build on").click();
        await page.locator("[data-sandbox-name-dialog] input").fill("Early, then more");
        await page.locator("[data-sandbox-name-dialog] button[type=submit]").click();
        await page.waitForFunction(() => document.querySelector("[data-scenario-parent]") !== null);
        expect(await page.locator("[data-scenario-parent]").innerText()).toContain("Builds on “Hire early (copy)”");
        const inherited = page.locator("[data-change-list] [data-change][data-inherited]");
        expect(await inherited.count()).toBe(1);
        expect(await inherited.innerText()).toContain("from Hire early (copy)");
        expect(await inherited.locator("button:not([data-slot='help'])").count()).toBe(0);
        expect(await page.locator("[data-plan-marker]").count()).toBe(1);
        // The inherited marker can't be moved.
        const m = marker(page, "hire");
        const at = await valuetext(m);
        await dragTo(page, m, 8);
        await m.focus();
        await page.keyboard.press("ArrowRight");
        expect(await valuetext(m)).toBe(at);
        // Add its own change: it is editable.
        await waitRuns(page, 1);
        await openAdd(page);
        await page.getByLabel("What to change", { exact: true }).selectOption({ label: "Base churn" }).catch(() => undefined);
        await page.keyboard.press("Escape");
        // Deleting the parent is refused, naming the child.
        await pick(page, "Hire early (copy)");
        await button(page, "Delete").click();
        await page.locator("[data-sandbox-confirm] button", { hasText: "Delete" }).click();
        await page.waitForFunction(() => document.querySelector("[data-scenario-status-line]")?.textContent?.includes("Other scenarios build on this one"));
        expect(await status(page)).toContain("“Early, then more”");
        // The refusal says how to free it, and the way is there.
        expect(await status(page)).toContain("choose “Change what it builds on”");
        expect(await options(page)).toContain("Hire early (copy)");
        // Delete the child first, then the parent.
        await pick(page, "Early, then more");
        await button(page, "Delete").click();
        expect(await page.getByRole("dialog").innerText()).toContain("Delete the scenario “Early, then more”? This can't be undone.");
        await page.locator("[data-sandbox-confirm] button", { hasText: "Delete" }).click();
        await page.waitForFunction(() => !document.querySelector("[data-scenario-select]")?.textContent?.includes("Early, then more"));
        await pick(page, "Hire early (copy)");
        await button(page, "Delete").click();
        await page.locator("[data-sandbox-confirm] button", { hasText: "Delete" }).click();
        await page.waitForFunction(() => !document.querySelector("[data-scenario-select]")?.textContent?.includes("Hire early (copy)"));
        expect(await options(page)).toEqual(["No changes", "Hire early", "Hire in March", "Hire in March, then more leads"]);
        expect(errors).toEqual([]);
        await page.close();
      });

      onTablet("changes or clears what a saved scenario builds on, and says why a choice is refused", async () => {
        const { page, errors } = await mount(width);
        const dialog = page.locator("[data-sandbox-parent-dialog]");
        const parentPick = () => dialog.getByLabel("Builds on", { exact: true });
        const submit = () => dialog.locator("button[type=submit]").click();
        // A loop is refused, with the reason, and nothing changes: "Hire in March" can't build on the one that builds on it.
        await pick(page, "Hire in March");
        await button(page, "Change what it builds on").click();
        expect(await parentPick().evaluate((el: HTMLSelectElement) => el.selectedOptions[0]!.textContent)).toBe("Nothing (start from the live model)");
        await parentPick().selectOption({ label: "Hire in March, then more leads" });
        await submit();
        expect(await dialog.locator("[data-parent-dialog-error]").innerText()).toBe("A scenario can't build on itself or on one that builds on it.");
        await page.getByRole("button", { name: "Cancel" }).click();
        expect(await page.locator("[data-scenario-parent]").count()).toBe(0);
        // Another parent for the one that builds on it: saved at once.
        await pick(page, "Hire in March, then more leads");
        await waitRuns(page, 1);
        expect(await page.locator("[data-scenario-parent]").innerText()).toContain("Builds on “Hire in March”");
        expect(await changes(page).count()).toBe(3);
        await button(page, "Change what it builds on").click();
        expect(await parentPick().evaluate((el: HTMLSelectElement) => el.selectedOptions[0]!.textContent)).toBe("Hire in March");
        await parentPick().selectOption({ label: "Hire in January" });
        await submit();
        await page.waitForSelector("[data-sandbox-parent-dialog]", { state: "detached" });
        await isSaved(page);
        expect(await page.locator("[data-scenario-parent]").innerText()).toContain("Builds on “Hire in January”");
        expect(await changes(page).count()).toBe(2);
        // Clear it.
        await button(page, "Change what it builds on").click();
        await parentPick().selectOption({ label: "Nothing (start from the live model)" });
        await submit();
        await page.waitForSelector("[data-sandbox-parent-dialog]", { state: "detached" });
        expect(await page.locator("[data-scenario-parent]").count()).toBe(0);
        expect(await changes(page).count()).toBe(1);
        await isSaved(page);
        // And "Hire in March" is free to be deleted once nothing builds on it.
        await pick(page, "Hire in March");
        await button(page, "Delete").click();
        await page.locator("[data-sandbox-confirm] button", { hasText: "Delete" }).click();
        await page.waitForFunction(() => ![...document.querySelectorAll("[data-scenario-select] option")].some((o) => o.textContent === "Hire in March"));
        expect(await options(page)).toEqual(["No changes", "Hire in January", "Hire in March, then more leads"]);
        expect(errors).toEqual([]);
        await page.close();
      });

      it("labels the first and last columns as part months in the chart's table and tooltip, the money table and compare", async () => {
        const { page, errors } = await mount(width);
        // The run starts on Monday 5 October: the first column covers from then; the last stops where the 12 months do.
        const first = "October 2026 (from 5 Oct)";
        expect(await page.locator("[data-forecast-timeline] table tbody tr th").first().innerText()).toBe(first);
        expect(await page.locator("[data-forecast-timeline] table tbody tr th").nth(1).innerText()).toBe("November 2026");
        expect(await page.locator("[data-forecast-timeline] table tbody tr th").last().innerText()).toMatch(/^\w+ 2027 \(to \d+ \w+\)$/);
        expect(await page.locator("[data-forecast-timeline-section] [data-part-month-note]").innerText()).toMatch(/^\* Part months: the first column covers from 5 Oct, the last column covers to \d+ \w+; the others are whole months\.$/);
        // The tooltip over the first column says so.
        await page.locator(`${TIMELINE} > svg`).scrollIntoViewIfNeeded();
        const svg = (await page.locator(`${TIMELINE} > svg`).boundingBox())!;
        const compact = svg.width < 520;
        await page.mouse.move(svg.x + (compact ? 2 : 176) + 8, svg.y + 40);
        await page.waitForFunction(() => document.querySelector("[data-forecast-timeline] [role=presentation]")?.textContent?.includes("Part month"));
        expect(await page.locator("[data-forecast-timeline] [role=presentation]").innerText()).toContain(first);
        await page.waitForSelector("[data-forecast-money]", { timeout: 90_000 });
        const heads = await page.locator("[data-money-table] thead th").allInnerTexts();
        expect(heads[1]).toBe("Oct 26*");
        expect(heads[2]).toBe("Nov");
        expect(await page.locator("[data-money-table] thead th").nth(1).getAttribute("title")).toBe("Part month: covers from 5 Oct");
        expect(await page.locator("[data-money-table-card] [data-part-month-note]").innerText()).toContain("Part months: the first column covers from 5 Oct");
        // And in compare.
        await pick(page, "Hire in January");
        await page.locator("[data-scenario-compare]").click();
        await compareDone(page, errors);
        expect(await page.locator("[data-sandbox-compare] [data-part-month-note]").first().innerText()).toContain("Part months: the first column covers from 5 Oct");
        const row = page.locator('[data-compare-table="revenue"] tbody tr th').first();
        await page.locator('[data-compare-row="revenue"] summary').click();
        expect(await row.innerText()).toBe(first);
        const chart = page.locator('[data-compare-row="revenue"] [data-compare-chart]');
        await chart.locator("svg").scrollIntoViewIfNeeded();
        const box = (await chart.locator("svg").boundingBox())!;
        await page.mouse.move(box.x + (box.width < 480 ? 50 : 60) + 2, box.y + 60);
        await page.waitForFunction(() => document.querySelector('[data-compare-row="revenue"] [role=presentation]')?.textContent?.includes("Part month"));
        expect(await chart.locator("[role=presentation]").innerText()).toContain(first);
        expect(errors).toEqual([]);
        await page.close();
      });

      it("opens the sample scenario that builds on another with the parent's changes read-only", async () => {
        const { page, errors } = await mount(width);
        await pick(page, "Hire in March, then more leads");
        await waitRuns(page, 1);
        expect(await page.locator("[data-scenario-parent]").innerText()).toContain("Builds on “Hire in March”");
        expect(await page.locator("[data-change-list] [data-change][data-inherited]").count()).toBe(2);
        expect(await changes(page).count()).toBe(3);
        expect(await page.locator("[data-plan-marker]").count()).toBe(3);
        expect(errors).toEqual([]);
        await page.close();
      });

      it("picks the horizon: presets, a custom number from 1 to 24, and refuses 25", async () => {
        const { page, errors } = await mount(width);
        const group = page.getByRole("group", { name: "Time horizon" });
        expect(await group.getByRole("button").allInnerTexts()).toEqual(["3m", "6m", "12m", "24m"]);
        const months = () => page.locator(`${TIMELINE} table tbody tr`).count();
        expect(await months()).toBe(12);
        await group.getByRole("button", { name: "6 months" }).click();
        await page.waitForFunction(() => document.querySelectorAll("[data-forecast-timeline] table tbody tr").length === 6, undefined, { timeout: 90_000 });
        expect(await page.evaluate(() => window.__harnessUrl)).toContain("horizon=6");
        const custom = page.locator("[data-horizon-custom]");
        await custom.fill("1");
        await page.waitForFunction(() => document.querySelectorAll("[data-forecast-timeline] table tbody tr").length <= 2, undefined, { timeout: 90_000 });
        expect(await page.evaluate(() => window.__harnessUrl)).toContain("horizon=1");
        await custom.fill("24");
        await page.waitForFunction(() => document.querySelectorAll("[data-forecast-timeline] table tbody tr").length >= 24, undefined, { timeout: 90_000 });
        expect(await page.evaluate(() => window.__harnessUrl)).toContain("horizon=24");
        // 25 is refused: said in words, and the horizon stays 24.
        await custom.fill("25");
        expect(await page.locator("[data-horizon-refused]").innerText()).toBe("1 to 24");
        expect(await page.evaluate(() => window.__harnessUrl)).toContain("horizon=24");
        expect(await months()).toBeGreaterThanOrEqual(24);
        await custom.fill("0");
        expect(await page.locator("[data-horizon-refused]").count()).toBe(1);
        expect(errors).toEqual([]);
        await page.close();
      });

      it("uses a scenario's own horizon, and the address's when it has one", async () => {
        const { page, errors } = await mount(width, { url: `/demo/sandbox?scenario=${JANUARY}&horizon=6` });
        await waitRuns(page, 1);
        expect(await page.locator(`${TIMELINE} table tbody tr`).count()).toBe(6);
        await page.close();
        const second = await mount(width, { url: `/demo/sandbox?scenario=${JANUARY}` });
        await waitRuns(second.page, 1);
        expect(await second.page.locator(`${TIMELINE} table tbody tr`).count()).toBe(12);
        expect(errors.concat(second.errors)).toEqual([]);
        await second.page.close();
      });

      it("compares three scenarios with No changes, with their numbers and differences", async () => {
        const { page, errors } = await mount(width);
        await page.locator("[data-scenario-compare]").click();
        await page.getByLabel("Scenario 1", { exact: true }).selectOption({ label: "Hire in January" });
        await page.getByLabel("Scenario 2", { exact: true }).selectOption({ label: "Hire in March" });
        await page.getByLabel("Scenario 3", { exact: true }).selectOption({ label: "Hire in March, then more leads" });
        await compareDone(page, errors);
        // Profit over the run first (sandbox phase 2), then recurring revenue, clients at risk, months too busy and late tasks.
        expect(await page.locator("[data-compare-tile]").evaluateAll((els) => els.map((e) => e.getAttribute("data-compare-tile")))).toEqual([
          "Profit over the run",
          expect.stringMatching(/^Recurring revenue in /) as unknown as string,
          expect.stringMatching(/^Clients at risk in /) as unknown as string,
          "Months a role is too busy",
          expect.stringMatching(/^Late tasks in /) as unknown as string,
        ]);
        expect(await page.locator('[data-compare-section="Profit"] [data-compare-chart="Profit"]').count()).toBe(1);
        expect(await page.locator('[data-compare-section="Billed revenue"] [data-compare-chart="Billed revenue"]').count()).toBe(1);
        const tile = await page.locator('[data-compare-tile^="Recurring revenue in"]').innerText();
        for (const name of ["No changes", "Hire in January", "Hire in March", "Hire in March, then more leads"]) expect(tile).toContain(name);
        expect(await page.locator('[data-compare-chart="Monthly recurring revenue"]').count()).toBe(1);
        expect(await page.locator('[data-compare-chart="Monthly recurring revenue"] [data-line]').count()).toBe(4);
        expect(await page.locator('[data-compare-section="Active clients, by type"] [data-compare-chart]').count()).toBeGreaterThan(0);
        expect(await page.locator('[data-compare-section="Clients at risk, by group"] [data-compare-chart]').count()).toBeGreaterThan(0);
        expect(await page.locator('[data-compare-section="How busy each role gets"] [data-compare-chart]').count()).toBeGreaterThan(2);
        const details = page.locator('[data-compare-row="mrr"] details');
        await details.locator("summary").click();
        expect(await details.locator("tbody tr").count()).toBe(12);
        expect(await details.locator("thead").innerText()).toContain("No changes (10–90%)");
        expect(await page.evaluate(() => window.__harnessUrl)).toContain(`compare=${JANUARY},${MARCH},${THEN_LEADS}`);
        await page.getByRole("button", { name: "Back to the scenario" }).click();
        expect(await page.locator(TIMELINE).count()).toBe(1);
        expect(errors).toEqual([]);
        await page.close();
      });

      it("shows a failing column's error and still draws the others", async () => {
        const { page, errors } = await mount(width, { broken: true, url: `/demo/sandbox?compare=${JANUARY}` });
        await page.getByLabel("Scenario 2", { exact: true }).selectOption({ label: "Broken scenario" });
        await page.waitForSelector("[data-column-error]", { timeout: 90_000 });
        expect(await page.locator("[data-column-error]").innerText()).toContain("Broken scenario");
        expect(await page.locator("[data-column-error]").innerText()).toContain("can't be simulated");
        await page.waitForFunction(() => document.querySelectorAll('[data-compare-chart="Monthly recurring revenue"] [data-line]').length === 2, undefined, { timeout: 90_000 });
        expect(await page.locator('[data-compare-tile^="Recurring revenue in"]').innerText()).not.toContain("Broken scenario");
        // And the single view shows the failure, not the previous scenario's numbers.
        await page.getByRole("button", { name: "Back to the scenario" }).click();
        const live = await busyCell(page, "PPC specialist", "February 2027");
        await pick(page, "Hire in January");
        await waitRuns(page, 1);
        expect(await busyCell(page, "PPC specialist", "February 2027")).toBeLessThan(live);
        await pick(page, "Broken scenario");
        await page.waitForFunction(() => document.querySelector("[data-forecast-timeline]")?.getAttribute("data-plan-status") === "error");
        expect(await page.locator("[data-with-this-scenario]").innerText()).toContain("couldn't be worked out");
        expect(await busyCell(page, "PPC specialist", "February 2027")).toBe(live);
        expect(errors).toEqual([]);
        await page.close();
      });

      onTablet("runs a scenario's segments once and reuses the ones a change leaves alone", async () => {
        const { page, errors } = await mount(width, { many: true });
        const simRuns = () => page.evaluate(() => window.__simRuns ?? 0);
        const before = await simRuns();
        await pick(page, "Many runs");
        await waitRuns(page, 1);
        // Four go-live months: five segments, but the first is the live model, which the page has already run.
        expect((await simRuns()) - before).toBe(4);
        const m = page.locator("[data-plan-marker]").last();
        await m.focus();
        await page.keyboard.press("ArrowRight");
        await waitRuns(page, 2);
        expect((await simRuns()) - before).toBe(4);
        expect(errors).toEqual([]);
        await page.close();
      });

      it("shares runs between the columns of the compare view: the same runs are computed once", async () => {
        const { page, errors } = await mount(width);
        await page.waitForFunction(() => (window.__simRuns ?? 0) >= 1, undefined, { timeout: 90_000 });
        await page.waitForTimeout(500);
        const before = await page.evaluate(() => window.__simRuns ?? 0);
        await page.locator("[data-scenario-compare]").click();
        await page.getByLabel("Scenario 1", { exact: true }).selectOption({ label: "Hire in March" });
        await page.getByLabel("Scenario 2", { exact: true }).selectOption({ label: "Hire in March" });
        await compareDone(page, errors);
        await page.waitForTimeout(1000);
        // The two runs of "Hire in March" (the hire; the hire with the solution) once each, although two columns asked for both of them
        // at the same moment; "No changes" is the live run, which the page had already run.
        expect((await page.evaluate(() => window.__simRuns ?? 0)) - before).toBe(2);
        expect(errors).toEqual([]);
        await page.close();
      });

      it("shows Sales and money under the timeline: revenue, labour, overheads and profit, with the profit chart and the table", async () => {
        const { page, errors } = await mount(width);
        await page.waitForSelector("[data-forecast-money]", { timeout: 90_000 });
        const money = page.locator("[data-forecast-money]");
        expect(await money.locator("[data-money-tile]").evaluateAll((els) => els.map((e) => e.getAttribute("data-money-tile")))).toEqual(["revenue", "labour", "overheads", "profit"]);
        expect(await money.locator("[data-money-profit-chart] [data-compare-chart]").count()).toBe(1);
        for (const row of ["opportunities", "won", "conversion", "revenue", "hourly", "labour", "overheads", "profit"]) expect(await money.locator(`[data-money-row="${row}"]`).count(), row).toBe(1);
        // The demo has no overheads set, and says so.
        expect(await money.locator('[data-money-note="no-overheads"]').count()).toBe(1);
        expect(await money.locator("[data-money-hidden-note]").count()).toBe(0);
        // It follows the scenario on screen: the open scenario's run replaces the live one.
        const before = await money.locator('[data-money-row="profit"]').innerText();
        await pick(page, "Hire in January");
        await waitRuns(page, 1);
        await page.waitForFunction((was) => document.querySelector('[data-money-row="profit"]')?.textContent !== was, before, { timeout: 90_000 });
        expect(await page.locator("[data-forecast-money]").count()).toBe(1);
        // And is not there while comparing.
        await page.locator("[data-scenario-compare]").click();
        expect(await page.locator("[data-forecast-money]").count()).toBe(0);
        expect(errors).toEqual([]);
        await page.close();
      });

      it("gives a Viewer who sees only their own row the revenue and sales, and a note instead of costs and profit, on the page and in compare", async () => {
        const { page, errors } = await mount(width, { mode: "readonly", dan: true });
        await page.waitForSelector("[data-forecast-money]", { timeout: 90_000 });
        const money = page.locator("[data-forecast-money]");
        expect(await money.locator("[data-money-tile]").evaluateAll((els) => els.map((e) => e.getAttribute("data-money-tile")))).toEqual(["revenue"]);
        expect(await money.locator("[data-money-hidden-note]").innerText()).toBe("Costs and profit are shown to Agency admins and the Owner.");
        for (const gone of ["labour", "overtimeCost", "overheads", "profit"]) expect(await money.locator(`[data-money-row="${gone}"]`).count(), gone).toBe(0);
        expect(await money.locator("[data-money-profit-chart]").count()).toBe(0);
        expect(await money.locator('[data-money-row="revenue"]').count()).toBe(1);
        expect(await money.locator('[data-money-row="opportunities"]').count()).toBe(1);
        await page.locator("[data-scenario-compare]").click();
        await page.getByLabel("Scenario 1", { exact: true }).selectOption({ label: "Hire in January" });
        await compareDone(page, errors);
        expect(await page.locator("[data-compare-costs-hidden]").innerText()).toBe("Costs and profit are shown to Agency admins and the Owner.");
        expect(await page.locator('[data-compare-section="Profit"]').count()).toBe(0);
        expect(await page.locator('[data-compare-tile="Profit over the run"]').count()).toBe(0);
        expect(await page.locator('[data-compare-section="Billed revenue"]').count()).toBe(1);
        expect(errors).toEqual([]);
        await page.close();
      });

      it("shows a Viewer a price rise's trade-off, and no costs or profit", async () => {
        const { page, errors } = await mount(width, { mode: "readonly", dan: true, rise: true, url: "/demo/sandbox?scenario=50000000-0000-4000-8000-0000000000a2" });
        await page.waitForSelector("[data-price-rise] [data-price-rise-tile]", { timeout: 90_000 });
        const section = page.locator("[data-price-rise]");
        expect(await section.locator("[data-price-rise-tile]").count()).toBe(4);
        expect(await section.locator("[data-price-rise-break-even]").count()).toBe(1);
        const text = (await section.innerText()).toLowerCase();
        for (const word of ["profit", "labour", "overtime", "overheads"]) expect(text, word).not.toContain(word);
        const money = page.locator("[data-forecast-money]");
        expect(await money.locator("[data-money-hidden-note]").count()).toBe(1);
        expect(await money.locator('[data-money-row="profit"]').count()).toBe(0);
        // The saved change still lists, and a Viewer cannot change it.
        expect(await changes(page).first().innerText()).toContain("Price rise of 8%");
        expect(await page.locator("[data-change-add]").count()).toBe(0);
        expect(errors).toEqual([]);
        await page.close();
      });

      it("follows the address when a link changes it: the sidebar's Sandbox link goes back to No changes and a year", async () => {
        const { page, errors } = await mount(width, { url: `/demo/sandbox?scenario=${MARCH}&horizon=6` });
        expect(await page.locator("[data-scenario-select] option:checked").innerText()).toBe("Hire in March");
        expect(await page.locator("[data-forecast-alerts]").innerText()).toContain("Over the next 6 months");
        // Picking in the page writes the address and keeps what is on screen.
        await pick(page, "Hire in January");
        expect(await page.evaluate(() => window.__harnessUrl)).toContain("scenario=50000000-0000-4000-8000-000000000005");
        expect(await page.locator("[data-scenario-select] option:checked").innerText()).toBe("Hire in January");
        // A link to the bare page (the sidebar's Sandbox) shows what that address says, as a reload would.
        await page.evaluate(() => window.__setHarnessUrl("/demo/sandbox"));
        await page.waitForFunction(() => (document.querySelector("[data-scenario-select]") as HTMLSelectElement).selectedOptions[0]?.textContent === "No changes");
        expect(await page.locator("[data-forecast-alerts]").innerText()).toContain("Over the next 12 months");
        // And a link to a comparison opens it.
        await page.evaluate((id) => window.__setHarnessUrl(`/demo/sandbox?compare=${id}`), JANUARY);
        await page.waitForSelector("[data-sandbox-compare]");
        expect(errors).toEqual([]);
        await page.close();
      });

      it("opens a scenario by the id the migration kept, in ?scenario= and in the old ?plan=", async () => {
        const a = await mount(width, { url: `/demo/sandbox?plan=${MARCH}` });
        await waitRuns(a.page, 1);
        expect(await a.page.locator("[data-scenario-select]").inputValue()).toBe(MARCH);
        expect(await a.page.locator('[data-plan-marker][data-kind="solution"]').count()).toBe(1);
        const b = await mount(width, { url: `/demo/sandbox?scenario=${JANUARY}&plan=${MARCH}` });
        await waitRuns(b.page, 1);
        expect(await b.page.locator("[data-scenario-select]").inputValue()).toBe(JANUARY);
        // Unknown or deleted ids are dropped silently.
        const c = await mount(width, { url: "/demo/sandbox?scenario=ffffffff-0000-4000-8000-000000000000&compare=nope" });
        expect(await c.page.locator("[data-scenario-select]").inputValue()).toBe("");
        expect(await c.page.locator("[data-sandbox-compare]").count()).toBe(0);
        expect(a.errors.concat(b.errors, c.errors)).toEqual([]);
        await Promise.all([a.page.close(), b.page.close(), c.page.close()]);
      });

      it("shows a Viewer the saved scenarios to open, run and compare, and no way to change anything", async () => {
        const { page, errors } = await mount(width, { mode: "readonly" });
        expect(await page.locator("[data-scenario-bar]").count()).toBe(1);
        expect(await options(page)).toEqual(["No changes", "Hire in January", "Hire in March", "Hire in March, then more leads"]);
        // Every editing control is an edit entry (the app hides those on a phone) or absent; a Viewer has none at all.
        for (const name of ["New scenario", "Add change", "Save", "Save as new", "Rename", "Duplicate", "Build on", "Delete"]) {
          expect(await page.locator("[data-scenario-bar]").getByRole("button", { name }).count(), name).toBe(0);
        }
        await pick(page, "Hire in March");
        await waitRuns(page, 1);
        expect(await changes(page).count()).toBe(2);
        expect(await page.locator("[data-change-list] button:not([data-slot='help'])").count()).toBe(0);
        expect(await page.locator("[data-viewer-note]").innerText()).toContain("Your numbers can differ slightly");
        // Markers are drawn but can't be moved, opened or removed.
        const m = marker(page, "hire");
        const at = await valuetext(m);
        const done = await runs(page);
        await dragTo(page, m, 8);
        await m.click();
        await m.focus();
        for (const key of ["ArrowRight", "PageDown", "Enter", "Delete"]) await page.keyboard.press(key);
        expect(await page.locator("[data-change-dialog]").count()).toBe(0);
        expect(await valuetext(m)).toBe(at);
        expect(await runs(page)).toBe(done);
        // A new scenario, a horizon, and compare all work from the saved ones.
        await page.getByRole("group", { name: "Time horizon" }).getByRole("button", { name: "6 months" }).click();
        await page.waitForFunction(() => document.querySelectorAll("[data-forecast-timeline] table tbody tr").length === 6, undefined, { timeout: 90_000 });
        await page.waitForFunction(() => !document.querySelector("[data-scenario-status-line]")?.textContent?.includes("Updating"), undefined, { timeout: 90_000 });
        // Nothing for a Viewer to save: another horizon is not an unsaved change.
        expect(await page.locator("[data-scenario-status-line]").innerText()).not.toContain("Unsaved");
        await page.locator("[data-scenario-compare]").click();
        await compareDone(page, errors);
        expect(await page.locator("[data-compare-tile]").count()).toBe(5);
        expect(errors).toEqual([]);
        await page.close();
      });

      it("reads one person the same everywhere for a Viewer: 'Team member N', as the rest of the page names them", async () => {
        const { page, errors } = await mount(width, { mode: "readonly", dan: true, leah: true, url: "/demo/sandbox?scenario=50000000-0000-4000-8000-0000000000a1" });
        await waitRuns(page, 1);
        // Leah Brooks is the fourth person on the team.
        expect(await changes(page).first().innerText()).toContain("Team member 4 on leave for 2 weeks");
        expect(await valuetext(marker(page, "leave"))).toContain("Team member 4 on leave for 2 weeks");
        const body = await page.locator("body").innerText();
        expect(body).not.toContain("A team member");
        expect(body).not.toContain("Leah Brooks");
        expect(errors).toEqual([]);
        await page.close();
      });

      it("hides the costs from a Viewer's compare, and the title says so: 'Wins', not 'Wins and costs'", async () => {
        const viewer = await mount(width, { mode: "readonly", dan: true, url: `/demo/sandbox?compare=${JANUARY}` });
        await compareDone(viewer.page, viewer.errors);
        expect(await viewer.page.locator('[data-compare-section="Wins"]').count()).toBe(1);
        expect(await viewer.page.locator('[data-compare-section="Wins and costs"]').count()).toBe(0);
        expect((await viewer.page.locator('[data-compare-section="Wins"] h2').innerText()).split("\n")[0]).toBe("Wins");
        const admin = await mount(width, { url: `/demo/sandbox?compare=${JANUARY}` });
        await compareDone(admin.page, admin.errors);
        expect((await admin.page.locator('[data-compare-section="Wins and costs"] h2').innerText()).split("\n")[0]).toBe("Wins and costs");
        expect(viewer.errors.concat(admin.errors)).toEqual([]);
        await Promise.all([viewer.page.close(), admin.page.close()]);
      });

      it("tells a Viewer with no row of their own why 'By person' is empty", async () => {
        const viewer = await mount(width, { mode: "readonly", nobody: true });
        await viewer.page.getByRole("button", { name: "By person", exact: true }).click();
        expect(await viewer.page.locator("[data-people-empty]").innerText()).toContain("By person shows only your own row, and there is none to show");
        await viewer.page.getByRole("button", { name: "By role", exact: true }).click();
        expect(await viewer.page.locator("[data-people-empty]").count()).toBe(0);
        // Someone who sees everyone has rows, and no note.
        const admin = await mount(width);
        await admin.page.getByRole("button", { name: "By person", exact: true }).click();
        expect(await admin.page.locator("[data-people-empty]").count()).toBe(0);
        expect(await admin.page.locator("[data-row]").count()).toBeGreaterThan(0);
        expect(viewer.errors.concat(admin.errors)).toEqual([]);
        await Promise.all([viewer.page.close(), admin.page.close()]);
      });

      it("draws a Viewer's markers as plain images: no grab cursor, not announced as sliders; an editor's are sliders", async () => {
        const viewer = await mount(width, { mode: "readonly", url: `/demo/sandbox?scenario=${MARCH}` });
        await waitRuns(viewer.page, 1);
        const markers = viewer.page.locator("[data-plan-marker]");
        expect(await markers.count()).toBeGreaterThan(0);
        for (const m of await markers.all()) {
          expect(await m.getAttribute("role")).toBe("img");
          for (const attr of ["aria-valuenow", "aria-valuemin", "aria-valuemax", "aria-valuetext", "tabindex"]) expect(await m.getAttribute(attr), attr).toBeNull();
          expect(await m.evaluate((el) => getComputedStyle(el).cursor)).toBe("default");
          expect(await m.getAttribute("aria-label")).toMatch(/^(Hire|Solution|Change|Leave): .+, \d+ \w+ 20\d\d/);
        }
        const editor = await mount(width, { url: `/demo/sandbox?scenario=${MARCH}` });
        await waitRuns(editor.page, 1);
        for (const m of await editor.page.locator("[data-plan-marker]").all()) {
          // The scenario's own markers can be moved (a phone is read only, and a parent's can't be moved; none here).
          expect(await m.getAttribute("role")).toBe(width < 640 ? "img" : "slider");
          expect(await m.evaluate((el) => getComputedStyle(el).cursor)).toBe(width < 640 ? "default" : "grab");
        }
        expect(viewer.errors.concat(editor.errors)).toEqual([]);
        await Promise.all([viewer.page.close(), editor.page.close()]);
      });

      it("shows a Viewer who sees only their own row other people as 'A team member'", async () => {
        const { page, errors } = await mount(width, { mode: "readonly", dan: true, url: "/demo/sandbox?scenario=" + JANUARY });
        await waitRuns(page, 1);
        const text = await page.locator("[data-sandbox-scenario]").innerText();
        expect(text).not.toContain("Leah Brooks");
        expect(errors).toEqual([]);
        await page.close();
      });
    });
  }

  describe("on a phone (400px, issue #44)", () => {
    it("draws a saved scenario's markers but can't move, open or remove them", async () => {
      const { page, errors } = await mount(400);
      await pick(page, "Hire in January");
      await waitRuns(page, 1);
      const m = marker(page, "hire");
      const at = await valuetext(m);
      expect(at).toContain("1 January 2027");
      const done = await runs(page);
      await dragTo(page, m, 6);
      expect(await valuetext(m)).toBe(at);
      await m.click();
      expect(await page.locator("[data-change-dialog]").count()).toBe(0);
      await m.focus();
      for (const key of ["ArrowRight", "PageDown", "Enter", "Delete"]) await page.keyboard.press(key);
      expect(await page.locator("[data-change-dialog]").count()).toBe(0);
      expect(await page.locator("[data-plan-marker]").count()).toBeGreaterThan(0);
      expect(await valuetext(m)).toBe(at);
      expect(await runs(page)).toBe(done);
      expect(errors).toEqual([]);
      await page.close();
    });

    it("still lets a phone read the scenarios: pick one and compare", async () => {
      const { page, errors } = await mount(400);
      await pick(page, "Hire in March");
      await waitRuns(page, 1);
      expect(await page.locator("[data-with-this-scenario]").innerText()).toContain("With this scenario");
      expect(await page.locator("[data-scenario-compare]").count()).toBe(1);
      // New, Add, Save, Rename, Duplicate, Build on and Delete are edit entries, which the app's stylesheet hides on a phone (this
      // harness loads none, so the check is that each one sits in a [data-edit-entry]); the picker and Compare are not.
      const loose = await page.evaluate(() =>
        [...document.querySelectorAll("[data-scenario-bar] button, [data-change-list] button")]
          .filter((b) => /^(New|Add|Save|Rename|Duplicate|Build|Delete|Edit|Remove)/.test((b.textContent ?? "").trim()) && !b.closest("[data-edit-entry]"))
          .map((b) => (b.textContent ?? "").trim()),
      );
      expect(loose).toEqual([]);
      expect(await page.locator("[data-scenario-bar] [data-edit-entry] button", { hasText: "Rename" }).count()).toBe(1);
      expect(await page.locator("[data-edit-entry] [data-scenario-select], [data-edit-entry] [data-scenario-compare]").count()).toBe(0);
      expect(errors).toEqual([]);
      await page.close();
    });
  });
});
