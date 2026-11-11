import { mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadIssueEvents, loadIssuesForReader, loadProcessBySlug, loadSolutionIssues, loadSolutions, loadSources, type IssueEventRow, type ProcessBundle } from "@transpera-flow/db";
import { loadCapacityExample } from "../../../packages/db/src/fixtures/capacity-example";
import { addExampleIssues } from "../../../packages/db/src/fixtures/capacity-example-issues";
import { createTestDb, createUser, type TestDb } from "../../../packages/db/test/harness";
import { bundleHarness } from "./build-harness";

// Q10, the Issue page on the page kit, in a real browser on the example agency's issues #6 (vetting, with a solution that Works) and #8
// (Ad QA, resolved by an Adopted solution): the header card (title, pills, status dropdown, owners popover, buttons), the map, What's wrong
// edited in place, Solutions tried with a status pill each, and the History timeline. Server Actions are stand-ins that note each call,
// so the checks see what the page asked the server to do. Nothing sideways at 400 px.
// With Q11C_SHOTS=<dir> it also saves the screenshots (issues #6 and #8 at 1440 px light and dark and at 400 px, and the solution header).

const META = { "import.meta.url": JSON.stringify("http://harness.test/src/lib/x/") };
const shots = process.env.Q11C_SHOTS;

async function appCss(): Promise<string> {
  const require = createRequire(import.meta.url);
  const here = dirname(require.resolve("@tailwindcss/postcss"));
  type Process = { process(css: string, o: { from: string }): Promise<{ css: string }> };
  const postcss = require(require.resolve("postcss", { paths: [here] })) as (plugins: unknown[]) => Process;
  const tailwind = require("@tailwindcss/postcss") as (o: { base: string }) => unknown;
  const file = fileURLToPath(new URL("../src/app/globals.css", import.meta.url));
  return (await postcss([tailwind({ base: fileURLToPath(new URL("..", import.meta.url)) })]).process(readFileSync(file, "utf8"), { from: file })).css;
}

let browser: Browser;
let tdb: TestDb;
let script: string;
let css: string;
let workers: Record<string, string>;
let data: unknown;
let vettingSolutionId = "";

beforeAll(async () => {
  tdb = await createTestDb({ supabaseDefaultPrivileges: true });
  const owner = await createUser(tdb, "owner@q10.example.com", { agency_admin: true });
  const ws = (await tdb.client.query("insert into workspaces (name, slug) values ('Example agency', 'example') returning id")).rows[0].id as string;
  await tdb.client.query("update workspaces set settings = coalesce(settings, '{}'::jsonb) || '{\"currency\":\"GBP\"}'::jsonb where id = $1", [ws]);
  await tdb.client.query("begin");
  await loadCapacityExample(tdb.client, ws, "2026-11-02");
  const added = await addExampleIssues(tdb.client, ws);
  expect(added.applied).toBe(true);
  await tdb.client.query("commit");
  const db = tdb.dbAs({ sub: owner.id, role: "authenticated", app_metadata: { agency_admin: true } });
  const issues = await loadIssuesForReader(db, ws);
  const processIds = [...new Set(issues.flatMap((i) => i.links.flatMap((l) => (l.process_id ? [l.process_id] : []))))];
  const bundles: Record<string, ProcessBundle> = {};
  for (const id of processIds) bundles[id] = (await loadProcessBySlug(db, "example", { draft: false, processId: id }))!.live as ProcessBundle;
  const events: Record<string, IssueEventRow[]> = {};
  for (const i of issues) events[i.id] = await loadIssueEvents(db, ws, i.id);
  const [solutions, links] = await Promise.all([loadSolutions(db, ws), loadSolutionIssues(db, ws)]);
  vettingSolutionId = solutions.find((s) => s.name === "Vetting by a second person")!.id;
  data = {
    bundles,
    processes: (await tdb.client.query("select id, name from processes where workspace_id = $1 and not is_company", [ws])).rows,
    issues,
    events,
    solutions: { solutions, links },
    sources: await loadSources(db, ws),
    workspaceId: ws,
  };
  [script, css, workers] = await Promise.all([
    // The URL stand-in: the Solutions list keeps its filters in the URL.
    bundleHarness(new URL("./q11c-harness/entry.tsx", import.meta.url), META, { navigation: "navigation-url.ts" }),
    appCss(),
    Promise.all(["simulate.worker.ts", "absence.worker.ts", "issue-costs.worker.ts", "shadow-price.worker.ts", "projection.worker.ts"].map(async (f) => [f, await bundleHarness(new URL(`../src/workers/${f}`, import.meta.url))] as const)).then(Object.fromEntries),
  ]);
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
}, 300_000);

