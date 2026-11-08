import { chromium, type Browser, type Page } from "playwright-core";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bundleHarness } from "./build-harness";
import type { TourHarnessOptions } from "./tour-harness/entry";

// The simpler Editor (editor brainstorm, items 1 to 6), on the real Editor in demo mode: the palette, a decision with its branches on the card
// and in the panel, a go back drawn as a node, the red marks and the bar's line, the Start that stays, a linked process that can be turned into
// steps, and "+ New purpose…". The data side is unit-tested (editor-branches, editor-branch-view, editor-problems).

let browser: Browser;
let script: string;
const ORIGIN = "https://editor.test/";
const AUDIT = "e0000000-0000-4000-8000-000000000003";
const DISCOVERY = "e0000000-0000-4000-8000-000000000002";
const KICKOFF = "e0000000-0000-4000-8000-000000000006";

beforeAll(async () => {
  script = await bundleHarness(new URL("./tour-harness/entry.tsx", import.meta.url));
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
}, 120_000);

afterAll(async () => {
  await browser?.close();
});

async function open(options: TourHarnessOptions = {}): Promise<{ page: Page; errors: string[] }> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.route(ORIGIN, (route) => route.fulfill({ contentType: "text/html", body: `<!doctype html><meta name="viewport" content="width=device-width"><div id="root"></div>` }));
  await page.goto(ORIGIN);
  await page.addScriptTag({ content: script });
  await page.evaluate((o) => window.mountEditor(o), { userId: "user-a", dismissed: true, ...options });
  await page.waitForSelector("[data-editor]");
  await page.waitForSelector(".react-flow__node");
  // Let the demo draft open before the first edit.
  await page.waitForTimeout(800);
  return { page, errors };
}

/**
 * React Flow's own stylesheet, and the one layout class a decision card's rows need, for the tests that look at where a dot is or
 * drag one: without them a dot is not placed on the card's edge.
 */
const mapStyles = (page: Page) =>
  page.addStyleTag({ content: `${readFileSync(createRequire(import.meta.url).resolve("@xyflow/react/dist/style.css"), "utf8")} .relative { position: relative }` });

const node = (page: Page, id: string) => page.locator(`.react-flow__node[data-id="${id}"]`);
// The page here has none of the app's stylesheet, so the toolbar and the inspector lie over the nodes: the click goes to the node itself.
const select = async (page: Page, id: string) => {
  await page.locator(".react-flow__pane").dispatchEvent("click");
  await node(page, id).dispatchEvent("click");
  await page.locator('aside[aria-label="Inspector"]').waitFor();
};
const click = (page: Page, name: string) => page.getByRole("button", { name, exact: true }).dispatchEvent("click");
const inspector = (page: Page) => page.locator('aside[aria-label="Inspector"]');
// The demo already has a decision ("Client decision"); the one these tests add is named after the palette's default.
const added = (page: Page) => page.locator('[data-tile="decision"]:not(:has-text("Client decision"))');
// "Yes, 50%. Edit this branch" -> "Yes 50%"
const rowsOf = async (page: Page) =>
  (await added(page).locator("[data-branch-row]").evaluateAll((els) => els.map((e) => e.getAttribute("aria-label") ?? ""))).map((l) => /^(.*), (\d+)%/.exec(l)!.slice(1, 3).join(" "));

describe("the palette", () => {
  it("offers + Step, + Wait and + Decision, and no + Process", async () => {
    const { page, errors } = await open();
    const labels = (await page.locator('section[aria-label="Add to the process"] button').allInnerTexts()).filter((t) => t.startsWith("+"));
    expect(labels).toEqual(["+ Step", "+ Wait", "+ Decision"]);
    expect(await page.locator("[data-palette-process]").count()).toBe(0);
    expect(errors).toEqual([]);
    await page.context().close();
  }, 60_000);
});

