import { mkdirSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LEVER_KIND_IDS } from "@transpera-flow/db";
import { bundleHarness } from "./build-harness";

// A play link's page (issue #33, B4) in a real browser: the real SharedView for a Northbeam process in `play` mode, People off and
// Financials off, with the workspace hiding "Work done twice". The visitor moves levers in their browser; nothing is stored; the Send
// dialog calls the harness's stub (the Server Action's stand-in) once with the moved patch. A view link of the same snapshot offers none of it.

let browser: Browser;
let script: string;
let workers: Record<string, string>;

const META = { "import.meta.url": JSON.stringify("http://harness.test/src/lib/x/") };
const SHOTS = process.env.SHARE_SHOTS_DIR;
const LEADS = '[data-lever="demand.leads_per_week"]';

beforeAll(async () => {
  [script, workers] = await Promise.all([
    bundleHarness(new URL("./share-harness/entry.tsx", import.meta.url), META),
    Promise.all(
      ["simulate.worker.ts", "impact.worker.ts", "absence.worker.ts", "issue-costs.worker.ts", "shadow-price.worker.ts", "verdict.worker.ts", "stress.worker.ts", "projection.worker.ts"].map(
        async (f) => [f, await bundleHarness(new URL(`../src/workers/${f}`, import.meta.url))] as const,
      ),
    ).then(Object.fromEntries),
  ]);
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  if (SHOTS) mkdirSync(SHOTS, { recursive: true });
}, 180_000);

afterAll(async () => {
  await browser?.close();
});

interface Options {
  mode?: "view" | "play";
  hidden?: string[];
  visitorEmail?: string | null;
  people?: boolean;
  financials?: boolean;
}

async function mount(options: Options = {}, size = { width: 1440, height: 1800 }, scheme: "light" | "dark" = "light") {
  const page = await browser.newPage({ viewport: size, colorScheme: scheme });
  const errors: string[] = [];
  const requests: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("request", (r) => requests.push(r.url()));
  await page.route("https://share.test/", (route) => route.fulfill({ contentType: "text/html", body: `<!doctype html><div id="root"></div>` }));
  await page.goto("https://share.test/");
  await page.evaluate((w) => (window.workerScripts = w), workers);
  await page.addScriptTag({ content: script });
  const { people = false, financials = false, ...rest } = options;
  await page.evaluate(([t, o]) => window.mountShare("process", t as { people: boolean; financials: boolean }, o as Options), [{ people, financials }, { mode: "play", ...rest }] as const);
  await page.waitForSelector("[data-share-bar]");
  return { page, errors, requests };
}

/** Wait for the levers to be drawn (the page's own run has landed). */
async function ready(page: Page) {
  await page.waitForSelector(LEADS, { timeout: 90_000, state: "attached" });
  await page.waitForTimeout(1500);
}

/** Move a slider the way a person does: its value changes and the input event fires. */
async function move(page: Page, path: string, value: number) {
  await page.evaluate(
    ([p, v]) => {
      const el = document.querySelector(`[data-lever="${p}"]`) as HTMLInputElement;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, String(v));
      el.dispatchEvent(new Event("input", { bubbles: true }));
    },
    [path, value] as const,
  );
}

const value = (page: Page, path: string) => page.evaluate((p) => (document.querySelector(`[data-lever="${p}"]`) as HTMLInputElement).value, path);