afterAll(async () => {
  await browser?.close();
  await tdb?.close();
});

async function open(o: { call: string; arg: object; width?: number; scheme?: "light" | "dark"; ready: string }): Promise<{ page: Page; errors: string[] }> {
  const page = await browser.newPage({ viewport: { width: o.width ?? 1440, height: 1000 }, colorScheme: o.scheme ?? "light" });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const polyfill = () => {
    if (!crypto.randomUUID) (crypto as { randomUUID: () => string }).randomUUID = () => "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) => (Number(c) ^ (crypto.getRandomValues(new Uint8Array(1))[0]! & (15 >> (Number(c) / 4)))).toString(16));
  };
  await page.setContent(`<style>${css}</style><div id="root"></div>`);
  await page.evaluate(polyfill);
  await page.evaluate(([w, d]) => ((window.workerScripts = w as never), (window.q11cData = d as never)), [workers, data] as const);
  await page.addScriptTag({ content: script });
  await page.evaluate(([call, arg]) => (window as never as Record<string, (a: unknown) => void>)[call as string]!(arg), [o.call, o.arg] as const);
  await page.waitForSelector(o.ready, { timeout: 120_000 });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(800);
  return { page, errors };
}




const WIDTHS = [
  [1440, "light"],
  [1440, "dark"],
  [400, "light"],
] as const;

/** Every page this package touches: the name its screenshots have, what to mount and what shows it is drawn. */
const PAGES = (): { name: string; call: string; arg: object; ready: string }[] => [
  { name: "solutions-list", call: "q11cMountSolutions", arg: { editor: true }, ready: "[data-solutions-list]" },
  { name: "solutions-empty", call: "q11cMountSolutions", arg: { editor: true, empty: true }, ready: "[data-solutions-list]" },
  { name: "solution-page", call: "q11cMountSolution", arg: { id: vettingSolutionId, editor: true }, ready: "[data-map-side]" },
  { name: "blocks-library", call: "q11cMountBlocks", arg: { mode: "demo" }, ready: "[data-block]" },
  { name: "blocks-empty", call: "q11cMountBlocks", arg: { mode: "readonly" }, ready: "[data-testid=blocks-empty]" },
  { name: "history-process", call: "q11cMountHistory", arg: { editor: true }, ready: "[data-version]" },
  { name: "history-empty", call: "q11cMountHistory", arg: { editor: true, empty: true }, ready: "[data-empty=versions]" },
  { name: "history-company", call: "q11cMountHistory", arg: { editor: true, company: true }, ready: "[data-version]" },
  { name: "issue-6", call: "q11cMountIssue", arg: { number: 6, editor: true }, ready: "[data-testid=issue-header]" },
  { name: "other-improvements-empty", call: "q11cMountOther", arg: {}, ready: "[data-testid=solutions-empty]" },
  { name: "sources", call: "q11cMountSources", arg: { editor: true }, ready: "[data-source-row]" },
];


const pageOf = (name: string, o: { editor?: boolean; width?: number; scheme?: "light" | "dark" } = {}) => {
  const p = PAGES().find((x) => x.name === name)!;
  return open({ call: p.call, arg: { ...p.arg, ...(o.editor === undefined ? {} : { editor: o.editor }) }, width: o.width, scheme: o.scheme, ready: p.ready });
};

