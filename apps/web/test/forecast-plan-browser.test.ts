import { chromium, type Browser, type Locator, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bundleHarness } from "./build-harness";

// Forecast planning in a real browser (issue #36, B7), with the simulation in a real Web Worker (./forecast-harness/entry.tsx):
// add a hire and drag it along the months, move markers by keyboard, a click that isn't a drag, Escape cancelling a drag, leave,
// a sample plan with a solution, comparing two plans, saving in the demo, and the member view. At 1440, 640 and 400 px (a phone, which is read only). Every
// case checks for console errors.

let browser: Browser;
let script: string;
let workers: Record<string, string>;

const META = { "import.meta.url": JSON.stringify("http://harness.test/src/lib/x/") };
// Just enough CSS for the page to lay out: the sr-only tables hidden, as in the app.
const CSS = `body { margin: 0; font: 14px sans-serif } .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0) }`;
const JANUARY_PLAN = "00000000-0000-4000-8000-0000000f0301";
const MARCH_PLAN = "00000000-0000-4000-8000-0000000f0302";

beforeAll(async () => {
  [script, workers] = await Promise.all([
    bundleHarness(new URL("./forecast-harness/entry.tsx", import.meta.url), META, { navigation: "navigation-url.ts" }),
    Promise.all(["simulate.worker.ts"].map(async (f) => [f, await bundleHarness(new URL(`../src/workers/${f}`, import.meta.url))] as const)).then(Object.fromEntries),
  ]);
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
}, 120_000);

afterAll(async () => {
  await browser?.close();
});

async function mount(width: number, mode: "demo" | "readonly" = "demo", url?: string, broken = false, many = false): Promise<{ page: Page; errors: string[] }> {
  const page = await browser.newPage({ viewport: { width, height: 1000 } });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.setContent(`<style>${CSS}</style><div id="root"></div>`);
  await page.evaluate((w) => (window.workerScripts = w), workers);
  await page.addScriptTag({ content: script });
  await page.evaluate((o) => window.mountForecast(o), { mode, url, broken, many });
  try {
    await page.waitForSelector("[data-forecast-timeline], [data-forecast-compare]", { timeout: 90_000 });
  } catch (e) {
    // Say what the page showed and what it complained about, not just that it timed out.
    throw new Error(`${(e as Error).message}\nErrors: ${errors.join(" | ")}\nPage: ${(await page.locator("#root").innerText()).slice(0, 600)}`);
  }
  return { page, errors };
}

const TIMELINE = "[data-forecast-timeline]";
const runs = async (page: Page) => Number(await page.locator(TIMELINE).getAttribute("data-plan-run"));
/** Waits until the plan has been run `n` times in all and the run is finished. */
const waitRuns = (page: Page, n: number) =>
  page.waitForFunction(
    (count) => {
      const el = document.querySelector("[data-forecast-timeline]");
      return Number(el?.getAttribute("data-plan-run")) >= count && el?.getAttribute("data-plan-status") === "done";
    },
    n,
    { timeout: 90_000 },
  );
const marker = (page: Page, kind?: string) => page.locator(kind ? `[data-plan-marker][data-kind="${kind}"]` : "[data-plan-marker]").first();
const valuetext = async (m: Locator) => (await m.getAttribute("aria-valuetext")) ?? "";

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