describe("node types", () => {
  it("draws a step, a wait, a decision, the start and an end each its own way", async () => {
    const { page } = await open();
    await select(page, AUDIT);
    await click(page, "+ Wait");
    await click(page, "+ Decision");
    await page.waitForSelector('[data-tile="decision"]');
    expect(await page.locator('[data-tile="wait"]').count()).toBe(1);
    expect(await page.locator('[data-tile="step"]').count()).toBeGreaterThan(3);
    expect(await page.locator('.react-flow__node [data-tile="terminal"]').first().innerText()).toMatch(/Start|End/);
    expect(await page.locator('[data-tile="terminal"]', { hasText: "Start" }).count()).toBe(1);
    await page.context().close();
  }, 60_000);

  it("keeps the Start: the Type field doesn't offer it and there is no delete", async () => {
    const { page } = await open();
    const start = await page.evaluate(() => document.querySelector<HTMLElement>('[data-tile="terminal"]')?.closest(".react-flow__node")?.getAttribute("data-id") ?? "");
    const startId = await page.locator('.react-flow__node:has([data-tile="terminal"]:has-text("Start"))').getAttribute("data-id");
    expect(start || startId).toBeTruthy();
    await select(page, startId!);
    expect(await inspector(page).locator("[data-fixed-type]").innerText()).toBe("Start");
    expect(await inspector(page).getByRole("button", { name: /^Delete/ }).count()).toBe(0);
    // The Delete key leaves it too.
    await page.keyboard.press("Delete");
    await page.waitForTimeout(200);
    expect(await node(page, startId!).count()).toBe(1);
    // A step's Type offers Step, Wait, Decision and End, never Start.
    await select(page, DISCOVERY);
    const options = await inspector(page).getByLabel("Type", { exact: true }).locator("option").allInnerTexts();
    expect(options).toEqual(["Step", "Wait", "Decision", "End"]);
    await page.context().close();
  }, 60_000);
});