describe("Solutions list", () => {
  it("has a header card, a toolbar and a row per solution with its status pill", async () => {
    const { page, errors } = await pageOf("solutions-list");
    const header = page.locator("[data-testid=solutions-header]");
    expect(await header.locator("h1").innerText()).toBe("Solutions");
    expect(await header.locator("[data-solutions-count]").innerText()).toBe("16 solutions"); // the 3 the example has by hand and the 13 that hold its changes (D53)
    expect(await header.locator("[data-page-actions]").getByText("✎ New solution").count()).toBe(1);
    expect(await page.locator("[role=toolbar] [data-toolbar-search]").count()).toBe(1);
    expect(await page.locator("[data-filter=status]").count()).toBe(1);
    expect(await page.locator("[data-filter=process]").count()).toBe(1);
    expect(await page.locator("[data-filter=issue]").count()).toBe(1);
    const cards = page.locator("[data-testid=solution-row]");
    expect(await cards.count()).toBe(16);
    const pills = await cards.evaluateAll((els) => els.map((e) => e.querySelector("[data-status]")?.getAttribute("data-status")));
    expect(pills).not.toContain(undefined);
    expect(pills).toContain("works");
    expect(errors).toEqual([]);
    await page.close();
  }, 300_000);

  it("filters by status, by process and by search, and says so when nothing matches", async () => {
    const { page } = await pageOf("solutions-list");
    await page.locator("[data-filter=status]").click();
    await page.locator("[data-filter-menu=status] [data-option=works]").check();
    await page.keyboard.press("Escape");
    expect(await page.locator("[data-testid=solution-row]").count()).toBe(1);
    expect(await page.locator("[data-testid=solution-row]").innerText()).toContain("Vetting by a second person");
    await page.locator("[data-clear-filters]").click();
    expect(await page.locator("[data-testid=solution-row]").count()).toBe(16);
    await page.getByRole("searchbox", { name: "Search solutions" }).fill("budget");
    expect(await page.locator("[data-testid=solution-row]").count()).toBe(1);
    await page.getByRole("searchbox", { name: "Search solutions" }).fill("zzzz");
    expect(await page.locator("[data-testid=solutions-empty][data-filtered]").innerText()).toContain("No solutions match these filters.");
    await page.locator("[data-testid=solutions-empty] [data-clear-filters]").click();
    expect(await page.locator("[data-testid=solution-row]").count()).toBe(16);
    await page.locator("[data-filter=process]").click();
    const first = page.locator("[data-filter-menu=process] input[type=checkbox]").first();
    await first.check();
    expect(await page.locator("[data-testid=solution-row]").count()).toBeLessThan(16);
    await page.close();
  }, 300_000);

  it("a reader gets no New solution button, and a list with nothing in it gets an empty state, not a dashed box", async () => {
    const reader = await pageOf("solutions-list", { editor: false });
    expect(await reader.page.getByText("✎ New solution").count()).toBe(0);
    await reader.page.close();
    const { page } = await pageOf("solutions-empty");
    const empty = page.locator("[data-testid=solutions-empty]");
    expect(await empty.innerText()).toContain("No solutions yet");
    expect(await empty.evaluate((e) => getComputedStyle(e).borderStyle)).not.toBe("dashed");
    expect(await page.locator("[role=toolbar]").count()).toBe(0);
    await page.close();
  }, 300_000);
});