async function addFromMenu(page: Page, item: string) {
  await page.locator("[data-plan-add]").click();
  await page.getByRole("menuitem", { name: item }).click();
  await page.waitForSelector("[data-plan-dialog]");
}
async function addHire(page: Page, month = "January 2027") {
  await addFromMenu(page, "Add a hire");
  await page.getByLabel("Role", { exact: true }).selectOption({ label: "PPC specialist" });
  await page.getByLabel("Starts in", { exact: true }).selectOption({ label: month });
  await page.locator("[data-plan-dialog] button[type=submit]").click();
  await page.waitForSelector("[data-plan-marker]");
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

describe("planning on the Forecast", { timeout: 180_000 }, () => {
  for (const width of [1440, 640, 400]) {
    describe(`at ${width}px`, () => {
      // A phone (under 640px) is read only (issue #44): its plan lane draws the markers but can't move, open or remove them, so the
      // cases that add, move and save run from 640px up. The phone's own cases are in "on a phone" below.
      const onTablet = width >= 640 ? it : () => {};
      onTablet("adds a hire and drags it along the months: dropping it runs the forecast again", async () => {
        const { page, errors } = await mount(width);
        expect(await page.locator("[data-plan-lane]").count()).toBe(1);
        expect(await runs(page)).toBe(0);
        await addHire(page);
        await waitRuns(page, 1);
        const m = marker(page, "hire");
        expect(await valuetext(m)).toContain("New PPC specialist starts, 1 January 2027");
        expect(await m.getAttribute("aria-label")).toBe("Hire: New PPC specialist");
        const before = await busyCell(page, "PPC specialist", "February 2027");

        await dragTo(page, m, 6);
        expect(await valuetext(m)).toContain("1 April 2027");
        await waitRuns(page, 2);
        const after = await busyCell(page, "PPC specialist", "February 2027");
        expect(after).toBeGreaterThan(before);
        expect(await page.locator("[data-plan-status-line]").innerText()).toContain("Unsaved changes");
        expect(errors).toEqual([]);
        await page.close();
      });

      onTablet("moves by keyboard: a month a key press, three months a page, Delete removes", async () => {
        const { page, errors } = await mount(width);
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
        // Focus stayed on the marker throughout.
        expect(await page.evaluate(() => document.activeElement?.getAttribute("data-plan-marker") !== null)).toBe(true);
        await waitRuns(page, 3);
        const done = await runs(page);
        await page.keyboard.press("Delete");
        expect(await page.locator("[data-plan-marker]").count()).toBe(0);
        await waitRuns(page, done + 1);
        expect(errors).toEqual([]);
        await page.close();
      });

      onTablet("treats a short click as a click, not a drag: it opens the marker, Escape closes it, nothing moved", async () => {
        const { page, errors } = await mount(width);
        await addHire(page);
        await waitRuns(page, 1);
        const m = marker(page, "hire");
        const before = await valuetext(m);
        await m.click();
        await page.waitForSelector('[data-plan-dialog="hire"]');
        expect(await page.locator("[data-plan-dialog]").innerText()).toContain("Change this hire");
        await page.keyboard.press("Escape");
        await page.waitForSelector("[data-plan-dialog]", { state: "detached" });
        expect(await valuetext(m)).toBe(before);
        expect(await runs(page)).toBe(1);
        expect(errors).toEqual([]);
        await page.close();
      });

      onTablet("cancels a drag with Escape: the marker stays and nothing runs", async () => {
        const { page, errors } = await mount(width);
        await addHire(page);
        await waitRuns(page, 1);
        const m = marker(page, "hire");
        const before = await valuetext(m);
        await dragTo(page, m, 8, { release: false });
        expect(await page.locator("[data-plan-ghost]").count()).toBe(1);
        await page.keyboard.press("Escape");
        await page.mouse.up();
        expect(await page.locator("[data-plan-ghost]").count()).toBe(0);
        expect(await valuetext(m)).toBe(before);
        await page.waitForTimeout(600);
        expect(await runs(page)).toBe(1);
        expect(await page.locator(TIMELINE).getAttribute("data-plan-status")).toBe("done");
        expect(errors).toEqual([]);
        await page.close();
      });

      onTablet("ignores a release over another month after Escape: nothing moves and no dialog opens", async () => {
        const { page, errors } = await mount(width);
        await addHire(page);
        await waitRuns(page, 1);
        const m = marker(page, "hire");
        const before = await valuetext(m);
        await dragTo(page, m, 8, { release: false });
        await page.keyboard.press("Escape");
        // Back over a different month than the marker's own, then let go.
        const svg = (await page.locator(`${TIMELINE} > svg`).boundingBox())!;
        await page.mouse.move(svg.x + svg.width * 0.7, (await m.boundingBox())!.y + 10);
        await page.mouse.up();
        expect(await page.locator("[data-plan-dialog]").count()).toBe(0);
        expect(await valuetext(m)).toBe(before);
        await page.waitForTimeout(600);
        expect(await runs(page)).toBe(1);
        expect(errors).toEqual([]);
        await page.close();
      });

      onTablet("adds leave as a bar that moves by whole weeks, always to a Monday", async () => {
        const { page, errors } = await mount(width);
        await addFromMenu(page, "Add leave");
        await page.getByLabel("Person", { exact: true }).selectOption({ label: "Dan Okafor" });
        await page.getByLabel("From", { exact: true }).fill("2027-02-10");
        expect(await page.locator("[data-plan-dialog]").innerText()).toContain("Monday 8 February 2027");
        await page.getByLabel("For (weeks)", { exact: true }).fill("3");
        await page.locator("[data-plan-dialog] button[type=submit]").click();
        await page.waitForSelector('[data-plan-marker][data-kind="leave"]');
        await waitRuns(page, 1);
        const m = marker(page, "leave");
        expect(await valuetext(m)).toContain("Dan Okafor on leave, 8 February 2027");
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

      it("opens the sample plan with a solution, then compares two plans with their numbers", async () => {
        const { page, errors } = await mount(width);
        await page.locator("[data-plan-select]").selectOption({ label: "Hire in March" });
        await waitRuns(page, 1);
        expect(await page.locator("[data-plan-problems]").count()).toBe(0);
        expect(await page.locator('[data-plan-marker][data-kind="solution"]').count()).toBe(1);
        expect(await page.locator("[data-with-this-plan]").innerText()).toContain("With this plan");

        await page.locator("[data-plan-compare]").click();
        await page.getByLabel("Plan A", { exact: true }).selectOption({ label: "Hire in January" });
        await page.getByLabel("Plan B", { exact: true }).selectOption({ label: "Hire in March" });
        await page.waitForSelector('[data-forecast-compare][data-compare-status="done"]', { timeout: 90_000 });
        expect(await page.locator("[data-compare-tile]").count()).toBe(3);
        expect(await page.locator('[data-compare-chart="Monthly recurring revenue"]').count()).toBe(1);
        expect(await page.locator('[data-compare-section="Clients at risk, by group"] [data-compare-chart]').count()).toBeGreaterThan(0);
        expect(await page.locator('[data-compare-section="How busy each role gets"] [data-compare-chart]').count()).toBeGreaterThan(2);
        const details = page.locator('[data-compare-row="mrr"] details');
        await details.locator("summary").click();
        expect(await details.locator("tbody tr").count()).toBe(12);
        const header = await details.locator("thead").innerText();
        expect(header).toContain("Plan A (10–90%)");
        expect(header).toContain("Difference (B − A)");
        expect(await page.evaluate(() => window.__harnessUrl)).toContain(`compare=${JANUARY_PLAN},${MARCH_PLAN}`);
        // The same plan on both sides is said, not drawn.
        await page.getByLabel("Plan B", { exact: true }).selectOption({ label: "Hire in January" });
        expect(await page.locator("[data-compare-progress]").innerText()).toContain("Pick two different plans.");
        await page.getByRole("button", { name: "Back to the plan" }).click();
        expect(await page.locator(TIMELINE).count()).toBe(1);
        expect(errors).toEqual([]);
        await page.close();
      });

      onTablet("saves, renames and deletes plans in the demo", async () => {
        const { page, errors } = await mount(width);
        const options = () => page.locator("[data-plan-select] option").allInnerTexts();
        await page.locator("[data-plan-select]").selectOption({ label: "Hire in January" });
        await waitRuns(page, 1);
        await page.getByRole("button", { name: "Rename", exact: true }).click();
        await page.getByLabel("Plan name").fill("Hire early");
        await page.locator("[data-plan-name-dialog] button[type=submit]").click();
        expect(await page.locator("[data-plan-status-line]").innerText()).toContain("Unsaved changes");
        // Switching away asks first.
        await page.locator("[data-plan-select]").selectOption({ label: "No changes" });
        expect(await page.getByRole("dialog").innerText()).toContain("Discard your changes to “Hire early”?");
        await page.getByRole("button", { name: "Keep editing" }).click();
        await page.locator("[data-plan-save]").click();
        await page.waitForFunction(() => document.querySelector("[data-plan-status-line]")?.textContent?.includes("Saved"));
        expect(await options()).toEqual(["No changes", "Hire early", "Hire in March"]);
        await page.getByRole("button", { name: "Delete", exact: true }).click();
        expect(await page.getByRole("dialog").innerText()).toContain("Delete the plan “Hire early”? This can't be undone.");
        await page.locator("[data-plan-confirm] button", { hasText: "Delete" }).click();
        await page.waitForFunction(() => !document.querySelector("[data-plan-select]")?.textContent?.includes("Hire early"));
        expect(await options()).toEqual(["No changes", "Hire in March"]);
        expect(errors).toEqual([]);
        await page.close();
      });

      onTablet("runs a plan's segments once and reuses the ones a change leaves alone", async () => {
        const { page, errors } = await mount(width, "demo", undefined, false, true);
        const simRuns = () => page.evaluate(() => window.__simRuns ?? 0);
        const before = await simRuns();
        await page.locator("[data-plan-select]").selectOption({ label: "Many runs" });
        await waitRuns(page, 1);
        // Four go-live months: five segments, but the first is the live model, which the page has already run.
        expect((await simRuns()) - before).toBe(4);
        const m = page.locator("[data-plan-marker]").last();
        await m.focus();
        await page.keyboard.press("ArrowRight");
        await waitRuns(page, 2);
        // The last solution moved a month: every segment's model is the same as before, so nothing runs again.
        expect((await simRuns()) - before).toBe(4);
        // Moving the first one changes what the later segments have live: only those whose models changed run.
        await page.locator("[data-plan-marker]").first().focus();
        await page.keyboard.press("ArrowRight");
        await waitRuns(page, 3);
        expect((await simRuns()) - before).toBeLessThan(8);
        expect(errors).toEqual([]);
        await page.close();
      });

      it("shares runs between the plans of the compare view: the same two runs are computed once, not twice", async () => {
        const url = `/demo/forecast?compare=${MARCH_PLAN},${MARCH_PLAN}`;
        const { page, errors } = await mount(width, "demo", url);
        await page.waitForSelector("[data-compare-progress]");
        await page.waitForFunction(() => (window.__simRuns ?? 0) >= 3, undefined, { timeout: 90_000 });
        await page.waitForTimeout(1000);
        // The live forecast's run, and the two runs of "Hire in March" (the hire; the hire with the solution): once each,
        // although plan A and plan B both asked for both of them at the same moment.
        expect(await page.evaluate(() => window.__simRuns)).toBe(3);
        expect(errors).toEqual([]);
        await page.close();
      });

      it("shows the failure, not the previous plan's numbers, when a plan can't be run", async () => {
        const { page, errors } = await mount(width, "demo", undefined, true);
        const select = page.locator("[data-plan-select]");
        const live = await busyCell(page, "PPC specialist", "February 2027");
        await select.selectOption({ label: "Hire in January" });
        await waitRuns(page, 1);
        expect(await busyCell(page, "PPC specialist", "February 2027")).toBeLessThan(live);
        await select.selectOption({ label: "Broken plan" });
        await page.waitForFunction(() => document.querySelector("[data-forecast-timeline]")?.getAttribute("data-plan-status") === "error");
        expect(await page.locator("[data-with-this-plan]").innerText()).toContain("couldn't be worked out");
        // The chart is the live forecast's again: nothing of the January plan is left on it.
        expect(await busyCell(page, "PPC specialist", "February 2027")).toBe(live);
        expect(errors).toEqual([]);
        await page.close();
      });

      it("shows a member no plan bar, no lane and no compare, even with ?plan= in the address", async () => {
        const { page, errors } = await mount(width, "readonly", `/demo/forecast?plan=${JANUARY_PLAN}&compare=live,${MARCH_PLAN}`);
        expect(await page.locator("[data-plan-bar]").count()).toBe(0);
        expect(await page.locator("[data-plan-lane]").count()).toBe(0);
        expect(await page.locator("[data-plan-marker]").count()).toBe(0);
        expect(await page.locator("[data-forecast-compare]").count()).toBe(0);
        expect(await page.getByText("Compare plans").count()).toBe(0);
        expect(await page.locator("[data-forecast-timeline]").count()).toBe(1);
        expect(errors).toEqual([]);
        await page.close();
      });
    });
  }

  describe("on a phone (400px, issue #44)", () => {
    it("draws a saved plan's markers but can't move, open or remove them", async () => {
      const { page, errors } = await mount(400);
      await page.locator("[data-plan-select]").selectOption({ label: "Hire in January" });
      await waitRuns(page, 1);
      const m = marker(page, "hire");
      const at = await valuetext(m);
      expect(at).toContain("1 January 2027");
      const done = await runs(page);
      // Dragging does nothing.
      await dragTo(page, m, 6);
      expect(await valuetext(m)).toBe(at);
      // A click doesn't open the marker's dialog.
      await m.click();
      expect(await page.locator("[data-plan-dialog]").count()).toBe(0);
      // Neither do the keys: no move, no edit, no removal.
      await m.focus();
      for (const key of ["ArrowRight", "PageDown", "Enter", "Delete"]) await page.keyboard.press(key);
      expect(await page.locator("[data-plan-dialog]").count()).toBe(0);
      expect(await page.locator("[data-plan-marker]").count()).toBeGreaterThan(0);
      expect(await valuetext(m)).toBe(at);
      expect(await runs(page)).toBe(done);
      expect(errors).toEqual([]);
      await page.close();
    });

    it("still lets a phone read the plans: pick one and compare", async () => {
      const { page, errors } = await mount(400);
      await page.locator("[data-plan-select]").selectOption({ label: "Hire in March" });
      await waitRuns(page, 1);
      expect(await page.locator("[data-with-this-plan]").innerText()).toContain("With this plan");
      expect(await page.locator("[data-plan-compare]").count()).toBe(1);
      // Add, Save, Rename and Delete are edit entries, which the app's stylesheet hides on a phone (this harness loads none, so
      // the check is that each one sits in a [data-edit-entry]); the plan picker and Compare are not.
      const loose = await page.evaluate(() =>
        [...document.querySelectorAll("[data-plan-bar] button")]
          .filter((b) => /^(Add|Save|Rename|Delete)/.test((b.textContent ?? "").trim()) && !b.closest("[data-edit-entry]"))
          .map((b) => (b.textContent ?? "").trim()),
      );
      expect(loose).toEqual([]);
      expect(await page.locator("[data-plan-bar] [data-edit-entry] button", { hasText: "Rename" }).count()).toBe(1);
      expect(await page.locator("[data-edit-entry] [data-plan-select], [data-edit-entry] [data-plan-compare]").count()).toBe(0);
      expect(errors).toEqual([]);
      await page.close();
    });
  });
});