describe("a play link's page, People off and Financials off", () => {
  it("renders without console errors and makes no network request while levers move; shows the section and the bar; offers the shown levers only", async () => {
    const { page, errors, requests } = await mount({ hidden: ["process.rework"] });
    await ready(page);
    const text = await page.locator("body").innerText();
    expect(text).toContain("Try your own changes");
    expect(text).toContain("Shared view · try changes");
    expect(text).toContain("You can try changes here. Nothing is saved unless you send it to the team.");
    expect(text).not.toContain("Shared view · read only");
    // The workspace hides "Work done twice": no rework slider. Hands-on time is offered. No per-person slider (People off).
    expect(await page.locator('[data-lever$=".rework_rate"]').count()).toBe(0);
    expect(await page.locator('[data-lever$=".work_hours"]').count()).toBeGreaterThan(0);
    expect(await page.locator('[data-lever^="people."]').count()).toBe(0);
    // The saved-scenario library is hidden in play mode.
    expect(text).not.toMatch(/Save as scenario|Saved scenarios/i);
    await move(page, "demand.leads_per_week", 12);
    await move(page, "steps.00000000-0000-4000-8000-0000000000e1.work_hours", 0.8).catch(() => undefined);
    await page.waitForTimeout(1500);
    expect(requests.filter((u) => !/^(blob:|data:|about:)/.test(u))).toEqual(["https://share.test/"]);
    expect(errors).toEqual([]);
    await page.close();
  }, 240_000);

  it("moving a lever updates the comparison headline; Send is disabled before and enabled after", async () => {
    const { page } = await mount();
    await ready(page);
    expect(await page.locator("[data-play-send]").isDisabled()).toBe(true);
    expect(await page.locator("[data-play-send]").getAttribute("title")).toBe("Move at least one lever first.");
    expect(await page.locator('[data-testid="compare-headline"]').count()).toBe(0);
    await move(page, "demand.leads_per_week", 20);
    await page.waitForSelector('[data-testid="compare-headline"]', { timeout: 60_000 });
    expect(await page.locator("[data-play-send]").isDisabled()).toBe(false);
    await page.close();
  }, 240_000);

  it("Send: the dialog lists the change in words, checks the name, and calls the stubbed action once with the moved patch; the levers stay", async () => {
    const { page, errors } = await mount();
    await ready(page);
    await move(page, "demand.leads_per_week", 12);
    await page.click("[data-play-send]");
    await page.waitForSelector("[data-send-idea]");
    expect(await page.locator("[data-send-idea] h2").innerText()).toBe("Send your idea to Northbeam Digital");
    expect(await page.locator("[data-send-changes]").innerText()).toContain("Leads per week: 12");
    // The honeypot is off-screen and out of the tab order.
    const box = await page.locator("[data-send-honeypot]").boundingBox();
    expect(box === null || box.x + box.width <= 0).toBe(true);
    expect(await page.locator("[data-send-honeypot] input").getAttribute("tabindex")).toBe("-1");
    // Empty name first.
    await page.click("[data-send-submit]");
    expect(await page.locator("[data-send-error]").innerText()).toBe("Give your idea a name.");
    expect(await page.evaluate(() => window.playSubmits.length)).toBe(0);
    await page.fill("[data-send-title]", "More leads");
    await page.fill("[data-send-note]", "Try it for a quarter.");
    await page.fill("[data-send-name]", "Marta Okoye");
    await page.click("[data-send-submit]");
    expect(await page.locator("[data-send-error]").innerText()).toBe("Add your email address so the team can reply.");
    await page.fill("[data-send-email]", "marta@example.com");
    await page.click("[data-send-submit]");
    await page.waitForSelector("[data-send-done]");
    expect(await page.locator("[data-send-done]").innerText()).toContain("Sent. The team will find your idea in their Suggestions. Nothing changes unless they build it.");
    const sent = await page.evaluate(() => window.playSubmits);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ title: "More leads", note: "Try it for a quarter.", name: "Marta Okoye", email: "marta@example.com", issue: null, levers: [{ path: "demand.leads_per_week", op: "set", value: 12 }] });
    await page.click("[data-send-done] button");
    // The levers stay where they were.
    expect(await value(page, "demand.leads_per_week")).toBe("12");
    expect(errors).toEqual([]);
    await page.close();
  }, 240_000);

  it("shows each refusal in plain words, and keeps the dialog open", async () => {
    const answers: [Parameters<typeof JSON.stringify>[0], string][] = [
      [{ status: "rate_limited" }, "A lot of ideas have been sent from this link recently. Try again in an hour."],
      [{ status: "busy" }, "The team has a lot of ideas waiting. Try again later."],
      [{ status: "gone" }, "This link has expired or been turned off."],
      [{ status: "sign_in" }, "Sign in again with the address this link was sent to."],
      [{ status: "error", message: "One of the values is out of range." }, "One of the values is out of range."],
    ];
    const { page } = await mount();
    await ready(page);
    await move(page, "demand.leads_per_week", 12);
    await page.click("[data-play-send]");
    await page.fill("[data-send-title]", "More leads");
    await page.fill("[data-send-name]", "Marta");
    await page.fill("[data-send-email]", "marta@example.com");
    for (const [answer, message] of answers) {
      await page.evaluate((a) => (window.playAnswer = a as never), answer);
      await page.click("[data-send-submit]");
      await page.waitForFunction((m) => document.querySelector("[data-send-error]")?.textContent === m, message);
    }
    await page.close();
  }, 240_000);

  it("keeps nothing: localStorage and sessionStorage are empty after moving levers, and a reload (a fresh mount) shows every lever at neutral", async () => {
    const { page } = await mount();
    await ready(page);
    const before = await value(page, "demand.leads_per_week");
    await move(page, "demand.leads_per_week", 17);
    await page.waitForTimeout(500);
    expect(await value(page, "demand.leads_per_week")).toBe("17");
    expect(await page.evaluate(() => [localStorage.length, sessionStorage.length, document.cookie])).toEqual([0, 0, ""]);
    expect(page.url()).toBe("https://share.test/");
    // A reload: unmount and mount again.
    await page.evaluate(() => window.unmountShare());
    await page.evaluate(() => window.mountShare("process", { people: false, financials: false }, { mode: "play" }));
    await ready(page);
    expect(await value(page, "demand.leads_per_week")).toBe(before);
    expect(await page.locator("[data-play-send]").isDisabled()).toBe(true);
    await page.close();
  }, 240_000);

  it("a view link of the same snapshot shows no levers and no Send", async () => {
    const { page, errors } = await mount({ mode: "view" });
    await page.waitForSelector("[data-cost]", { timeout: 90_000, state: "attached" });
    await page.waitForTimeout(1500);
    const text = await page.locator("body").innerText();
    expect(text).toContain("Shared view · read only");
    expect(text).not.toContain("Try your own changes");
    expect(await page.locator("[data-lever]").count()).toBe(0);
    expect(await page.locator("[data-play-send]").count()).toBe(0);
    expect(errors).toEqual([]);
    await page.close();
  }, 240_000);

  it("when the workspace hides every lever kind the section says so and Send stays disabled", async () => {
    const { page } = await mount({ hidden: [...LEVER_KIND_IDS] });
    await page.waitForSelector("[data-play-section]", { timeout: 90_000 });
    expect(await page.locator("[data-play-note]").innerText()).toBe("The team hasn't shown any levers on this page.");
    expect(await page.locator("[data-lever]").count()).toBe(0);
    expect(await page.locator("[data-play-send]").isDisabled()).toBe(true);
    await page.close();
  }, 240_000);
});

