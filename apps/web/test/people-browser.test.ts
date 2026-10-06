import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bundleHarness } from "./build-harness";

// The People page as a member sees it (B1 2b, issue #30), in a real browser with its simulation in a real Web Worker
// (./people-harness/entry.tsx): the "How busy" table lists the member's own row only, the team card still counts the whole
// team, no other person is named, and the page has no console errors on a desktop and a phone. An owner or editor sees
// everyone.

let browser: Browser;
let script: string;
let workers: Record<string, string>;

const META = { "import.meta.url": JSON.stringify("http://harness.test/src/lib/x/") };

beforeAll(async () => {
  [script, workers] = await Promise.all([
    bundleHarness(new URL("./people-harness/entry.tsx", import.meta.url), META),
    Promise.all(["simulate.worker.ts", "absence.worker.ts"].map(async (f) => [f, await bundleHarness(new URL(`../src/workers/${f}`, import.meta.url))] as const)).then(Object.fromEntries),
  ]);
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
}, 120_000);

afterAll(async () => {
  await browser?.close();
});

async function mount(options: { viewer: "everyone" | "own" | "unlinked"; own?: string; capacityFactorEnabled?: boolean }, width = 1440): Promise<{ page: Page; errors: string[] }> {
  const page = await browser.newPage({ viewport: { width, height: 1000 } });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.setContent(`<div id="root"></div>`);
  await page.evaluate((w) => (window.workerScripts = w), workers);
  await page.addScriptTag({ content: script });
  await page.evaluate((o) => window.mountPeople(o), options);
  await page.waitForSelector("h2:has-text('How busy')", { timeout: 90_000 });
  return { page, errors };
}

const busyRows = (page: Page) => page.locator("[data-how-busy] tbody tr");
const absenceRows = (page: Page) => page.locator("[data-absence] tbody tr");
/** Wait until the absence test has answered: its card shows a table or a sentence instead of "Testing…". */
const absenceDone = (page: Page) => page.waitForFunction(() => !document.querySelector("[data-absence] [role=status]"), undefined, { timeout: 90_000 });

// Larkspur's sole holders (absenceCandidates on the Larkspur model): Hana, Imogen, Marek and Priti. Jess is not one.
const SOLE_HOLDERS = 4;

describe("People page as a member", { timeout: 120_000 }, () => {
  for (const width of [1440, 400]) {
    it(`lists only the member's own row and counts the whole team (${width}px)`, async () => {
      const { page, errors } = await mount({ viewer: "own", own: "jess" }, width);
      const rows = busyRows(page);
      expect(await rows.count()).toBe(1);
      expect(await rows.first().innerText()).toContain("Jess Monroe");
      expect(await page.locator("[data-how-busy] table").innerText()).not.toMatch(/Team member|A team member/);
      // The team card counts everyone, not the one row.
      const everyone = await mount({ viewer: "everyone" }, width);
      const total = await busyRows(everyone.page).count();
      expect(total).toBeGreaterThan(1);
      const teamNumber = async (p: Page) => (await p.locator("[data-team-card] .text-3xl").innerText()).match(/^(\d+)/)?.[1];
      expect(await teamNumber(page)).toBe(String(total));
      expect(errors).toEqual([]);
      expect(everyone.errors).toEqual([]);
      await page.close();
      await everyone.page.close();
    });
  }

  it("says how to get linked when the member's sign-in has no person", async () => {
    const { page, errors } = await mount({ viewer: "unlinked" });
    expect(await busyRows(page).count()).toBe(0);
    expect(await page.locator("[data-no-own-row]").innerText()).toContain("isn't linked to a person");
    // No absence test is run for them, and nothing of anyone else's shows.
    expect(await absenceRows(page).count()).toBe(0);
    expect(await page.locator("[data-absence]").innerText()).toContain("Nothing to show for you here.");
    expect(errors).toEqual([]);
    await page.close();
  });
});

