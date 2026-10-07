import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { larkspurBundle, larkspurPersonIds, type PersonCapacityFactorRow } from "@transpera-flow/db";
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

async function mount(options: { viewer: "everyone" | "own" | "unlinked"; own?: string; capacityFactorEnabled?: boolean; ownRecord?: "inactive" | "starts-later"; factors?: PersonCapacityFactorRow[]; unfiltered?: boolean }, width = 1440): Promise<{ page: Page; errors: string[] }> {
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
    const card = await page.locator("[data-absence]").innerText();
    expect(card).toContain("Nothing to show for you here.");
    // Only the heading and that sentence (the brief), not the line about the run's length.
    expect(card).not.toContain("Tested over");
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

describe("A linked member who isn't in the run", { timeout: 180_000 }, () => {
  for (const ownRecord of ["inactive", "starts-later"] as const) {
    it(`says so (${ownRecord}), not that their sign-in isn't linked`, async () => {
      const { page, errors } = await mount({ viewer: "own", own: "jess", ownRecord });
      await absenceDone(page);
      expect(await busyRows(page).count()).toBe(0);
      expect(await page.locator("[data-not-in-run]").innerText()).toContain("You aren't in this simulation: your record is inactive or starts later.");
      expect(await page.locator("[data-no-own-row]").count()).toBe(0);
      expect(await absenceRows(page).count()).toBe(0);
      expect(await page.locator("[data-absence]").innerText()).toContain("You aren't the only one who can do any step, so you weren't tested.");
      expect(errors).toEqual([]);
      await page.close();
    });
  }
});

/** What the page posted to the absence worker, as the harness recorded it. */
const absenceRequests = (page: Page) => page.evaluate(() => (window.workerRequests ?? []).filter((r) => r.file === "absence.worker.ts"));

describe("What the page asks the absence worker (Q3)", { timeout: 180_000 }, () => {
  it("asks for everyone's test from an editor: no personIds", async () => {
    const { page } = await mount({ viewer: "everyone" });
    await absenceDone(page);
    const requests = await absenceRequests(page);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.hasPersonIds).toBe(false);
    await page.close();
  });

  it("asks a member's browser to test only their own person", async () => {
    const { page } = await mount({ viewer: "own", own: "imogen" });
    await absenceDone(page);
    const requests = await absenceRequests(page);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.personIds).toEqual([larkspurPersonIds.imogen]);
    await page.close();
  });

  it("sends no absence request at all for an unlinked member", async () => {
    const { page } = await mount({ viewer: "unlinked" });
    // The test would start a debounce after the first run finishes; give it time to have been sent.
    await page.waitForSelector(".grid[aria-busy='false']");
    await page.waitForTimeout(1500);
    expect(await absenceRequests(page)).toEqual([]);
    // The baseline run itself did go to its worker.
    expect((await page.evaluate(() => window.workerRequests ?? [])).some((r) => r.file === "simulate.worker.ts")).toBe(true);
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
    // aria-controls is set only while there is something to point at, and then it resolves.
    const resolves = () =>
      page.evaluate(() =>
        [...document.querySelectorAll("[data-how-busy] button[aria-controls]")].every((b) => document.getElementById(b.getAttribute("aria-controls")!) !== null),
      );
    expect(await resolves()).toBe(true);
    expect(await page.locator("[data-how-busy] button[aria-controls]").count()).toBe(1);
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

  // Per-person times (C6, #198). Larkspur's first step stands in for "a step"; Hana's 1.35 is the value no one else may see.
  const live = larkspurBundle();
  // Freya has skills, so her step is one of them; Jess has none, so hers is a step of her roles. FOREIGN is a step Jess can't do.
  const byId = new Map(live.steps.map((st) => [st.id, st]));
  const STEP = byId.get(live.personSkills.find((k) => k.person_id === larkspurPersonIds.freya)!.step_id)!;
  const jessRoles = new Set(live.personRoles.filter((r) => r.person_id === larkspurPersonIds.jess).map((r) => r.role_id));
  const JESS_STEP = live.steps.find((st) => st.role_id && jessRoles.has(st.role_id))!;
  const FOREIGN = live.steps.find((st) => st.role_id && !jessRoles.has(st.role_id))!;
  const row = (person: string, step: string | null, factor: number): PersonCapacityFactorRow => ({ person_id: larkspurPersonIds[person]!, workspace_id: live.workspace.id, step_id: step, factor, source: "entered" });
  const FACTORS = [row("freya", null, 0.9), row("freya", STEP.id, 0.8), row("hana", null, 1.35), row("jess", JESS_STEP.id, 1.2), row("jess", FOREIGN.id, 1.6)];

  it("switch off, with factors stored: no 'Time on each step' text anywhere and no [data-capacity-factors]", async () => {
    const { page, errors } = await mount({ viewer: "everyone", capacityFactorEnabled: false, factors: FACTORS });
    await absenceDone(page);
    await busyRows(page).getByRole("button", { name: "Freya Walsh" }).click();
    expect(await page.locator("[data-person-detail]").count()).toBe(1);
    expect(await page.locator("[data-capacity-factors]").count()).toBe(0);
    for (const text of [await page.locator("body").innerText(), await page.locator("#root").innerHTML()]) {
      expect(text).not.toContain("Time on each step");
      expect(text).not.toContain("× normal");
      expect(text.toLowerCase()).not.toContain("capacity factor");
    }
    expect(errors).toEqual([]);
    await page.close();
  });

  it("switch on, a viewer who sees everyone: a person with times shows them in their detail; one without shows nothing; the How busy table has none", async () => {
    const { page, errors } = await mount({ viewer: "everyone", capacityFactorEnabled: true, factors: FACTORS });
    await absenceDone(page);
    // No note for someone who sees everyone, and nothing in the table.
    expect(await page.locator("[data-speeds-normalised]").count()).toBe(0);
    const table = await page.locator("[data-how-busy] table").innerText();
    expect(table).not.toMatch(/×|faster|slower|normal time/);
    await busyRows(page).getByRole("button", { name: "Freya Walsh" }).click();
    const detail = page.locator("[data-person-detail] [data-capacity-factors]");
    const text = await detail.innerText();
    expect(text).toContain("Time on each step");
    expect(text).toContain("Every step: 0.9 × normal (10% faster)");
    expect(text).toContain(`${STEP.name}: 0.8 × normal (20% faster)`);
    // The default comes first, and Jess's and Hana's values are not in Freya's detail.
    expect(text.indexOf("Every step")).toBeLessThan(text.indexOf(STEP.name));
    expect(text).not.toMatch(/1\.35|\b1\.2 ×/);
    // The (i) is there.
    expect(await detail.getByRole("button").count()).toBeGreaterThan(0);
    // Opening someone without any closes Freya's and shows nothing.
    await busyRows(page).getByRole("button", { name: "Priti Desai" }).click();
    expect(await page.locator("[data-capacity-factors]").count()).toBe(0);
    expect(await page.locator("[data-how-busy] table").innerText()).not.toMatch(/×|faster|slower/);
    expect(errors).toEqual([]);
    await page.close();
  });

  for (const width of [1440, 400]) {
    it(`switch on, a member (own times only): their detail shows them, the note is visible, nobody else's value appears (${width}px)`, async () => {
      const { page, errors } = await mount({ viewer: "own", own: "jess", capacityFactorEnabled: true, factors: FACTORS }, width);
      expect(await page.locator("[data-speeds-normalised]").innerText()).toContain("Per-person times are on in this workspace. Your numbers use each role's normal time, so they can differ a little from what owners and editors see.");
      await busyRows(page).getByRole("button", { name: "Jess Monroe" }).click();
      const text = await page.locator("[data-capacity-factors]").innerText();
      expect(text).toContain(`${JESS_STEP.name}: 1.2 × normal (20% slower)`);
      // A time on a step she can't do is stored but never shown (Settings lists it under "Not used now").
      expect(text).not.toContain(FOREIGN.name);
      expect(text).not.toContain("1.6");
      for (const t of [await page.locator("body").innerText(), await page.locator("#root").innerHTML()]) {
        expect(t).not.toContain("1.35");
        expect(t).not.toContain("0.9 ×");
      }
      expect(errors).toEqual([]);
      await page.close();
    });
  }

  it("a member's page shows only their own times even when handed everyone's rows (the screen, not the harness, keeps them apart)", async () => {
    const { page, errors } = await mount({ viewer: "own", own: "jess", capacityFactorEnabled: true, factors: FACTORS, unfiltered: true });
    await busyRows(page).getByRole("button", { name: "Jess Monroe" }).click();
    for (const t of [await page.locator("body").innerText(), await page.locator("#root").innerHTML()]) {
      expect(t).not.toContain("1.35");
      expect(t).not.toContain("0.9 ×");
      expect(t).not.toContain("Every step: 0.9");
    }
    expect(await page.locator("[data-capacity-factors]").innerText()).toContain(`${JESS_STEP.name}: 1.2`);
    expect(errors).toEqual([]);
    await page.close();
  });

  it("switch on, a member linked to nobody: the note shows, no times", async () => {
    const { page, errors } = await mount({ viewer: "unlinked", capacityFactorEnabled: true, factors: FACTORS });
    expect(await page.locator("[data-speeds-normalised]").count()).toBe(1);
    expect(await page.locator("[data-capacity-factors]").count()).toBe(0);
    expect(await page.locator("#root").innerHTML()).not.toContain("1.35");
    expect(errors).toEqual([]);
    await page.close();
  });
});

describe("Horizon picker", { timeout: 120_000 }, () => {
  it("keeps the previous run's numbers whole while the new run goes, and marks How busy as busy", async () => {
    const { page, errors } = await mount({ viewer: "everyone" });
    await page.waitForSelector(".grid[aria-busy='false']");
    const kai = () => busyRows(page).filter({ hasText: "Kai Robinson" }).locator("td").last().innerText();
    const before = await kai();
    // Kai's December leave is inside the 26-week run and outside a 1-month one.
    expect(before).not.toBe("—");
    // Hold the new run's request in the harness, so the page stays mid-run until we release it (no race with the worker).
    await page.evaluate(() => (window.holdSimulations = true));
    await page.getByRole("button", { name: "1 month" }).click();
    await page.waitForSelector("[data-how-busy][aria-busy='true']", { timeout: 90_000 });
    // Still the old run's numbers: the new (shorter) model's leave isn't counted against them.
    expect(await kai()).toBe(before);
    expect(await page.locator("[data-how-busy]").getAttribute("aria-busy")).toBe("true");
    await page.evaluate(() => window.releaseSimulations());
    await page.waitForSelector("[data-how-busy][aria-busy='false']", { timeout: 90_000 });
    expect(await kai()).toBe("—");
    expect(errors).toEqual([]);
    await page.close();
  });

  it("re-runs How busy at the picked length", async () => {
    const { page, errors } = await mount({ viewer: "everyone" });
    await absenceDone(page);
    const absenceBefore = await page.locator("[data-absence]").innerText();
    await page.waitForSelector(".grid[aria-busy='false']");
    // Hold the new run's request so the page stays mid-run until released (the old table is there meanwhile, so wait on the run, not the table).
    await page.evaluate(() => (window.holdSimulations = true));
    await page.getByRole("button", { name: "12 months" }).click();
    await page.waitForSelector("button[aria-label='12 months'][aria-pressed='true']");
    await page.waitForSelector(".grid[aria-busy='true']", { timeout: 90_000 });
    // The absence test is over the workspace's own length (Q2): the picker doesn't restart it.
    expect(await page.locator("[data-absence] [role=status]").count()).toBe(0);
    await page.evaluate(() => window.releaseSimulations());
    await page.waitForSelector(".grid[aria-busy='false']", { timeout: 90_000 });
    expect(await busyRows(page).count()).toBeGreaterThan(1);
    expect(await page.locator("[data-absence] [role=status]").count()).toBe(0);
    expect(await page.locator("[data-absence]").innerText()).toBe(absenceBefore);
    expect(errors).toEqual([]);
    await page.close();
  });
});
