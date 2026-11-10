import { mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadBlocks, loadProcessBySlug, loadSolutions, type BlockRow, type ProcessBundle } from "@transpera-flow/db";
import { loadCapacityExample } from "../../../packages/db/src/fixtures/capacity-example";
import { addExampleBlocks } from "../../../packages/db/src/fixtures/capacity-example-blocks";
import { addExampleIssues } from "../../../packages/db/src/fixtures/capacity-example-issues";
import { createTestDb, createUser, type TestDb } from "../../../packages/db/test/harness";
import { blockUsers } from "@/lib/blocks/rows";
import { bundleHarness } from "./build-harness";

// Q15: the Block library as a list, and the Editor editing a block, in a real browser on the example agency's four blocks (one of them
// used by a solution). Server Actions are stand-ins that note each call, so the checks see what the page asked the server to do.
// With Q15_SHOTS=<dir> it also saves the screenshots (the list, an expanded row, the menu and the Editor, at 1440 px light and dark and at 400 px).

const META = { "import.meta.url": JSON.stringify("http://harness.test/src/lib/x/") };
const shots = process.env.Q15_SHOTS;

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
let data: { blocks: BlockRow[] };
let approval: BlockRow;

beforeAll(async () => {
  tdb = await createTestDb({ supabaseDefaultPrivileges: true });
  const owner = await createUser(tdb, "owner@q15.example.com", { agency_admin: true });
  const ws = (await tdb.client.query("insert into workspaces (name, slug) values ('Example agency', 'example') returning id")).rows[0].id as string;
  await tdb.client.query("update workspaces set settings = coalesce(settings, '{}'::jsonb) || '{\"currency\":\"GBP\"}'::jsonb where id = $1", [ws]);
  await tdb.client.query("begin");
  await loadCapacityExample(tdb.client, ws, "2026-11-02");
  expect((await addExampleIssues(tdb.client, ws)).applied).toBe(true);
  await tdb.client.query("delete from blocks where workspace_id = $1", [ws]);
  expect((await addExampleBlocks(tdb.client, ws)).applied).toBe(true);
  await tdb.client.query("commit");
  const db = tdb.dbAs({ sub: owner.id, role: "authenticated", app_metadata: { agency_admin: true } });
  const blocks = await loadBlocks(db, ws);
  approval = blocks.find((b) => b.name === "Client approval loop")!;
  const solutions = await loadSolutions(db, ws);
  const roles = (await tdb.client.query("select id, name, color from roles where workspace_id = $1 order by name", [ws])).rows;
  const processId = (await tdb.client.query("select id from processes where workspace_id = $1 and not is_company order by name limit 1", [ws])).rows[0].id as string;
  const bundle = (await loadProcessBySlug(db, "example", { draft: false, processId }))!.live as ProcessBundle;
  data = { blocks, users: blockUsers(solutions), roles, workspaceId: ws, bundle } as never;
  [script, css, workers] = await Promise.all([
    bundleHarness(new URL("./q15-harness/entry.tsx", import.meta.url), META),
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
  const page = await browser.newPage({ viewport: { width: o.width ?? 1440, height: 1000 }, colorScheme: o.scheme ?? "light", deviceScaleFactor: shots ? 2 : 1 });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.setContent(`<style>${css}</style><div id="root"></div>`);
  // A page set from a string isn't a secure context, so it has no crypto.randomUUID.
  await page.evaluate(() => {
    if (!crypto.randomUUID) (crypto as { randomUUID: () => string }).randomUUID = () => "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) => (Number(c) ^ (crypto.getRandomValues(new Uint8Array(1))[0]! & (15 >> (Number(c) / 4)))).toString(16));
  });
  await page.evaluate(([w, d]) => ((window.workerScripts = w as never), (window.q15Data = d as never)), [workers, data] as const);
  await page.addScriptTag({ content: script });
  await page.evaluate(([call, arg]) => (window as never as Record<string, (a: unknown) => void>)[call as string]!(arg), [o.call, o.arg] as const);
  await page.waitForSelector(o.ready, { timeout: 60_000 }).catch(async (e) => {
    throw new Error(`${e.message}\n${errors.join("\n")}\n${(await page.locator("body").innerText()).slice(0, 600)}`);
  });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(800);
  return { page, errors };
}

const library = (o: { width?: number; scheme?: "light" | "dark"; editor?: boolean; empty?: boolean; base?: "ok" | "none" | "fail" | "fail-once" } = {}) =>
  open({ call: "q15MountLibrary", arg: { editor: o.editor ?? true, empty: o.empty, base: o.base }, width: o.width, scheme: o.scheme, ready: o.empty ? "[data-testid=blocks-empty]" : "tr[data-block]" });
const editor = (o: { width?: number; scheme?: "light" | "dark" } = {}) =>
  open({ call: "q15MountEditor", arg: { blockId: approval.id }, width: o.width, scheme: o.scheme, ready: o.width && o.width < 640 ? "[data-phone-gate]" : ".react-flow__node" });

const SIZES = [
  [1440, "light"],
  [1440, "dark"],
  [400, "light"],
] as const;

const rowOf = (page: Page, name: string) => page.locator("tr[data-block]", { has: page.locator("[data-block-name]", { hasText: new RegExp(`^${name}$`) }) });

describe("Block library list", () => {
  it("is a table with one row per block, the columns in order, and the numbers worked out from the steps", async () => {
    const { page, errors } = await library();
    expect(await page.locator("tr[data-block]").count()).toBe(4);
    const heads = (await page.locator("thead th").allInnerTexts()).map((t) => t.replace(/\s+/g, " ").trim());
    const names = ["Block", "Steps", "Who does it", "Time per run", "Automatable", "Used in", "Updated"];
    expect(heads.filter(Boolean).map((h, i) => h.startsWith(names[i]!))).toEqual(names.map(() => true));
    expect(heads.filter(Boolean)).toHaveLength(names.length);
    const row = rowOf(page, "Client approval loop");
    expect(await row.locator("[data-block-line]").innerText()).toMatch(/^Send the plan to the client/);
    expect(await row.locator("[data-block-steps-count]").innerText()).toBe("3");
    expect(await row.locator("[data-block-time]").innerText()).toBe("2 h");
    expect(await row.locator("[data-role-pill]").count()).toBeGreaterThan(0);
    expect(await row.locator("td[data-block-used]").innerText()).toBe("1 solution");
    expect(await rowOf(page, "Monthly report").locator("td[data-block-used]").innerText()).toBe("0 solutions");
    expect(await row.locator("[data-block-updated]").innerText()).toMatch(/today|ago|yesterday/);
    // Numbers right-aligned; the Block column is not.
    expect(await row.locator("[data-block-steps-count]").evaluate((e) => getComputedStyle(e).textAlign)).toBe("right");
    expect(await row.locator("[data-block-name]").evaluate((e) => getComputedStyle(e.closest("td")!).textAlign)).not.toBe("center");
    // Dropped: the type, the creator, the long description and the step list.
    expect(await page.locator("li[data-block], [data-block-steps], [data-block-step]").count()).toBe(0);
    expect(errors).toEqual([]);
    await page.close();
  }, 300_000);

  it("Open shows the real map, read-only, with no step list; Edit goes to the block's Editor; the usage opens a list of links", async () => {
    const { page } = await library();
    const row = rowOf(page, "Client approval loop");
    await row.locator("[data-block-open]").click();
    const panel = page.locator("[data-block-panel]");
    await panel.locator(".react-flow__node[data-id]").first().waitFor();
    expect(await panel.locator(".react-flow__node[data-id]").count()).toBe(3);
    expect(await panel.locator(".react-flow__edge").count()).toBeGreaterThan(0);
    expect(await panel.locator("[data-block-map], [data-block-steps], [data-block-step]").count()).toBe(0);
    await row.locator("[data-block-open]").click();
    expect(await page.locator("[data-block-panel]").count()).toBe(0);
    expect(await row.locator("[data-block-edit]").getAttribute("href")).toBe(`/w/example/p/x/edit?mode=block&block=${approval.id}&from=%2Fw%2Fexample%2Fblocks`);
    await row.locator("[data-used-in]").click();
    const link = page.locator(`[data-used-in-list="${approval.id}"] a`);
    expect(await link.innerText()).toBe("One approval loop for monthly plans");
    expect(await link.getAttribute("href")).toMatch(/^\/w\/example\/solutions\/[0-9a-f-]{36}$/);
    await page.close();
  }, 300_000);

  it("with no process to draw on, an opened row keeps the small picture of its steps", async () => {
    const { page } = await library({ base: "none" });
    await rowOf(page, "Client approval loop").locator("[data-block-open]").click();
    const panel = page.locator("[data-block-panel]");
    expect(await panel.locator("[data-block-map]").count()).toBe(1);
    expect(await panel.locator(".react-flow__node").count()).toBe(0);
    await page.close();
  }, 300_000);

  it("when the map can't be loaded, an opened row says so", async () => {
    const { page } = await library({ base: "fail" });
    await rowOf(page, "Client approval loop").locator("[data-block-open]").click();
    const alert = page.locator("[data-block-panel] [role=alert]");
    await alert.waitFor();
    expect(await alert.innerText()).toBe("Couldn't load the map. Close the row and open it again.");
    expect(await page.locator("[data-block-panel] .react-flow__node").count()).toBe(0);
    await page.close();
  }, 300_000);

  it("after a failed load, closing the row and opening it again tries again", async () => {
    const { page } = await library({ base: "fail-once" });
    const row = rowOf(page, "Client approval loop");
    await row.locator("[data-block-open]").click();
    await page.locator("[data-block-panel] [role=alert]").waitFor();
    await row.locator("[data-block-open]").click();
    await row.locator("[data-block-open]").click();
    await page.locator("[data-block-panel] .react-flow__node[data-id]").first().waitFor();
    expect(await page.locator("[data-block-panel] .react-flow__node[data-id]").count()).toBe(3);
    await page.close();
  }, 300_000);

  it("searches, filters by who does it, and the menu holds Rename, Duplicate and Delete", async () => {
    const { page } = await library();
    await page.getByLabel("Search blocks").fill("report");
    expect(await page.locator("tr[data-block]").count()).toBe(1);
    await page.getByLabel("Search blocks").fill("");
    await page.locator("[data-filter='who does it']").click();
    const first = page.locator("[data-filter-menu='who does it'] input[type=checkbox]").first();
    await first.check();
    await page.keyboard.press("Escape");
    const n = await page.locator("tr[data-block]").count();
    expect(n).toBeGreaterThan(0);
    expect(n).toBeLessThan(5);
    await page.locator("[data-clear-filters]").first().click();
    expect(await page.locator("tr[data-block]").count()).toBe(4);
    await page.getByLabel("Search blocks").fill("zzzz");
    expect(await page.locator("[data-testid=blocks-no-match]").innerText()).toContain("No blocks match");
    await page.getByLabel("Search blocks").fill("");
    await rowOf(page, "Monthly report").locator("[data-block-menu]").click();
    expect(await page.getByRole("menuitem").allInnerTexts()).toEqual(["Rename…", "Duplicate", "Delete…"]);
    await page.close();
  }, 300_000);

  it("asks the server to rename, duplicate and delete, and refuses a delete while a solution uses the block", async () => {
    const { page } = await library();
    await rowOf(page, "Monthly report").locator("[data-block-menu]").click();
    await page.getByRole("menuitem", { name: "Duplicate" }).click();
    await rowOf(page, "Link vetting pair").locator("[data-block-menu]").click();
    await page.getByRole("menuitem", { name: "Rename…" }).click();
    await page.getByLabel("Block name").fill("Vetting duo");
    await page.getByRole("button", { name: "Save" }).click();
    await page.locator("[role=dialog] [role=alert]").waitFor();
    await page.getByRole("button", { name: "Cancel" }).click();
    await rowOf(page, "Client approval loop").locator("[data-block-menu]").click();
    await page.getByRole("menuitem", { name: "Delete…" }).click();
    const dialog = page.locator("[data-block-dialog=delete]");
    expect(await dialog.locator("[data-delete-refused]").innerText()).toContain("Used in 1 solution: “One approval loop for monthly plans”.");
    expect(await dialog.getByRole("button", { name: "Delete", exact: true }).count()).toBe(0);
    await dialog.locator("button:not([data-slot=dialog-close])", { hasText: "Close" }).click();
    await rowOf(page, "Monthly report").locator("[data-block-menu]").click();
    await page.getByRole("menuitem", { name: "Delete…" }).click();
    await page.locator("[data-block-dialog=delete]").getByRole("button", { name: "Delete", exact: true }).click();
    await page.waitForFunction(() => (window.__serverActions ?? []).some((a) => a.name === "deleteBlock"));
    const calls = await page.evaluate(() => window.__serverActions!.map((a) => a.name));
    expect(calls).toEqual(["duplicateBlock", "renameBlock", "deleteBlock"]);
    await page.close();
  }, 300_000);

  it("a reader sees the list without Edit, the menu or New block", async () => {
    const { page } = await library({ editor: false });
    expect(await page.locator("tr[data-block]").count()).toBe(4);
    expect(await page.locator("[data-block-edit], [data-block-menu], [data-new-block]").count()).toBe(0);
    expect(await page.locator("[data-block-open]").count()).toBe(4);
    await page.close();
  }, 300_000);

  it("keeps Q11c's empty state", async () => {
    const { page } = await library({ empty: true });
    expect(await page.locator("[data-testid=blocks-empty]").innerText()).toContain("No blocks yet");
    await page.close();
  }, 300_000);

  it("has nothing sideways at 400 px", async () => {
    const { page } = await library({ width: 400 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.close();
  }, 300_000);
});

describe("The Editor editing a block", () => {
  it("opens seeded with the block's name, description and steps, says it is an edit, and Save changes asks the server to update that block", async () => {
    const { page, errors } = await editor();
    expect(await page.locator("h1").innerText()).toBe("Edit block");
    expect(await page.getByPlaceholder("Block name").inputValue()).toBe("Client approval loop");
    expect(await page.getByPlaceholder(/What it does/).inputValue()).toMatch(/^Send the plan to the client/);
    expect(await page.locator(".react-flow__node[data-id]").count()).toBe(3);
    expect(await page.getByRole("button", { name: "Cancel" }).count()).toBe(1);
    await page.getByPlaceholder("Block name").fill("Client approval loop v2");
    await page.getByRole("button", { name: "Save changes" }).click();
    await page.waitForFunction(() => (window.__serverActions ?? []).some((a) => a.name === "updateBlock"));
    const call = await page.evaluate(() => window.__serverActions!.find((a) => a.name === "updateBlock")!.args as unknown[]);
    expect(call[1]).toBe(approval.id);
    expect(call[2]).toMatchObject({ name: "Client approval loop v2", bundle: { steps: expect.any(Array), edges: expect.any(Array) } });
    expect(((call[2] as { bundle: { steps: { id: string }[] } }).bundle.steps).map((s) => s.id).sort()).toEqual((approval.steps as { steps: { id: string }[] }).steps.map((s) => s.id).sort());
    expect(errors).toEqual([]);
    await page.close();
  }, 300_000);

  it("shows the phone notice instead of the Editor at 400 px", async () => {
    const { page } = await editor({ width: 400 });
    expect(await page.locator("[data-phone-gate]").innerText()).toContain("Editing needs a wider screen");
    await page.close();
  }, 300_000);
});

describe.skipIf(!shots)("screenshots", () => {
  for (const [width, scheme] of SIZES) {
    it(`takes them at ${width} px, ${scheme}`, async () => {
      mkdirSync(shots!, { recursive: true });
      const file = (name: string) => `${shots}/${name}-${scheme}-${width}.png`;
      const list = await library({ width, scheme });
      await list.page.screenshot({ path: file("list"), fullPage: true });
      await rowOf(list.page, "Client approval loop").locator("[data-block-open]").click();
      await list.page.locator("[data-block-panel]").waitFor();
      await list.page.locator(".react-flow__node[data-id]").first().waitFor();
      await list.page.waitForTimeout(800);
      await list.page.screenshot({ path: file("row-open"), fullPage: true });
      await list.page.locator("[data-block-open]").first().click();
      // Editing, and so the menu, is for a tablet or computer: a phone has neither.
      if (width >= 640) {
        await list.page.locator("[data-block-menu]").first().click();
        await list.page.getByRole("menu").waitFor();
        await list.page.screenshot({ path: file("menu") });
      }
      await list.page.close();
      const ed = await editor({ width, scheme });
      await ed.page.waitForTimeout(500);
      await ed.page.screenshot({ path: file("editor") });
      await ed.page.close();
    }, 300_000);
  }
});
