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
    Promise.all(["simulate.worker.ts"].map(async (f) => [f, await bundleHarness(new URL(`../src/workers/${f}`, import.meta.url))] as const)).then(Object.fromEntries),
  ]);
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
}, 120_000);

afterAll(async () => {
  await browser?.close();
});

async function mount(options: { viewer: "everyone" | "own" | "unlinked"; own?: string }, width = 1440): Promise<{ page: Page; errors: string[] }> {
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
    expect(errors).toEqual([]);
    await page.close();
  });
});