describe("Solution page", () => {
  it("is the header, the notes and the two maps, in reading order, with live above the solution", async () => {
    const { page, errors } = await pageOf("solution-page");
    const ids = await page.locator("[data-solution-page] [id][data-section]").evaluateAll((els) => els.map((e) => e.id));
    expect(ids).toEqual(["notes", "maps"]);
    expect(await page.locator("[data-change-lines]").count()).toBe(0);
    expect(await page.locator("#maps [data-map-side]").count()).toBe(2);
    const [live, solved] = await Promise.all(["live", "solution"].map((id) => page.locator(`#maps [data-map-side="${id}"]`).boundingBox()));
    expect(solved!.y).toBeGreaterThan(live!.y + live!.height - 1);
    // The measures, the revenue chart and the stress test are gone from the page.
    for (const gone of ["#measures", "#mrr", "#stress", "[data-measure]", "[data-solves-card]"]) expect(await page.locator(gone).count(), gone).toBe(0);
    for (const id of ids) expect(await page.locator(`#${id} [role=heading][aria-level="2"]`).count()).toBe(1);
    expect(errors).toEqual([]);
    await page.close();
  }, 300_000);

  it("names the issue it fixes in the header, with Open in editor, when it was edited, and no Adopt (D55) or Sandbox button", async () => {
    const { page } = await pageOf("solution-page");
    expect(await page.locator("[data-solution-issues] [data-solves]").count()).toBe(1);
    const actions = page.locator("[data-testid=solution-header] [data-page-actions]");
    expect(await actions.locator("[data-open-in-editor]").innerText()).toContain("Open in editor");
    expect(await page.locator("[data-try-in-sandbox]").count()).toBe(0);
    expect(await page.locator("[data-solution-rail] [data-edited]").innerText()).toMatch(/^\d{1,2} [A-Z][a-z]{2}/);
    expect(await page.locator("[data-built]").count()).toBe(0);
    expect(await page.locator("[data-adopt]").count()).toBe(0);
    await page.close();
  }, 300_000);

  it("a reader gets no Open in editor", async () => {
    const { page } = await pageOf("solution-page", { editor: false });
    expect(await page.locator("[data-open-in-editor], [data-adopt]").count()).toBe(0);
    await page.close();
  }, 300_000);
});

describe("Block library", () => {
  it("has a header card and a list with a row per block: Open, Edit, a menu, and the real map when opened", async () => {
    const { page, errors } = await pageOf("blocks-library");
    const header = page.locator("[data-testid=blocks-header]");
    expect(await header.locator("h1").innerText()).toBe("Block library");
    expect(await header.locator("[data-page-actions] [data-new-block]").innerText()).toBe("+ New block");
    const rows = page.locator("tr[data-block]");
    expect(await rows.count()).toBeGreaterThan(1);
    expect(await header.locator("[data-blocks-count]").innerText()).toBe(`${await rows.count()} blocks`);
    const first = rows.first();
    expect(await first.locator("[data-used-in], td[data-block-used]").first().innerText()).toMatch(/^\d+ solutions?$/);
    expect(await first.locator("[data-block-edit]").count()).toBe(1);
    expect(await first.locator("[data-block-menu]").count()).toBe(1);
    expect(await page.locator("[data-block-panel]").count()).toBe(0);
    await first.locator("[data-block-open]").click();
    const panel = page.locator("[data-block-panel]");
    await panel.locator(".react-flow__node[data-id]").first().waitFor({ timeout: 60_000 });
    expect(await panel.locator(".react-flow__node[data-id]").count()).toBeGreaterThan(0);
    expect(await panel.locator("[data-block-map], [data-block-steps], [data-block-step]").count()).toBe(0);
    expect(errors).toEqual([]);
    await page.close();
  }, 300_000);

  it("searches the list and the menu offers Rename, Duplicate and Delete", async () => {
    const { page } = await pageOf("blocks-library");
    const before = await page.locator("tr[data-block]").count();
    await page.getByLabel("Search blocks").fill("sign-off");
    expect(await page.locator("tr[data-block]").count()).toBe(1);
    await page.getByLabel("Search blocks").fill("");
    await page.locator("[data-block-menu]").first().click();
    expect(await page.getByRole("menuitem").allInnerTexts()).toEqual(["Rename…", "Duplicate", "Delete…"]);
    await page.getByRole("menuitem", { name: "Duplicate" }).click();
    await page.waitForFunction((n) => document.querySelectorAll("tr[data-block]").length === n + 1, before);
    expect(await page.locator("[data-block-name]", { hasText: "(copy)" }).count()).toBe(1);
    await page.close();
  }, 300_000);

  it("a reader with no blocks sees an empty state and no New block button", async () => {
    const { page } = await pageOf("blocks-empty");
    expect(await page.locator("[data-testid=blocks-empty]").innerText()).toContain("No blocks yet");
    expect(await page.getByText("✎ New block").count()).toBe(0);
    expect(await page.locator("[data-testid=blocks-header] [data-meta-line]").innerText()).toContain("You can look at the library but not change it.");
    await page.close();
  }, 300_000);
});

