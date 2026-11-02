import { chromium, type Browser, type Page } from "playwright-core";
import { mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadLiveCompanyPart, loadLiveParts, loadLiveProcessBySlug } from "@transpera-flow/db";
import { loadCapacityExample } from "../../../packages/db/src/fixtures/capacity-example";
import { createTestDb, createUser, type TestDb } from "../../../packages/db/test/harness";
import { bundleHarness } from "./build-harness";
import type { LanesData } from "./overview-lanes-harness/entry";

// Department lanes on the Overview's company map (Q4), in a real browser, on the example agency loaded into a throwaway database with the real
// migrations: the lanes are in order (Sales and whole business, then Organic (SEO) and Performance), and each process card sits in the lane of
// its department. A process the owner puts in another department moves lane; Fit frames the lanes.
//
// With Q4_SHOTS=<dir> it also saves the screenshots (light and dark, 1440 px) there.

let tdb: TestDb;
let browser: Browser;
let script: string;
let workers: Record<string, string>;
let css = "";
let data: LanesData;
let names: Record<string, string>;

const META = { "import.meta.url": JSON.stringify("http://harness.test/src/lib/x/") };

async function appCss(): Promise<string> {
  const require = createRequire(import.meta.url);
  const here = dirname(require.resolve("@tailwindcss/postcss"));
  type Process = { process(css: string, o: { from: string }): Promise<{ css: string }> };
  const postcss = require(require.resolve("postcss", { paths: [here] })) as (plugins: unknown[]) => Process;
  const tailwind = require("@tailwindcss/postcss") as (o: { base: string }) => unknown;
  const file = fileURLToPath(new URL("../src/app/globals.css", import.meta.url));
  return (await postcss([tailwind({ base: fileURLToPath(new URL("..", import.meta.url)) })]).process(readFileSync(file, "utf8"), { from: file })).css;
}

async function read(db: ReturnType<TestDb["dbAs"]>, workspaceId: string, slug: string): Promise<LanesData> {
  const live = (await loadLiveProcessBySlug(db, slug))!;
  const [parts, company] = await Promise.all([loadLiveParts(db, workspaceId), loadLiveCompanyPart(db, workspaceId)]);
  const [departments, services, links] = await Promise.all([
    db.selectFrom("departments").select(["id", "name", "sort"]).where("workspace_id", "=", workspaceId).orderBy("sort").execute(),
    db.selectFrom("services").select(["id", "department_id", "tier_id"]).where("workspace_id", "=", workspaceId).where("tier_id", "is not", null).execute(),
    db.selectFrom("service_servicing").select(["process_id", "service_id"]).where("workspace_id", "=", workspaceId).execute(),
  ]);
  return JSON.parse(JSON.stringify({ live, parts, company, laneInput: { departments, services, links } })) as LanesData;
}

beforeAll(async () => {
  [script, workers, css] = await Promise.all([
    bundleHarness(new URL("./overview-lanes-harness/entry.tsx", import.meta.url), META),
    Promise.all(["simulate.worker.ts", "absence.worker.ts"].map(async (f) => [f, await bundleHarness(new URL(`../src/workers/${f}`, import.meta.url))] as const)).then(Object.fromEntries),
    appCss(),
  ]);
  tdb = await createTestDb({ seed: false });
  const admin = await createUser(tdb, "admin@q4-lanes.example.com", { agency_admin: true });
  const ws = (await tdb.client.query("insert into workspaces (name, slug) values ('Example agency', 'q4-lanes') returning id")).rows[0].id as string;
  await tdb.client.query("begin");
  const loaded = await loadCapacityExample(tdb.client, ws, "2026-11-02");
  await tdb.client.query(loaded.applied ? "commit" : "rollback");
  expect(loaded.applied).toBe(true);
  data = await read(tdb.dbAs({ ...admin.claims, role: "authenticated" }), ws, "q4-lanes");
  names = Object.fromEntries(data.parts.map((p) => [p.process.id, p.process.name]));
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
}, 300_000);

afterAll(async () => {
  await browser?.close();
  await tdb?.close();
});

async function mount(d: LanesData, scheme: "light" | "dark" = "light"): Promise<{ page: Page; errors: string[] }> {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1400 }, colorScheme: scheme });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.setContent(`<style>${css}</style><div id="root"></div>`);
  await page.evaluate((w) => (window.workerScripts = w), workers);
  await page.addScriptTag({ content: script });
  await page.evaluate((x) => window.mountLanes(x), d);
  await page.waitForSelector("[data-company-map] [data-lane]", { timeout: 60_000 });
  // Every card measured and the map framed.
  await page.waitForTimeout(600);
  return { page, errors };
}

/** For each lane, the names of the process cards whose centre sits inside it. */
async function cardsByLane(page: Page): Promise<Record<string, string[]>> {
  const labelled = await labelsByLane(page);
  const all = Object.values(names);
  // A card's label is "<process name>, group of N steps, ...": the longest process name it starts with.
  const nameOf = (label: string) => all.filter((n) => label.startsWith(`${n}, `)).sort((a, b) => b.length - a.length)[0] ?? label;
  return Object.fromEntries(Object.entries(labelled).map(([lane, list]) => [lane, list.map(nameOf)]));
}

async function labelsByLane(page: Page): Promise<Record<string, string[]>> {
  return page.evaluate(() => {
    const out: Record<string, string[]> = {};
    const lanes = [...document.querySelectorAll<HTMLElement>("[data-company-map] [data-lane]")].map((l) => ({ label: l.dataset.lane!, box: l.getBoundingClientRect() }));
    for (const { label } of lanes) out[label] = [];
    for (const node of document.querySelectorAll<HTMLElement>("[data-company-map] .react-flow__node-group")) {
      const b = node.getBoundingClientRect();
      const cy = b.top + b.height / 2;
      const lane = lanes.find((l) => cy >= l.box.top && cy <= l.box.bottom);
      if (lane) out[lane.label]!.push(node.getAttribute("aria-label") ?? "");
    }
    return out;
  });
}

