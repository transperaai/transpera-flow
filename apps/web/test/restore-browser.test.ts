import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MAX_BACKUP_BYTES } from "@transpera-flow/db/workspace-import";
import { bundleHarness } from "./build-harness";

// The restore page's component in a real browser (issue #39, B10 2b): pick a backup, see what comes back and what stays in the
// file, and Restore posts the file gzipped. An unknown format and a refusal from the server show their message. The server is
// stood in for (restore-harness/entry.tsx); the checker is the real one, and the route and the database are tested elsewhere.

let browser: Browser;
let context: BrowserContext;
let script: string;

beforeAll(async () => {
  script = await bundleHarness(new URL("./restore-harness/entry.tsx", import.meta.url));
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  context = await browser.newContext();
}, 120_000);

afterAll(async () => {
  await context?.close();
  await browser?.close();
});

const u = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const WS = u(1);

/** A small, valid `transpera-workspace/1` backup: a company map, one published process, a role, a source and an issue. */
function backup(change: (b: Record<string, unknown>) => void = () => {}): string {
  const step = (n: number, name: string, kind: string) => ({ id: u(n), workspace_id: WS, name, kind, work_hours: 1, wait_hours: 0 });
  const b: Record<string, unknown> = {
    format: "transpera-workspace/1",
    exported_at: "2026-10-05T12:00:00Z",
    engine_version: "1.6.0",
    scope: "everything",
    about: "A backup.",
    workspace: { id: WS, name: "Mini", slug: "mini", plan: null, settings: { hours_per_week: 36 }, provenance: {} },
    company_model: { roles: [{ id: u(2), workspace_id: WS, name: "Analyst" }], people: [], clients: [] },
    processes: [
      { id: u(10), workspace_id: WS, name: "Company map", is_company: true, parent_process_id: null, versions: [{ id: u(11), workspace_id: WS, live: true, draft: false, steps: [], edges: [] }] },
      {
        id: u(20), workspace_id: WS, name: "Intake", is_company: false, parent_process_id: null, archived_at: null,
        versions: [
          { id: u(21), workspace_id: WS, live: false, draft: false, steps: [step(30, "Start", "start")], edges: [] },
          { id: u(22), workspace_id: WS, live: true, draft: false, layout: {}, steps: [step(31, "Start", "start"), step(32, "Done", "end")], edges: [{ id: u(33), workspace_id: WS, from_step_id: u(31), to_step_id: u(32), probability: 1 }] },
        ],
      },
    ],
    scenarios: [],
    solutions: [{ id: u(40), workspace_id: WS }],
    solution_issues: [],
    blocks: [],
    issues: [{ id: u(50), workspace_id: WS, number: 1, source: "manual", status: "open", links: [], owner_ids: [], source_ids: [], events: [] }],
    sources: [{ id: u(60), workspace_id: WS, title: "Notes", body: "x" }],
    source_links: [],
    suggestions: [],
    suggestion_proposals: [],
  };
  change(b);
  const versions = (b.processes as { versions: { steps: unknown[]; edges: unknown[] }[] }[]).flatMap((p) => p.versions);
  const cm = b.company_model as Record<string, unknown[]>;
  const counts: Record<string, number> = { processes: (b.processes as unknown[]).length, process_versions: versions.length, steps: versions.reduce((n, v) => n + v.steps.length, 0), edges: versions.reduce((n, v) => n + v.edges.length, 0) };
  for (const k of Object.keys(cm)) counts[`company_model.${k}`] = cm[k]!.length;
  for (const k of ["scenarios", "solutions", "solution_issues", "blocks", "issues", "sources", "source_links", "suggestions", "suggestion_proposals"]) counts[k] = (b[k] as unknown[]).length;
  b.counts = counts;
  return JSON.stringify(b);
}

const file = (name: string, text: string) => ({ name, mimeType: "application/json", buffer: Buffer.from(text) });

async function mount(answer?: { status: number; body: unknown }): Promise<{ page: Page; errors: string[] }> {
  await context.clearCookies();
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.route("https://restore.test/", (route) => route.fulfill({ contentType: "text/html", body: `<!doctype html><div id="root"></div>` }));
  await page.goto("https://restore.test/");
  await page.addScriptTag({ content: script });
  await page.evaluate((a) => window.mountRestore(a), answer);
  await page.waitForSelector("[data-restore-backup]");
  return { page, errors };
}