describe("a decision", () => {
  async function withDecision() {
    const { page, errors } = await open();
    await select(page, AUDIT);
    await click(page, "+ Decision");
    await added(page).waitFor();
    return { page, errors };
  }

  it("comes with Yes and No at 50% on its card, and its panel holds the question and the branches", async () => {
    const { page, errors } = await withDecision();
    expect(await rowsOf(page)).toEqual(["Yes 50", "No 50"]);
    expect(await inspector(page).getByRole("textbox", { name: "Question" }).inputValue()).toBe("Decision");
    expect(await inspector(page).locator("[data-branch]").count()).toBe(2);
    expect(errors).toEqual([]);
    await page.context().close();
  }, 60_000);

  it("changing a share in the panel changes the card, and + Add branch adds a third with an even share, the others making room in proportion", async () => {
    const { page } = await withDecision();
    const share = inspector(page).locator("[data-branch]").first().getByLabel("Share", { exact: true });
    await share.fill("70");
    await share.press("Enter");
    await page.waitForFunction(() => [...document.querySelectorAll('[data-tile="decision"]')].some((d) => !/Client decision/.test(d.textContent ?? "") && /Yes\s*70%/.test(d.textContent ?? "") && /No\s*30%/.test(d.textContent ?? "")));
    await page.getByRole("button", { name: "+ Add branch" }).dispatchEvent("click");
    await page.waitForFunction(() => [...document.querySelectorAll('[data-tile="decision"]')].some((d) => !/Client decision/.test(d.textContent ?? "") && d.querySelectorAll("[data-branch-row]").length === 3));
    const rows = await rowsOf(page);
    const total = rows.reduce((n, r) => n + Number(r.split(" ").pop()), 0);
    expect(total).toBe(100);
    // The new branch gets 100 / 3 = 33; Yes and No share 67 as 70 : 30 (46.9 and 20.1, the 1 left over to the larger).
    expect(rows).toEqual(["Yes 47", "No 20", "Branch 3 33"]);
    await page.context().close();
  }, 60_000);

  it("gives each branch its own dot on the card, its line leaving from it, and a + dot to add one (round 2, item 12)", async () => {
    const { page, errors } = await withDecision();
    await mapStyles(page);
    const ids = await added(page).locator("[data-branch-row]").evaluateAll((els) => els.map((e) => e.getAttribute("data-branch-row")!));
    expect(ids).toHaveLength(2);
    // One source dot per branch, named after it, and its line drawn (React Flow draws no line whose dot is missing).
    const dots = added(page).locator(".react-flow__handle.source[data-branch-handle]");
    expect(await dots.evaluateAll((els) => els.map((e) => e.getAttribute("data-handleid")))).toEqual(ids);
    expect(await dots.evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")))).toEqual(["Yes, 50%", "No, 50%"]);
    for (const id of ids) expect(await page.locator(`.react-flow__edge[data-id="${id}"]`).count()).toBe(1);
    expect(await added(page).locator("[data-add-branch-handle]").count()).toBe(1);
    // Each dot sits level with its own row.
    const middles = (sel: string) => added(page).locator(sel).evaluateAll((els) => els.map((e) => { const r = e.getBoundingClientRect(); return r.top + r.height / 2; }));
    const rowMiddles = await middles("[data-branch-li]");
    const dotMiddles = await middles("[data-branch-handle]");
    expect(new Set(dotMiddles).size).toBe(2);
    dotMiddles.forEach((y, i) => expect(Math.abs(y - rowMiddles[i]!)).toBeLessThan(2));
    // A step that isn't a decision keeps its single dot.
    expect(await node(page, KICKOFF).locator(".react-flow__handle.source").count()).toBe(1);
    expect(errors).toEqual([]);
    await page.context().close();
  }, 60_000);

  it("dragging the + dot to a step adds a branch to it, and dragging a branch's dot sends that branch elsewhere", async () => {
    const { page } = await withDecision();
    await mapStyles(page);
    // The map over the whole page, so the dots are on screen and under the mouse.
    await page.addStyleTag({ content: ".react-flow { position: fixed !important; inset: 0; z-index: 50; height: 100vh !important; background: white }" });
    await page.waitForTimeout(500);
    const centre = async (loc: ReturnType<Page["locator"]>) => {
      const box = (await loc.boundingBox())!;
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    };
    // The page has no stylesheet, so the panels lie over the map: the drag starts on the dot itself and React Flow follows the
    // mouse on the document, finding the nearest dot to drop on.
    const drag = async (from: ReturnType<Page["locator"]>, to: ReturnType<Page["locator"]>) => {
      const a = await centre(from);
      const b = await centre(to);
      await page.mouse.move(a.x, a.y);
      await from.dispatchEvent("mousedown", { button: 0, clientX: a.x, clientY: a.y });
      await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 4 });
      await page.mouse.move(b.x, b.y, { steps: 4 });
      await page.mouse.up();
    };
    await drag(added(page).locator("[data-add-branch-handle]"), node(page, KICKOFF).locator(".react-flow__handle.target"));
    await page.waitForFunction(() => [...document.querySelectorAll('[data-tile="decision"]')].some((d) => !/Client decision/.test(d.textContent ?? "") && d.querySelectorAll("[data-branch-row]").length === 3));
    // An even share for the new branch (100 / 3), the other two making room in proportion.
    expect(await rowsOf(page)).toEqual(["Yes 34", "No 33", "Branch 3 33"]);
    // The new branch is in focus in the panel, and goes to Kickoff.
    await page.waitForSelector("[data-branch][data-focused]");
    expect(await inspector(page).locator("[data-branch][data-focused] legend").innerText()).toBe("Branch 3");
    const kickoffName = await node(page, KICKOFF).locator('[data-field="name"]').first().innerText();
    expect(await inspector(page).getByLabel("Branch 3 goes to").locator("option:checked").innerText()).toBe(kickoffName);
    // Dragging No's dot to Discovery, a step before the decision, sends No back there: a go back, not a new branch.
    const noId = (await added(page).locator("[data-branch-row]").nth(1).getAttribute("data-branch-row"))!;
    await drag(added(page).locator(`[data-branch-handle="${noId}"]`), node(page, DISCOVERY).locator(".react-flow__handle.target"));
    await page.waitForFunction((id) => document.querySelector(`[data-branch-row="${id}"]`)?.getAttribute("aria-label")?.includes("goes back"), noId);
    expect(await added(page).locator("[data-branch-row]").count()).toBe(3);
    expect(await page.locator('[data-tile="goback"]').count()).toBe(1);
    // Each was one undo step, named as the panel's would be.
    expect(await page.locator("[data-undo]").getAttribute("title")).toMatch(/^Undo: Sent a branch of Decision to go back to /);
    await page.locator("[data-undo]").dispatchEvent("click");
    await page.waitForFunction((id) => !document.querySelector(`[data-branch-row="${id}"]`)?.getAttribute("aria-label")?.includes("goes back"), noId);
    expect(await added(page).locator("[data-branch-row]").count()).toBe(3);
    expect(await page.locator("[data-undo]").getAttribute("title")).toMatch(/^Undo: Added a branch from Decision to /);
    await page.locator("[data-undo]").dispatchEvent("click");
    await page.waitForFunction(() => [...document.querySelectorAll('[data-tile="decision"]')].some((d) => !/Client decision/.test(d.textContent ?? "") && d.querySelectorAll("[data-branch-row]").length === 2));
    expect(await rowsOf(page)).toEqual(["Yes 50", "No 50"]);
    await page.context().close();
  }, 60_000);

  it("edits a branch's % on the card: Enter saves and the others make room in proportion, Escape puts it back", async () => {
    const { page } = await withDecision();
    await page.getByRole("button", { name: "+ Add branch" }).dispatchEvent("click");
    await page.waitForFunction(() => [...document.querySelectorAll('[data-tile="decision"]')].some((d) => !/Client decision/.test(d.textContent ?? "") && d.querySelectorAll("[data-branch-row]").length === 3));
    expect(await rowsOf(page)).toEqual(["Yes 34", "No 33", "Branch 3 33"]);
    const ids = await added(page).locator("[data-branch-row]").evaluateAll((els) => els.map((e) => e.getAttribute("data-branch-row")!));
    // Escape: nothing changes.
    await added(page).locator(`[data-branch-share="${ids[0]}"]`).dispatchEvent("click");
    const field = added(page).locator(`[data-branch-share-input="${ids[0]}"]`);
    await field.fill("90");
    await field.press("Escape");
    await added(page).locator(`[data-branch-share="${ids[0]}"]`).waitFor();
    expect(await rowsOf(page)).toEqual(["Yes 34", "No 33", "Branch 3 33"]);
    // Enter: Yes 60, and No and Branch 3 share 40 as 33 : 33.
    await added(page).locator(`[data-branch-share="${ids[0]}"]`).dispatchEvent("click");
    await field.fill("60");
    await field.press("Enter");
    await page.waitForFunction((id) => /^Yes, 60%/.test(document.querySelector(`[data-branch-row="${id}"]`)?.getAttribute("aria-label") ?? ""), ids[0]);
    expect(await rowsOf(page)).toEqual(["Yes 60", "No 20", "Branch 3 20"]);
    // Leaving the field saves too: Branch 3 at 50 leaves 50 for Yes and No as 60 : 20 (37.5 and 12.5, the 1 left over to the larger).
    await added(page).locator(`[data-branch-share="${ids[2]}"]`).dispatchEvent("click");
    const third = added(page).locator(`[data-branch-share-input="${ids[2]}"]`);
    await third.fill("50");
    await third.blur();
    await page.waitForFunction((id) => /, 50%/.test(document.querySelector(`[data-branch-row="${id}"]`)?.getAttribute("aria-label") ?? ""), ids[2]);
    expect(await rowsOf(page)).toEqual(["Yes 38", "No 12", "Branch 3 50"]);
    // The panel shows the same shares.
    const shares = await inspector(page).locator("[data-branch]").evaluateAll((els) => els.map((e) => (e.querySelectorAll("input")[1] as HTMLInputElement | undefined)?.value));
    expect(shares).toEqual(["38", "12", "50"]);
    await page.context().close();
  }, 60_000);

  it("a click on a branch row puts that branch's fields in focus; a click on its line does the same", async () => {
    const { page } = await withDecision();
    await added(page).locator("[data-branch-row]").nth(1).dispatchEvent("click");
    await page.waitForSelector("[data-branch][data-focused]");
    const focused = inspector(page).locator("[data-branch][data-focused]");
    expect(await focused.locator("legend").innerText()).toBe("Branch 2");
    const edgeId = await page.locator("[data-branch][data-focused]").getAttribute("data-branch");
    await page.locator(".react-flow__pane").dispatchEvent("click");
    await page.locator(`.react-flow__edge[data-id="${edgeId}"]`).dispatchEvent("click");
    await page.waitForSelector("[data-branch][data-focused]");
    expect(await inspector(page).locator("[data-branch][data-focused]").getAttribute("data-branch")).toBe(edgeId);
    await page.context().close();
  }, 60_000);

  it("sends a branch to End (lost) from its Goes to menu", async () => {
    const { page } = await withDecision();
    const goes = inspector(page).locator("[data-branch]").nth(1).getByLabel("Branch 2 goes to");
    const groups = await goes.locator("optgroup").evaluateAll((els) => els.map((e) => e.getAttribute("label")));
    expect(groups).toEqual(["Next step…", "Go back to…", "End (won / lost / done)"]);
    await goes.selectOption({ label: "Lost" });
    await page.waitForFunction(() => document.querySelector('[data-tile="terminal"]:has(+ *), [data-tile="terminal"]') !== null);
    expect(await goes.inputValue()).toBe("end:lost");
    await page.context().close();
  }, 60_000);

  it("draws a branch that goes back as a Go back to X node, linked to X; a click on it selects the branch", async () => {
    const { page } = await withDecision();
    const goes = inspector(page).locator("[data-branch]").first().getByLabel("Branch 1 goes to");
    await goes.selectOption({ value: `back:${AUDIT}` });
    await page.waitForSelector('[data-tile="goback"]');
    expect((await page.locator('[data-tile="goback"]').innerText()).trim()).toBe("Go back to Audit & proposal");
    expect(await page.locator(".react-flow__edge").evaluateAll((els) => els.map((e) => e.getAttribute("data-id") ?? "").filter((id) => id.startsWith("gobacklink:")).length)).toBe(1);
    // The decision's row says so too.
    expect(await added(page).locator("[data-branch-row]").first().getAttribute("aria-label")).toContain("goes back");
    await page.locator(".react-flow__pane").dispatchEvent("click");
    await page.locator(".react-flow__node:has([data-tile=goback])").dispatchEvent("click");
    await page.waitForSelector("[data-branch][data-focused]");
    expect(await inspector(page).locator("[data-branch][data-focused] legend").innerText()).toBe("Branch 1");
    await page.context().close();
  }, 60_000);

  it("removes a branch, and the shares still add up", async () => {
    const { page } = await withDecision();
    await inspector(page).locator("[data-remove-branch]").first().dispatchEvent("click");
    await page.waitForFunction(() => [...document.querySelectorAll('[data-tile="decision"]')].some((d) => !/Client decision/.test(d.textContent ?? "") && d.querySelectorAll("[data-branch-row]").length === 1));
    expect(await rowsOf(page)).toEqual(["No 100"]);
    await page.context().close();
  }, 60_000);
});