describe("a restricted play link", () => {
  it("shows the verified address, read only, instead of an email field, and sends no typed email", async () => {
    const { page } = await mount({ people: true, financials: true, visitorEmail: "marta@example.com" });
    await ready(page);
    await move(page, "demand.leads_per_week", 12);
    await page.click("[data-play-send]");
    await page.waitForSelector("[data-send-idea]");
    expect(await page.locator("[data-send-verified]").innerText()).toBe("Sent as marta@example.com");
    expect(await page.locator("[data-send-email]").count()).toBe(0);
    await page.fill("[data-send-title]", "More leads");
    await page.fill("[data-send-name]", "Marta");
    await page.click("[data-send-submit]");
    await page.waitForSelector("[data-send-done]");
    expect((await page.evaluate(() => window.playSubmits))[0]).toMatchObject({ email: "" });
    // With People on a person's hours are offered.
    await page.click("[data-send-done] button");
    expect(await page.locator('[data-lever^="people."]').count()).toBeGreaterThan(0);
    await page.close();
  }, 240_000);
});

describe("screenshots", () => {
  for (const [scheme, width] of [["light", 1440], ["dark", 1440], ["light", 400], ["dark", 400]] as const) {
    it(`${scheme} at ${width} px: the section and the dialog render without console errors`, async () => {
      const { page, errors } = await mount({}, { width, height: width === 400 ? 900 : 1800 }, scheme);
      await ready(page);
      await move(page, "demand.leads_per_week", 12);
      await page.waitForTimeout(1500);
      await page.locator("[data-play-section]").scrollIntoViewIfNeeded();
      // No horizontal page scroll at phone width.
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/play-${scheme}-${width}.png` });
      await page.click("[data-play-send]");
      await page.waitForSelector("[data-send-idea]");
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/play-send-${scheme}-${width}.png` });
      expect(errors).toEqual([]);
      await page.close();
    }, 240_000);
  }
});