describe("the restore component", () => {
  it("shows what comes back and what stays in the file, then posts the file gzipped with its name", async () => {
    const { page, errors } = await mount();
    const text = backup();
    await page.setInputFiles("input[type=file]", file("mini backup.json", text));
    await page.waitForSelector("[data-restore-summary]");
    const summary = await page.locator("[data-restore-summary]").innerText();
    expect(summary).toContain("Will be restored");
    expect(summary).toContain("1 processes, as drafts");
    expect(summary).toContain("1 roles");
    expect(summary).toContain("Stays in the file");
    expect(summary).toContain("1 older versions of processes");
    expect(summary).toContain("1 solutions and their links");
    expect(summary).toMatch(/never holds members, people's emails, API tokens/);
    await page.click("[data-restore-submit]");
    await page.waitForFunction(() => window.posts.length === 1);
    const posted = await page.evaluate(() => window.posts[0]);
    expect(posted!.url).toBe("/w/mini/restore/bundle");
    expect(posted!.contentType).toBe("application/gzip");
    expect(decodeURIComponent(posted!.backupName!)).toBe("mini backup.json");
    expect(posted!.magic).toEqual([0x1f, 0x8b]);
    expect(posted!.text).toBe(text);
    // The cookie notice is left for the Overview.
    const cookie = await page.evaluate(() => document.cookie);
    expect(decodeURIComponent(cookie)).toContain("Restored 1 process as drafts. Publish each one to see its numbers.");
    expect(errors).toEqual([]);
    await page.close();
  });

  it("shows the clear error for an unknown format, and Restore stays off", async () => {
    const { page, errors } = await mount();
    await page.setInputFiles("input[type=file]", file("new.json", backup((b) => (b.format = "transpera-workspace/2"))));
    await page.waitForSelector("[data-restore-errors]");
    expect(await page.locator("[data-restore-errors]").innerText()).toContain("This backup is in a format this version of Transpera Flow can't read (transpera-workspace/2). It may have been made by a newer version.");
    expect(await page.locator("[data-restore-submit]").isDisabled()).toBe(true);
    expect(await page.evaluate(() => window.posts.length)).toBe(0);
    expect(errors).toEqual([]);
    await page.close();
  });

  it("says a process file is not a backup, and that text that isn't JSON isn't", async () => {
    const { page } = await mount();
    await page.setInputFiles("input[type=file]", file("p.json", JSON.stringify({ format: "transpera-process/2" })));
    await page.waitForSelector("[data-restore-errors]");
    expect(await page.locator("[data-restore-errors]").innerText()).toContain("This is a process file, not a workspace backup.");
    await page.setInputFiles("input[type=file]", file("bad.json", "{ nope"));
    await page.waitForSelector("[data-restore-problem]");
    expect(await page.locator("[data-restore-problem]").innerText()).toBe("That file isn't valid JSON.");
    await page.close();
  });

  it("refuses a file over the size limit before reading it", async () => {
    const { page } = await mount();
    // Made inside the page: sending 25 MB through setInputFiles over CDP took most of the 5 s timeout on a busy CI runner.
    await page.evaluate((bytes) => {
      const input = document.querySelector<HTMLInputElement>("input[type=file]")!;
      const files = new DataTransfer();
      files.items.add(new File([new Uint8Array(bytes).fill(32)], "huge.json", { type: "application/json" }));
      input.files = files.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }, MAX_BACKUP_BYTES + 1);
    await page.waitForSelector("[data-restore-problem]");
    expect(await page.locator("[data-restore-problem]").innerText()).toMatch(/That file is 25\.0 MB; a restore takes at most 25\.0 MB\./);
    await page.close();
  });

  it("shows the server's message when the restore is refused, and nothing is navigated", async () => {
    const { page } = await mount({ status: 409, body: { message: "Backups restore only into an empty workspace. Ask an agency admin to create a new workspace, then restore it there." } });
    await page.setInputFiles("input[type=file]", file("mini.json", backup()));
    await page.waitForSelector("[data-restore-summary]");
    await page.click("[data-restore-submit]");
    await page.waitForSelector("[data-restore-failed]");
    expect(await page.locator("[data-restore-failed]").innerText()).toContain("Backups restore only into an empty workspace.");
    expect(await page.evaluate(() => document.cookie)).not.toContain("tf-restore-notice");
    await page.close();
  });
});