describe("problems", () => {
  it("marks a node that has something to fix, explains it on hover and focus, and the bar's line jumps to it", async () => {
    const { page } = await open();
    // A new step with nothing leaving it, placed by itself.
    await page.locator(".react-flow__pane").dispatchEvent("click");
    await click(page, "+ Step");
    const line = page.locator("[data-problems-line]");
    await line.waitFor();
    expect((await line.innerText()).replace(/\s+/g, " ")).toMatch(/^!\s*\d+ things? to fix before this can simulate$/);
    expect(await page.locator('section[aria-label="Loose ends"]').count()).toBe(0);
    const mark = page.locator("[data-problem-mark] [role=img]").first();
    expect(await mark.getAttribute("aria-label")).toContain("Nothing leaves this step");
    await mark.focus();
    expect(await page.locator("[data-problem-reasons]").first().isVisible()).toBe(true);
    await page.locator(".react-flow__pane").dispatchEvent("click");
    await line.dispatchEvent("click");
    await page.locator('aside[aria-label="Inspector"]').waitFor();
    await page.context().close();
  }, 60_000);

  it("blocks Publish while something is left to fix, and allows it once it is fixed", async () => {
    const { page } = await open();
    const publish = page.getByRole("button", { name: "Publish…" });
    // A wait joined in after a step: a change, and nothing to fix.
    await select(page, AUDIT);
    await click(page, "+ Wait");
    await page.waitForFunction(() => !document.querySelector("[data-problems-line]") && !document.querySelector("[data-tour=publish]")?.hasAttribute("disabled"));
    expect(await publish.isEnabled()).toBe(true);
    // A step with nothing leaving it: Publish waits.
    await page.locator(".react-flow__pane").dispatchEvent("click");
    await click(page, "+ Step");
    await page.locator("[data-problems-line]").waitFor();
    expect(await publish.isDisabled()).toBe(true);
    expect(await publish.getAttribute("title")).toMatch(/Fix the/);
    await page.context().close();
  }, 60_000);

  it("shows no line when the process is fine", async () => {
    const { page } = await open();
    expect(await page.locator("[data-problems-line]").count()).toBe(0);
    expect(await page.locator("[data-problem-mark]").count()).toBe(0);
    await page.context().close();
  }, 60_000);
});