describe("department lanes on the Overview company map", () => {
  it("shows the lanes in order with each process card in its department's lane", async () => {
    const { page, errors } = await mount(data);
    const labels = await page.locator("[data-company-map] [data-lane]").evaluateAll((els) => els.map((e) => e.getAttribute("data-lane")));
    expect(labels).toEqual(["Sales and whole business", "Organic (SEO)", "Performance"]);

    const lane = await cardsByLane(page);
    const dept = Object.fromEntries(data.laneInput.departments.map((d) => [d.id, d.name]));
    const link = (name: string) => data.laneInput.links.filter((l) => l.process_id === Object.keys(names).find((id) => names[id] === name));
    // The expectation is worked out from the data, not from the screen: a process serving one department's tier services is in it.
    const expected: Record<string, string[]> = { "Sales and whole business": [], "Organic (SEO)": [], Performance: [] };
    for (const [id, name] of Object.entries(names)) {
      const used = new Set(link(name).map((l) => data.laneInput.services.find((s) => s.id === l.service_id)?.department_id).filter(Boolean));
      const where = used.size === 1 ? dept[[...used][0] as string]! : "Sales and whole business";
      expect(id).toBeTruthy();
      expected[where]!.push(name);
    }
    expect(expected["Organic (SEO)"]!.length).toBeGreaterThan(0);
    expect(expected.Performance!.length).toBeGreaterThan(0);
    expect(expected["Sales and whole business"]!.length).toBeGreaterThan(0);
    for (const [label, list] of Object.entries(expected)) expect(lane[label]!.sort()).toEqual(list.sort());
    // Each process card carries a pill with its category, in Q3's words.
    const tags = await page.locator("[data-company-map] [data-process-tag]").allInnerTexts();
    expect(tags).toHaveLength(data.parts.length);
    expect(tags).toContain("Sales");
    expect(tags).toContain("Routine client work");
    expect(errors).toEqual([]);
    await page.close();
  }, 120_000);

  it("moves a card to another lane when its department is changed, and keeps the lanes in Fit", async () => {
    const seoProcess = data.parts.find((p) => data.laneInput.links.some((l) => l.process_id === p.process.id));
    expect(seoProcess).toBeTruthy();
    const target = data.laneInput.departments[1]!;
    const changed: LanesData = {
      ...data,
      parts: data.parts.map((p) => (p.process.id === seoProcess!.process.id ? { ...p, process: { ...p.process, department_id: target.id } } : p)),
    };
    const { page } = await mount(changed);
    expect((await cardsByLane(page))[target.name]).toContain(seoProcess!.process.name);
    await page.close();
    // Put under Sales and whole business on purpose, it leaves its department's lane.
    const pinned: LanesData = {
      ...data,
      parts: data.parts.map((p) => (p.process.id === seoProcess!.process.id ? { ...p, process: { ...p.process, whole_business: true } } : p)),
    };
    const again = await mount(pinned);
    expect((await cardsByLane(again.page))["Sales and whole business"]).toContain(seoProcess!.process.name);
    await again.page.close();
  }, 120_000);

  it("frames every lane when Fit is pressed", async () => {
    // A few processes from each lane, so everything can fit the panel at once (the whole example's column is taller than the panel allows).
    const [first, second] = data.laneInput.departments;
    const dept = (id: string) => data.laneInput.links.filter((l) => l.process_id === id).map((l) => data.laneInput.services.find((s) => s.id === l.service_id)?.department_id);
    const keep = new Set<string>();
    let seo = 0;
    let ppc = 0;
    for (const p of data.parts) {
      const d = dept(p.process.id);
      if (!d.length) keep.add(p.process.id);
      else if (d.every((x) => x === first!.id) && seo++ < 2) keep.add(p.process.id);
      else if (d.every((x) => x === second!.id) && ppc++ < 2) keep.add(p.process.id);
    }
    const { page } = await mount({ ...data, parts: data.parts.filter((p) => keep.has(p.process.id)) });
    await page.getByRole("button", { name: /^Fit/ }).first().click();
    await page.waitForTimeout(500);
    const inside = await page.evaluate(() => {
      const panel = document.querySelector("[data-company-map] .react-flow")!.getBoundingClientRect();
      return [...document.querySelectorAll("[data-company-map] [data-lane]")].map((l) => {
        const b = l.getBoundingClientRect();
        return b.top >= panel.top - 2 && b.bottom <= panel.bottom + 2 && b.left >= panel.left - 2 && b.right <= panel.right + 2;
      });
    });
    expect(inside).toEqual([true, true, true]);
    await page.close();
  }, 120_000);

  it.skipIf(!process.env.Q4_SHOTS)("saves the screenshots", async () => {
    const dir = process.env.Q4_SHOTS!;
    mkdirSync(dir, { recursive: true });
    for (const scheme of ["light", "dark"] as const) {
      const { page } = await mount(data, scheme);
      await page.locator("[data-company-map]").screenshot({ path: `${dir}/overview-company-map-lanes-${scheme}-1440.png` });
      // Fit: the whole map and its lanes at once.
      await page.getByRole("button", { name: /^Fit/ }).first().click();
      await page.waitForTimeout(500);
      await page.locator("[data-company-map]").screenshot({ path: `${dir}/overview-company-map-lanes-fit-${scheme}-1440.png` });
      await page.close();
    }
  }, 120_000);
});
