import { chromium, type Browser, type Page } from "playwright-core";
import { mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bundleHarness } from "./build-harness";

// The Capacity page in a real browser, with its two simulations in a real Web Worker (./capacity-harness/entry.tsx), on the engine
// fixture `capacityModel()` and the Set up data that agrees with it (made-up data; the example workspace is the same agency): every
// section of the page, the leaver select, the empty state (no tiers), the missing state (a blank tier value and an engine problem),
// the pay-hidden view, and a phone, where the page never scrolls sideways.
//
// With CAPACITY_SHOTS=<dir> it also saves the screenshots of the page (light and dark, 1440 and 400 px) there.

let browser: Browser;
let script: string;
let workers: Record<string, string>;
let css = "";

const META = { "import.meta.url": JSON.stringify("http://harness.test/src/lib/x/") };

/** The app's real stylesheet (Tailwind compiled from globals.css). Test only: postcss is Tailwind's own dependency. */
async function appCss(): Promise<string> {
  const require = createRequire(import.meta.url);
  const here = dirname(require.resolve("@tailwindcss/postcss"));
  type Process = { process(css: string, o: { from: string }): Promise<{ css: string }> };
  const postcss = require(require.resolve("postcss", { paths: [here] })) as (plugins: unknown[]) => Process;
  const tailwind = require("@tailwindcss/postcss") as (o: { base: string }) => unknown;
  const file = fileURLToPath(new URL("../src/app/globals.css", import.meta.url));
  return (await postcss([tailwind({ base: fileURLToPath(new URL("..", import.meta.url)) })]).process(readFileSync(file, "utf8"), { from: file })).css;
}

beforeAll(async () => {
  [script, workers, css] = await Promise.all([
    bundleHarness(new URL("./capacity-harness/entry.tsx", import.meta.url), META),
    Promise.all(["simulate.worker.ts"].map(async (f) => [f, await bundleHarness(new URL(`../src/workers/${f}`, import.meta.url))] as const)).then(Object.fromEntries),
    appCss(),
  ]);
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
}, 180_000);

afterAll(async () => {
  await browser?.close();
});

type Options = { payHidden?: boolean; noTiers?: boolean; missingWords?: boolean; badModel?: boolean; tierTotal?: "over" | "unassigned" };

async function mount(options: Options = {}, width = 1440, scheme: "light" | "dark" = "light", scale = 1): Promise<{ page: Page; errors: string[] }> {
  const page = await browser.newPage({ viewport: { width, height: 1000 }, colorScheme: scheme, deviceScaleFactor: scale });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.setContent(`<style>${css}</style><div id="root"></div>`);
  await page.evaluate((w) => (window.workerScripts = w), workers);
  await page.addScriptTag({ content: script });
  await page.evaluate((o) => window.mountCapacity(o), options);
  return { page, errors };
}

/** The Today run finished: the last section, named clients, is on the page. */
const allDone = (page: Page) => page.waitForSelector("[data-named-clients]", { timeout: 120_000 });
const text = (page: Page, sel: string) => page.locator(sel).first().innerText();

