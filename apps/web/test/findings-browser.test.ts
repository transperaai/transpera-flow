import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bundleHarness } from "./build-harness";

// Findings in a real browser (issue #175, B17), on the process page's findings section in demo mode
// (findings-harness/entry.tsx): an editor accepts, edits and dismisses AI findings from the review list; adds a finding by
// hand, edits it and dismisses it; and acknowledges an accepted finding as an issue. A viewer sees accepted findings and
// none of the buttons. The database side (RLS, the trigger) is tested in packages/db/test/findings.test.ts and over
// PostgREST in packages/mcp/test/postgrest-findings.test.ts.

let browser: Browser;
let script: string;

beforeAll(async () => {
  script = await bundleHarness(new URL("./findings-harness/entry.tsx", import.meta.url));
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
}, 120_000);

afterAll(async () => {
  await browser?.close();
});

async function open(mode: "demo" | "readonly" = "demo"): Promise<{ page: Page; errors: string[] }> {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.route("https://findings.test/", (route) => route.fulfill({ contentType: "text/html", body: `<!doctype html><div id="root"></div>` }));
  await page.goto("https://findings.test/");
  await page.addScriptTag({ content: script });
  await page.evaluate((m) => window.mountFindings({ mode: m }), mode);
  await page.waitForSelector("[data-analysis]");
  return { page, errors };
}

const proposed = (page: Page) => page.locator("[data-proposed] b").allInnerTexts();
const listed = (page: Page) => page.locator("[data-insight] button b").allInnerTexts();
const row = (page: Page, title: string) => page.locator("[data-proposed]", { hasText: title });

describe("AI findings: accept, edit, dismiss", { timeout: 60_000 }, () => {
  it("starts with the analysis's findings proposed, none listed until accepted", async () => {
    const { page, errors } = await open();
    expect(await proposed(page)).toHaveLength(3);
    expect(await listed(page)).toEqual([]);
    expect(await page.locator("[data-review]").innerText()).toContain("To review · 3");
    expect(errors).toEqual([]);
    await page.close();
  });

  it("accepts one as it is: it leaves the review list and is listed, citing its facts", async () => {
    const { page, errors } = await open();
    const title = "Proposals wait about a week for the Strategist";
    await row(page, title).getByRole("button", { name: "Accept" }).click();
    await expect.poll(() => listed(page)).toEqual([title]);
    expect(await proposed(page)).not.toContain(title);
    await page.locator("[data-insight] button", { hasText: title }).click();
    const dialog = page.locator("[data-insight-dialog]");
    expect(await dialog.innerText()).toContain("Rests on");
    expect(await dialog.locator("[data-cited]").innerText()).toContain("Work waits 6.2 working days for Audit & proposal.");
    expect(errors).toEqual([]);
    await page.close();
  });

  it("edits one before accepting it", async () => {
    const { page, errors } = await open();
    await row(page, "Only one person can price and scope work").getByRole("button", { name: "Edit" }).click();
    const dialog = page.locator("[data-finding-dialog=review]");
    await dialog.locator("input[name=title]").fill("Only the Strategist can price work");
    await dialog.locator("select[name=rating]").selectOption("risk");
    await dialog.getByRole("button", { name: "Save and accept" }).click();
    await expect.poll(() => listed(page)).toEqual(["Only the Strategist can price work"]);
    expect(await page.locator("[data-insight]").first().innerText()).toContain("Operational risk");
    expect(await proposed(page)).toHaveLength(2);
    expect(errors).toEqual([]);
    await page.close();
  });

  it("dismisses one: it leaves the review list and is never listed; Analyse doesn't bring it back", async () => {
    const { page, errors } = await open();
    const title = "Late servicing work is the biggest reason PPC clients leave";
    await row(page, title).getByRole("button", { name: "Dismiss" }).click();
    await expect.poll(() => proposed(page)).not.toContain(title);
    expect(await listed(page)).toEqual([]);
    await page.locator("[data-analyse]").click();
    await page.getByRole("status").filter({ hasText: "wasn't run again" }).waitFor();
    expect(await proposed(page)).not.toContain(title);
    expect(errors).toEqual([]);
    await page.close();
  });
});

describe("findings by hand: add, edit, dismiss", { timeout: 60_000 }, () => {
  it("adds one, accepted at once and marked as by hand; edits it; dismisses it", async () => {
    const { page, errors } = await open();
    await page.locator("[data-add-finding]").click();
    const add = page.locator("[data-finding-dialog=add]");
    // A finding needs a title.
    await add.getByRole("button", { name: "Add finding" }).click();
    expect(await add.innerText()).toContain("Give the finding a title.");
    await add.locator("input[name=title]").fill("Kickoff calls slip when Maya is away");
    await add.locator("select[name=type]").selectOption("spof");
    await add.locator("select[name=step]").selectOption({ label: "Kickoff & strategy" });
    await add.locator("textarea[name=evidence]").fill("Seen in the August audit: two kickoffs moved a week.");
    await add.locator("textarea[name=why]").fill("Clients' first impression is a delay.");
    await add.getByRole("button", { name: "Add finding" }).click();
    await expect.poll(() => listed(page)).toEqual(["Kickoff calls slip when Maya is away"]);
    const item = page.locator("[data-insight]").first();
    expect(await item.locator("[data-source]").getAttribute("data-source")).toBe("manual");
    expect(await item.innerText()).toContain("Kickoff & strategy");

    // Edit it from its detail.
    await item.locator("button").first().click();
    const detail = page.locator("[data-insight-dialog]");
    expect(await detail.innerText()).toContain("Added by hand");
    await detail.getByRole("button", { name: "Edit", exact: true }).click();
    const edit = page.locator("[data-finding-dialog=edit]");
    await edit.locator("input[name=title]").fill("Kickoff calls slip a week when Maya is away");
    await edit.getByRole("button", { name: "Save" }).click();
    await expect.poll(() => listed(page)).toEqual(["Kickoff calls slip a week when Maya is away"]);

    // Dismiss it.
    await page.locator("[data-insight] button").first().click();
    await page.locator("[data-insight-dialog]").getByRole("button", { name: "Dismiss", exact: true }).click();
    await expect.poll(() => listed(page)).toEqual([]);
    expect(errors).toEqual([]);
    await page.close();
  });

  it("acknowledges an accepted finding as an issue, which the list then links to", async () => {
    const { page, errors } = await open();
    const title = "Proposals wait about a week for the Strategist";
    await row(page, title).getByRole("button", { name: "Accept" }).click();
    await page.locator("[data-insight] button", { hasText: title }).click();
    await page.locator("[data-insight-dialog]").getByRole("button", { name: "Acknowledge as issue…" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Add to issues" }).click();
    await expect.poll(() => page.locator("[data-insight][data-acknowledged]").count()).toBe(1);
    expect(errors).toEqual([]);
    await page.close();
  });
});

describe("a viewer", { timeout: 60_000 }, () => {
  it("sees no review list, no Analyse, no Add, and can't change a finding", async () => {
    const { page, errors } = await open("readonly");
    expect(await page.locator("[data-review]").count()).toBe(0);
    expect(await page.locator("[data-review-waiting]").innerText()).toContain("AI proposed 3 findings");
    expect(await page.locator("[data-analyse]").count()).toBe(0);
    expect(await page.locator("[data-add-finding]").count()).toBe(0);
    expect(errors).toEqual([]);
    await page.close();
  });
});