describe("History pages", () => {
  it("the process history is a header and a master-detail: the versions on the left, the chosen one on the right", async () => {
    const { page, errors } = await pageOf("history-process");
    expect(await page.locator("[data-testid=history-header] h1").innerText()).toBe("Sales history");
    expect(await page.locator("[data-testid=history-header] [data-meta-line]").innerText()).toMatch(/^6 versions\s*·\s*Live is version 6$/);
    expect(await page.locator("#versions").getByRole("heading", { level: 2 }).innerText()).toMatch(/^Versions$/i);
    const rows = page.locator("#versions li[data-version]");
    expect(await rows.count()).toBe(6);
    expect(await rows.first().locator("[data-status]").count()).toBe(0);
    expect(await rows.first().innerText()).toContain("Live");
    expect(await rows.nth(3).innerText()).toContain("Claude (MCP)");
    expect(await rows.last().innerText()).toContain("First version");
    expect(await page.locator("#versions table").count()).toBe(0);
    // The newest (live) is chosen to start with: no View, no Restore.
    const detail = page.locator("[data-version-detail]");
    expect(await detail.getAttribute("data-version-detail")).toBe("6");
    expect(await detail.getByRole("link", { name: "View" }).count()).toBe(0);
    expect(await detail.getByRole("button", { name: "Restore" }).count()).toBe(0);
    // Choosing v5 shows its buttons.
    await rows.nth(1).getByRole("button").click();
    expect(await rows.nth(1).getByRole("button").getAttribute("aria-current")).toBe("true");
    expect(await detail.getAttribute("data-version-detail")).toBe("5");
    expect(await detail.getByRole("link", { name: "View" }).getAttribute("href")).toBe("/w/example/p/x?version=5");
    expect(await detail.getByRole("button", { name: "Restore" }).count()).toBe(1);
    expect(await detail.getByRole("button", { name: "Duplicate" }).count()).toBe(1);
    expect(errors).toEqual([]);
    await page.close();
  }, 300_000);

  it("the company map history keeps what-changed and the Version help", async () => {
    const { page } = await pageOf("history-company");
    expect(await page.locator("[data-testid=history-header] h1").innerText()).toBe("Company map history");
    expect(await page.locator("#versions li[data-version]").count()).toBe(7);
    // Each row says what changed, and so does the chosen version.
    expect(await page.locator("#versions [data-what-changed]").count()).toBe(7);
    expect(await page.locator("[data-version-detail] [data-what-changed]").count()).toBe(1);
    await page.close();
  }, 300_000);

  it("a process never published gets an empty state", async () => {
    const { page } = await pageOf("history-empty");
    expect(await page.locator("[data-empty=versions]").innerText()).toContain("hasn't been published yet");
    await page.close();
  }, 300_000);
});