describe("Capacity page", { timeout: 180_000 }, () => {
  for (const width of [1440, 400]) {
    it(`shows every section on the example agency (${width}px)`, async () => {
      const { page, errors } = await mount({}, width);
      await page.waitForSelector("[data-room]", { timeout: 120_000 });
      await allDone(page);
      const root = page.locator("[data-capacity]");
      console.log(`capacity run (${width}px): today ${await root.getAttribute("data-today-ms")} ms`);

      // Headline: clients by service line, taking both, and DLER as the average of each person's DLER, said against its goal in words.
      const kpis = await page.locator("[data-headline] [data-kpi]").allInnerTexts();
      expect(kpis.some((k) => /Clients with Organic \(SEO\) services/.test(k))).toBe(true);
      expect(kpis.some((k) => /Clients with Performance services/.test(k))).toBe(true);
      expect(kpis.some((k) => /Clients taking both\s+\d+\s+\d+ clients in all/.test(k))).toBe(true);
      const dlerKpis = kpis.filter((k) => k.includes("DLER") && /Average of \d+ people.s DLER/.test(k));
      expect(dlerKpis).toHaveLength(3);
      for (const k of dlerKpis) expect(k).toMatch(/(At or above|Below) the 4\.5 goal/);
      const statuses = await page.locator("[data-headline] [data-kpi][data-kpi-status]").evaluateAll((els) => els.map((e) => e.getAttribute("data-kpi-status")));
      expect(statuses).toHaveLength(3);
      for (const s of statuses) expect(["good", "warn"]).toContain(s);
      expect(kpis.some((k) => k.includes("DLER whole business"))).toBe(true);

      // Room for more clients: today's clients first, a bar against the most that fit labelled in words, who gets the next client.
      expect(await page.locator("[data-room]").count()).toBe(2);
      for (const s of await page.locator("[data-room-clients]").allInnerTexts()) expect(s).toMatch(/^\d[\d,]*\s+clients today$/);
      for (const s of await page.locator("[data-room-status]").allInnerTexts()) expect(s).toMatch(/^(Room for \d+ more|Full|Over by \d+)$/);
      for (const s of await page.locator("[data-room-sentence]").allInnerTexts()) expect(s).toMatch(/^Up to \d[\d,]* before .+ reach their utilisation threshold\.$/);
      for (const s of await page.locator("[data-room-next]").allInnerTexts()) expect(s).toMatch(/^Next client goes to: \S/);
      expect(await page.locator("[data-room-bar]").count()).toBe(2);
      // The per-team ceilings are in "How this works", the (?) in each room panel's header.
      expect(await page.locator("[data-room] [data-how]").count()).toBe(2);
      for (const i of [0, 1]) {
        await page.locator("[data-room] [data-how] button").nth(i).click();
        expect(await page.locator("[data-how-text] [data-room-limits]").count()).toBe(1);
        await page.keyboard.press("Escape");
      }

      // Client-facing people: one bar per person per department, busiest first, with +N or full; the detail is in each row's title.
      expect(await page.locator("[data-people-table]").count()).toBe(2);
      const rowTitles = (dept: string) => page.locator(`[data-people-table="${dept}"] [data-person-row]`).evaluateAll((els) => els.map((e) => e.getAttribute("title") ?? ""));
      const perf = await rowTitles("Performance");
      const org = await rowTitles("Organic (SEO)");
      expect(perf.length).toBeGreaterThan(1);
      expect(perf.every((t) => / channels\./.test(t))).toBe(true);
      expect(org.some((t) => / channels\./.test(t))).toBe(false);
      for (const t of [...perf, ...org]) expect(t).toMatch(/busy against a utilisation threshold of \d+%.*hours needed \d+ h a month, \d+ h available.*rule of thumb/);
      expect(org.some((t) => t.startsWith("Laura"))).toBe(true);
      for (const n of await page.locator("[data-can-take]").allInnerTexts()) expect(n).toMatch(/^(\+\d+|full)$/);
      const busiest = await page.locator('[data-people-table="Organic (SEO)"] [data-busy]').evaluateAll((els) => els.map((e) => Number(e.getAttribute("data-busy"))));
      expect(busiest).toEqual([...busiest].sort((a, b) => b - a));

      // No "Shared teams" section (removed at QA).
      expect(await page.locator("[data-shared-teams], [data-team]").count()).toBe(0);

      // Bottleneck: everyone over or within 10 points of their utilisation threshold, over first, each with their month by purpose.
      const atRisk = await page.locator("[data-at-risk]").evaluateAll((els) => els.map((e) => e.getAttribute("data-at-risk")));
      const sentence = await text(page, "[data-bottleneck-sentence]");
      if (atRisk.length === 0) expect(sentence).toBe("Nobody is over or within 10 points of their utilisation threshold.");
      else {
        expect(sentence).toMatch(/^(\d+ over( and \d+ within 10 points)?|\d+ within 10 points) of their utilisation threshold\.$/);
        expect(atRisk).toEqual([...atRisk].sort((a, b) => (a === b ? 0 : a === "over" ? -1 : 1)));
        expect(await page.locator("[data-bottleneck] [data-at-risk] [data-stack]").count()).toBe(atRisk.length);
        expect(await page.locator("[data-bottleneck] [data-legend] li").count()).toBeGreaterThan(0);
        // Their biggest steps link to the process page, in "How this works".
        await page.locator("[data-bottleneck] [data-how] button").click();
        const href = await page.locator("[data-how-text] [data-step-link]").first().getAttribute("href");
        await page.keyboard.press("Escape");
        expect(href).toMatch(/^\/w\/example\/p\/[\w-]+\?step=\w+$/);
      }

      // What if someone leaves, time to serve.
      expect(await text(page, "[data-leaver-sentence]")).toMatch(/If .+ leaves/);
      expect(await page.locator("[data-dumbbell]").count()).toBeGreaterThan(0);
      expect(await page.locator("[data-tier-card]").count()).toBe(6);
      expect(await text(page, "[data-time-to-serve]")).toContain("Avg time to serve one client, by tier, per month");
      for (const fee of await page.locator("[data-tier-fee]").allInnerTexts()) expect(fee).toMatch(/^Avg A\$[\d,]+ a month$/);
      // One colour per purpose across the page: a purpose's segment is the same colour in every tier's bar and every bottleneck bar, and no
      // two purposes share one.
      const colours = await page.locator("[data-time-to-serve] [data-part], [data-bottleneck] [data-part]").evaluateAll((els) => els.map((e) => [e.getAttribute("data-part"), getComputedStyle(e).backgroundColor] as const));
      const byPurpose = new Map<string, Set<string>>();
      for (const [name, c] of colours) byPurpose.set(name!, (byPurpose.get(name!) ?? new Set()).add(c));
      expect(byPurpose.size).toBeGreaterThan(1);
      for (const set of byPurpose.values()) expect(set.size).toBe(1);
      expect(new Set([...byPurpose.values()].map((v) => [...v][0])).size).toBe(byPurpose.size);
      expect(await page.locator("[data-named-clients] tbody tr").count()).toBe(13);
      // Each widget has its "How this works" behind a (?), closed.
      expect(await page.locator("[data-how]").count()).toBeGreaterThanOrEqual(7);
      expect(await page.locator("[data-how-text]").count()).toBe(0);

      // The page never scrolls sideways, and the people rows fit their card.
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow).toBeLessThanOrEqual(0);
      const rowsFit = await page.locator("[data-person-row]").evaluateAll((els) => els.every((e) => e.scrollWidth <= e.clientWidth + 1));
      expect(rowsFit).toBe(true);
      expect(errors).toEqual([]);
      await page.close();
    });
  }

  it("choosing who leaves, one or several, from the dropdown changes the sentence and the dumbbells", async () => {
    const { page, errors } = await mount();
    await page.waitForSelector("[data-leaver-select]", { timeout: 120_000 });
    const button = page.locator("[data-leaver-select]");
    const first = await text(page, "[data-leaver-sentence]");
    expect(first).toMatch(/^If .+ leaves, /);
    const chosen = (await button.innerText()).trim();

    // A full-width button that opens a checkbox list grouped by department; Escape closes it and returns to the button.
    expect(await button.getAttribute("aria-expanded")).toBe("false");
    await button.click();
    expect(await button.getAttribute("aria-expanded")).toBe("true");
    expect(await page.locator("[data-leaver-options] fieldset legend").count()).toBeGreaterThanOrEqual(2);
    await page.keyboard.press("Escape");
    expect(await page.locator("[data-leaver-options]").count()).toBe(0);
    expect(await page.evaluate(() => document.activeElement?.hasAttribute("data-leaver-select"))).toBe(true);

    // Keyboard: open with ArrowDown, the checked person has focus; Space unticks them.
    await page.keyboard.press("ArrowDown");
    await page.waitForSelector("[data-leaver-options]");
    // Focus moves to the checked person once the list has opened. Press Space only then: pressed before that (as happened on a
    // loaded CI runner), Space goes to the closed trigger and shuts the list, which made the next check pass with nothing unticked.
    await page.waitForFunction(() => document.activeElement?.matches("[data-leaver-options] input:checked") ?? false);
    await page.keyboard.press(" ");
    await page.waitForSelector("[data-leaver-options]");
    expect(await page.locator("[data-leaver-options] input:checked").count()).toBe(0);
    expect(await text(page, "[data-leaver-sentence]")).toBe("Choose one or more people to see who takes their work.");

    // Two people: Zach and Laura (both Organic) leave together; neither is handed the other's clients.
    await page.locator('[data-leaver-option="Zach"] input').check();
    await page.locator('[data-leaver-option="Laura"] input').check();
    const two = await text(page, "[data-leaver-sentence]");
    expect(two).not.toBe(first);
    expect(two).toMatch(/^If (Laura and Zach|Zach and Laura) leave, their \d+ clients go to /);
    expect(two).not.toMatch(/(Zach|Laura) \(\d+\)/);
    expect(await button.innerText()).toMatch(/Laura, Zach|Zach, Laura/);
    expect(await page.locator("[data-dumbbell]").count()).toBeGreaterThan(0);

    // Clear empties the choice.
    await page.keyboard.press("Escape");
    await page.locator("[data-leaver-clear]").click();
    expect((await button.innerText()).trim()).toBe("Choose who leaves");
    expect(chosen).not.toBe("Choose who leaves");
    expect(errors).toEqual([]);
    await page.close();
  });

  it("points to Set up when no tier services exist", async () => {
    const { page, errors } = await mount({ noTiers: true });
    await page.waitForSelector("[data-no-tiers]");
    expect(await text(page, "[data-no-tiers]")).toContain("No tiers and services are set up yet.");
    expect(await page.locator("[data-no-tiers] a").getAttribute("href")).toBe("/w/example/settings#tiers-clients");
    expect(await page.locator("[data-room]").count()).toBe(0);
    expect(errors).toEqual([]);
    await page.close();
  });

  it("lists a tier whose portfolios and named clients pass its typed total as a warning, and clients nobody holds as a note (Q13)", async () => {
    const over = await mount({ tierTotal: "over" });
    await over.page.waitForSelector("[data-attention]");
    const warn = await text(over.page, "[data-attention]");
    expect(warn).toMatch(/Organic \(SEO\) T1: Portfolios and named clients add up to \d+, but the tier has 0 \(\d+ too many\)\. The model counts the portfolios as they are\./);
    expect(await over.page.locator("[data-attention] a").evaluateAll((as) => as.map((a) => a.textContent))).toContain("Check it →");
    await over.page.close();
    const note = await mount({ tierTotal: "unassigned" });
    await note.page.waitForSelector("[data-attention-note-only], [data-attention-notes]");
    // Only a note: no "not worked out yet" warning card on its account, and the sentence is the note's.
    expect(await note.page.locator("[data-attention]").count()).toBe(0);
    expect(await text(note.page, "[data-attention-note-only]")).toMatch(/Note: Organic \(SEO\) T1: \d+ clients aren't in anyone's portfolio\./);
    await note.page.close();
  });

  it("lists what is missing and the engine's problems, with where to fix each, and still shows the widgets", async () => {
    const missing = await mount({ missingWords: true, badModel: true });
    await missing.page.waitForSelector("[data-attention]");
    const list = await text(missing.page, "[data-attention]");
    expect(list).toContain("Organic (SEO) T1: words");
    expect(list).toMatch(/adoption/i);
    const links = await missing.page.locator("[data-attention] a").evaluateAll((as) => as.map((a) => a.getAttribute("href")));
    expect(links).toContain("/w/example/settings#tiers-clients");
    expect(links).toContain("/w/example/processes");
    // The attention list is above the widgets it affects.
    const order = await missing.page.evaluate(() => {
      const a = document.querySelector("[data-attention]")!;
      const r = document.querySelector("[data-headline]")!;
      return a.compareDocumentPosition(r) & Node.DOCUMENT_POSITION_FOLLOWING;
    });
    expect(order).toBeTruthy();
    await missing.page.waitForSelector("[data-room]", { timeout: 120_000 });
    await missing.page.close();
  });

  it("hides every salary from someone who can't see pay, and still shows the page", async () => {
    const { page, errors } = await mount({ payHidden: true });
    await page.waitForSelector("[data-room]", { timeout: 120_000 });
    await allDone(page);
    const all = await page.locator("[data-capacity]").innerText();
    for (const salary of ["12,500", "7,500", "12,000", "7,000", "5,500", "2,500", "6,000", "107,000", "66,000", "173,000"]) expect(all).not.toContain(salary);
    expect(all).toContain("Pay is hidden for your role");
    const dlers = await page.locator("[data-headline] [data-kpi]").filter({ hasText: "DLER" }).allInnerTexts();
    expect(dlers).toHaveLength(3);
    for (const d of dlers) expect(d).not.toMatch(/÷/);
    expect(errors).toEqual([]);
    await page.close();
  });

  const shots = process.env.CAPACITY_SHOTS;
  it.skipIf(!shots)("saves screenshots (light and dark, 1440 and 400 px)", async () => {
    mkdirSync(shots!, { recursive: true });
    for (const scheme of ["light", "dark"] as const) {
      for (const width of [1440, 400]) {
        const { page } = await mount({}, width, scheme, 2);
        await page.waitForSelector("[data-room]", { timeout: 120_000 });
        await allDone(page);
        await page.evaluate(() => document.fonts.ready);
        await page.screenshot({ path: `${shots}/capacity-${scheme}-${width}.png`, fullPage: true });
        // Q19: the time-to-serve card on its own, its bars named by the workspace's purposes.
        if (scheme === "light" && width === 1440) await page.locator("[data-time-to-serve]").screenshot({ path: `${shots}/capacity-time-to-serve-light-1440.png` });
        await page.close();
      }
    }
  });
});
