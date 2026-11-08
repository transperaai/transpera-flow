import { mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser } from "playwright-core";
import { afterAll, beforeAll, describe, it } from "vitest";
import { listProcesses, loadCapacitySetup, loadIssuesForReader, loadProcessBySlug, type ProcessBundle } from "@transpera-flow/db";
import { loadCapacityExample } from "../../../packages/db/src/fixtures/capacity-example";
import { createTestDb, createUser, type TestDb } from "../../../packages/db/test/harness";
import { processRows } from "@/lib/processes/rows";
import { tierSetupFrom } from "@/lib/tier-setup";
import { bundleHarness } from "./build-harness";

// Screenshots for Q3 (not a check): `Q3_SHOTS=<dir> pnpm vitest run test/q3-shots.test.ts` loads the example agency into a throwaway database
// and saves the Processes page and a process page (facts, supporting data) at 1440 px. Skipped when Q3_SHOTS is not set.
const dir = process.env.Q3_SHOTS;
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

let browser: Browser;
let tdb: TestDb;
let script: string;
let worker: string;
let css: string;
let data: unknown;

beforeAll(async () => {
  if (!dir) return;
  tdb = await createTestDb({ supabaseDefaultPrivileges: true });
  const owner = await createUser(tdb, "owner@q3-shots.example.com", { agency_admin: true });
  const ws = (await tdb.client.query("insert into workspaces (name, slug) values ('Example agency', 'example') returning id")).rows[0].id as string;
  await tdb.client.query("begin");
  const today = new Date().toISOString().slice(0, 10);
  await loadCapacityExample(tdb.client, ws, today);
  await tdb.client.query("commit");
  const db = tdb.dbAs({ sub: owner.id, role: "authenticated", app_metadata: { agency_admin: true } });
  const processes = await listProcesses(db, ws);
  const issues = await loadIssuesForReader(db, ws);
  const live = processes.flatMap((p) => (p.live_revision_id ? [p.live_revision_id] : []));
  const steps = (await tdb.client.query("select id, process_id, kind, child_process_id from steps where revision_id = any($1)", [live])).rows;
  const rows = processRows({
    processes: processes.map((p) => ({ id: p.id, name: p.name, kind: p.kind, category: p.category, description: p.description, parentId: p.parent_process_id, live: Boolean(p.live_revision_id), draft: false })),
    steps,
    issues,
    versions: new Map(processes.map((p) => [p.id, { number: 1, publishedAt: "2026-10-01T00:00:00Z" }])),
  });
  // The process page: the servicing process the content services run (briefs, writing, editing: several roles), with the pipeline beside it.
  const pick = processes.find((p) => /content/i.test(p.name) && p.kind === "servicing") ?? processes.find((p) => p.kind === "servicing")!;
  const bundle = (await loadProcessBySlug(db, "example", { draft: false, processId: pick.id }))!.live as ProcessBundle;
  const setup = await loadCapacitySetup(db, ws);
  data = { rows, bundle, tierSetup: tierSetupFrom(setup) };
  [script, worker, css] = await Promise.all([
    bundleHarness(new URL("./q3-shots-harness/entry.tsx", import.meta.url), META),
    bundleHarness(new URL("../src/workers/simulate.worker.ts", import.meta.url)),
    appCss(),
  ]);
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
}, 300_000);

afterAll(async () => {
  await browser?.close();
  await tdb?.close();
});

describe("Q3 screenshots", () => {
  it.skipIf(!dir)("saves the Processes page and a process page", async () => {
    mkdirSync(dir!, { recursive: true });
    for (const [what, wait, file] of [
      ["processes", "[data-process]", "processes-page-1440.png"],
      ["process", "[data-panel='key-person']", "process-page-facts-supporting-1440.png"],
    ] as const) {
      const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
      page.on("pageerror", (e) => console.log("pageerror", e.message));
      await page.setContent(`<style>${css}</style><div id="root"></div>`);
      await page.evaluate(([w, d]) => ((window.workerScripts = { "simulate.worker.ts": w as string }), (window.q3ShotData = d as never)), [worker, data] as const);
      await page.addScriptTag({ content: script });
      await page.evaluate((w) => window.mountQ3Shots(w), what);
      await page.waitForSelector(wait, { timeout: 240_000 });
      if (what === "process") await page.waitForSelector("[data-supporting-headline]:not(:has(span))", { timeout: 240_000 });
      if (what === "process") await page.locator("[data-role-hours] summary").first().click();
      await page.evaluate(() => document.fonts.ready);
      // One tall viewport, so the page's sticky header stays at the top of the picture.
      await page.setViewportSize({ width: 1440, height: await page.evaluate(() => document.documentElement.scrollHeight) });
      await page.screenshot({ path: `${dir}/${file}` });
      await page.close();
    }
  }, 600_000);
});