describe("Issue page, its main column, rail and the map card", () => {
  it("its rail holds the metadata only: the target and the sources sit in What's wrong (QA round 2)", async () => {
    const { page, errors } = await pageOf("issue-6");
    expect(await page.locator("[data-issue-page] aside").count()).toBe(1);
    expect(await page.locator("#target, aside #sources, aside [data-issue-sources]").count()).toBe(0);
    expect(await page.locator("#wrong [role=heading][aria-level='2']").innerText()).toMatch(/^What's wrong and sources/);
    expect(await page.locator("#wrong [data-issue-sources] [data-edit-entry]").count()).toBeGreaterThan(0);
    expect(errors).toEqual([]);
    await page.close();
  }, 300_000);

  it("a short map's card is cut to the map, with no band of empty space, and moving the map lifts the cut", async () => {
    const { page } = await pageOf("issue-6");
    const host = page.locator("#where [data-map-cut]");
    await host.waitFor();
    const box = (await host.boundingBox())!;
    expect(box.height).toBeLessThan(250);
    const gap = await host.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const bottoms = [...el.querySelectorAll(".react-flow__node")].map((n) => n.getBoundingClientRect().bottom);
      return { gap: r.bottom - Math.max(...bottoms), top: Math.min(...[...el.querySelectorAll(".react-flow__node")].map((n) => n.getBoundingClientRect().top)) - r.top };
    });
    expect(gap.gap).toBeGreaterThanOrEqual(0);
    expect(gap.gap).toBeLessThan(40);
    await host.hover();
    await page.mouse.wheel(0, 10);
    await page.waitForFunction(() => !document.querySelector("#where [data-map-cut]"));
    await page.close();
  }, 300_000);
});

describe("Other improvements", () => {
  it("nothing else yet is an empty state, not a dashed box", async () => {
    const { page } = await pageOf("other-improvements-empty");
    const empty = page.locator("[data-testid=solutions-empty]");
    expect(await empty.innerText()).toBe("Nothing else yet. Every solution here is for an issue above.");
    expect(await empty.evaluate((e) => getComputedStyle(e).borderStyle)).not.toBe("dashed");
    expect(await empty.locator("svg").count()).toBe(1);
    await page.close();
  }, 300_000);
});

describe("Sources page", () => {
  it("has a header with Add source, and the library flat on the page: a toolbar and one table, no card", async () => {
    const { page, errors } = await pageOf("sources");
    const header = page.locator("[data-testid=sources-header]");
    expect(await header.locator("h1").innerText()).toBe("Sources");
    expect(await header.locator("[data-page-actions]").getByRole("button", { name: "+ Add source" }).count()).toBe(1);
    expect(await page.locator("#library [data-slot=card]").count()).toBe(0);
    expect(await page.locator("#library [data-list-toolbar]").count()).toBe(1);
    expect(await page.locator("#library [data-source-row]").count()).toBeGreaterThan(2);
    expect(errors).toEqual([]);
    await page.close();
  }, 300_000);

  it("a reader has no Add source button", async () => {
    const { page } = await pageOf("sources", { editor: false });
    expect(await page.getByRole("button", { name: "+ Add source" }).count()).toBe(0);
    await page.close();
  }, 300_000);
});

describe("nothing scrolls sideways at 400 px", () => {
  it("on every page of this package", async () => {
    for (const p of PAGES()) {
      const { page } = await pageOf(p.name, { width: 400 });
      const widths = await page.evaluate(() => ({ page: document.documentElement.scrollWidth, view: document.documentElement.clientWidth }));
      expect(widths.page, p.name).toBeLessThanOrEqual(widths.view);
      await page.close();
    }
  }, 900_000);
});

describe("screenshots", () => {
  it.skipIf(!shots)("saves the screenshots", async () => {
    mkdirSync(shots!, { recursive: true });
    const only = process.env.Q11C_ONLY?.split(",");
    for (const p of PAGES().filter((x) => !only || only.includes(x.name))) {
      for (const [width, scheme] of WIDTHS) {
        const { page } = await open({ call: p.call, arg: p.arg, width, scheme, ready: p.ready });
        await page.setViewportSize({ width, height: Math.min(await page.evaluate(() => document.documentElement.scrollHeight), 4000) });
        await page.waitForTimeout(600);
        await page.screenshot({ path: `${shots}/${p.name}-${scheme}-${width}.png` });
        await page.close();
      }
    }
  }, 1_200_000);
});