describe("evidence", () => {
  it("is not in the step inspector, but the step still links to a source", async () => {
    const { page } = await open();
    await select(page, DISCOVERY);
    expect(await inspector(page).getByText("Evidence", { exact: true }).count()).toBe(0);
    expect(await inspector(page).locator("button", { hasText: /Cite|Add evidence/i }).count()).toBe(0);
    await page.context().close();
  }, 60_000);
});

describe("a linked process", () => {
  it("shows as a card with its link said plainly, and Turn into steps copies the steps in and cuts the link", async () => {
    const { page } = await open({ holder: true });
    const holder = page.locator('.react-flow__node:has([data-linked-process])');
    expect(await holder.count()).toBe(1);
    expect((await holder.locator("[data-linked-process]").innerText()).replace(/\s+/g, " ")).toMatch(/^Linked process: changes when ‘.+’ changes$/);
    const before = await page.locator(".react-flow__node").count();
    await holder.locator("[data-turn-into-steps]").dispatchEvent("click");
    await page.waitForFunction((n) => document.querySelectorAll(".react-flow__node").length > n, before);
    expect(await page.locator("[data-linked-process]").count()).toBe(0);
    await page.context().close();
  }, 60_000);
});

describe("a new purpose", () => {
  it("is hidden when the person can't edit the workspace, and the form asks for a name and a description", async () => {
    const hidden = await open();
    await select(hidden.page, DISCOVERY);
    expect(await hidden.page.locator("[data-new-purpose]").count()).toBe(0);
    await hidden.page.context().close();

    const { page } = await open({ canAddPurpose: true });
    await select(page, DISCOVERY);
    await page.locator("[data-new-purpose]").dispatchEvent("click");
    const form = page.locator("[data-new-purpose-form]");
    await form.waitFor();
    expect(await form.getByRole("textbox", { name: "Name" }).count()).toBe(1);
    expect(await form.getByRole("textbox", { name: "Description" }).count()).toBe(1);
    await form.getByRole("textbox", { name: "Name" }).fill("Chasing the client");
    await form.getByRole("textbox", { name: "Description" }).fill("Emails and calls to get answers");
    await form.getByRole("button", { name: "Add purpose" }).dispatchEvent("click");
    // The server action is stood in for by one that refuses; the page asked it, with the workspace's list as loaded.
    await form.getByRole("alert").waitFor();
    const calls = await page.evaluate(() => (globalThis as unknown as { __serverActions: { name: string; args: unknown[] }[] }).__serverActions);
    expect(calls.map((c) => c.name)).toEqual(["addPurpose"]);
    expect(calls[0]!.args[2]).toEqual({ name: "Chasing the client", description: "Emails and calls to get answers" });
    await page.context().close();
  }, 60_000);

  it("says so at the limit instead of offering another", async () => {
    const { page } = await open({ canAddPurpose: true, purposes: 12 });
    await select(page, DISCOVERY);
    expect(await page.locator("[data-new-purpose]").count()).toBe(0);
    expect(await page.locator("[data-purpose-limit]").innerText()).toBe("You have 12 purposes, the most there can be");
    await page.context().close();
  }, 60_000);
});