describe("If someone is away", { timeout: 180_000 }, () => {
  for (const width of [1440, 400]) {
    it(`tests every sole holder for an editor (${width}px)`, async () => {
      const { page, errors } = await mount({ viewer: "everyone" }, width);
      await absenceDone(page);
      expect(await absenceRows(page).count()).toBe(SOLE_HOLDERS);
      const text = await page.locator("[data-absence]").innerText();
      expect(text).toContain("Imogen Reyes");
      expect(text).toMatch(/Great|Bad, not urgent|Operational risk/);
      expect(text).toContain("Tested over the workspace's own 26-week run");
      if (width === 1440) {
        const head = await page.locator("[data-how-busy] thead").innerText();
        for (const h of ["Client work", "Sales work", "Overtime", "Average", "Leave"]) expect(head).toContain(h);
      }
      expect(errors).toEqual([]);
      await page.close();
    });
  }

  it("shows a member linked to a sole holder only their own result", async () => {
    const { page, errors } = await mount({ viewer: "own", own: "imogen" });
    await absenceDone(page);
    expect(await busyRows(page).count()).toBe(1);
    expect(await absenceRows(page).count()).toBe(1);
    expect(await absenceRows(page).first().innerText()).toContain("Imogen Reyes");
    await busyRows(page).first().getByRole("button", { name: "Imogen Reyes" }).click();
    for (const sel of ["[data-how-busy]", "[data-absence]", "[data-person-detail]"]) {
      expect(await page.locator(sel).innerText()).not.toMatch(/Team member|A team member/);
    }
    expect(errors).toEqual([]);
    await page.close();
  });

  it("tells a member who isn't a sole holder that they weren't tested", async () => {
    const { page, errors } = await mount({ viewer: "own", own: "jess" });
    await absenceDone(page);
    expect(await absenceRows(page).count()).toBe(0);
    expect(await page.locator("[data-absence]").innerText()).toContain("You aren't the only one who can do any step, so you weren't tested.");
    expect(errors).toEqual([]);
    await page.close();
  });
});

describe("Person detail", { timeout: 120_000 }, () => {
  it("opens under the row, one at a time, with Can do and Leave", async () => {
    const { page, errors } = await mount({ viewer: "everyone" });
    await busyRows(page).getByRole("button", { name: "Freya Walsh" }).click();
    const detail = page.locator("[data-person-detail]");
    expect(await detail.count()).toBe(1);
    const text = await detail.innerText();
    expect(text).toContain("Can do");
    expect(text).toContain("Leave");
    // Freya is set up for two steps, not every step of her role.
    expect(text).not.toContain("Every step of their roles");
    expect(text).toContain("Change in Settings");
    expect(await busyRows(page).getByRole("button", { name: "Freya Walsh" }).getAttribute("aria-expanded")).toBe("true");
    // Opening another closes it.
    await busyRows(page).getByRole("button", { name: "Jess Monroe" }).click();
    expect(await detail.count()).toBe(1);
    expect(await detail.innerText()).toContain("Every step of their roles");
    expect(errors).toEqual([]);
    await page.close();
  });

  it("gives a member no link to Settings", async () => {
    const { page } = await mount({ viewer: "own", own: "jess" });
    await busyRows(page).getByRole("button", { name: "Jess Monroe" }).click();
    expect(await page.locator("[data-person-detail]").innerText()).not.toContain("Change in Settings");
    await page.close();
  });

  it("shows no capacity factor anywhere, even with the setting on (C6 is parked)", async () => {
    const { page, errors } = await mount({ viewer: "everyone", capacityFactorEnabled: true });
    await absenceDone(page);
    await busyRows(page).getByRole("button", { name: "Freya Walsh" }).click();
    expect((await page.locator("body").innerText()).toLowerCase()).not.toContain("capacity factor");
    expect((await page.content()).toLowerCase()).not.toContain("capacity factor");
    expect(errors).toEqual([]);
    await page.close();
  });
});

describe("Horizon picker", { timeout: 120_000 }, () => {
  it("re-runs How busy at the picked length", async () => {
    const { page, errors } = await mount({ viewer: "everyone" });
    await page.getByRole("button", { name: "12 months" }).click();
    await page.waitForSelector("button[aria-label='12 months'][aria-pressed='true']");
    await page.waitForSelector("[data-how-busy] tbody tr", { timeout: 90_000 });
    expect(await busyRows(page).count()).toBeGreaterThan(1);
    expect(errors).toEqual([]);
    await page.close();
  });
});
