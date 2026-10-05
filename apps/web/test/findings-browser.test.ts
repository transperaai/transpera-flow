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

async function open(mode: "demo" | "readonly" = "demo", width = 1280): Promise<{ page: Page; errors: string[] }> {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
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

describe("on a phone (400px)", { timeout: 60_000 }, () => {
  it("wraps a finding's title, tags and buttons instead of cutting them off", async () => {
    const { page, errors } = await open("demo", 400);
    // Every review row fits the screen, its buttons included.
    for (const r of await page.locator("[data-proposed]").all()) {
      const box = (await r.boundingBox())!;
      expect(box.x + box.width).toBeLessThanOrEqual(400);
    }
    const title = "Only one person can price and scope work";
    await row(page, title).getByRole("button", { name: "Accept" }).click();
    await expect.poll(() => listed(page)).toEqual([title]);
    const card = page.locator("[data-insight]").first();
    // The title takes the card's width (the tag and the issue sit under it), and no tag is cut short.
    const [cardBox, titleBox] = [(await card.boundingBox())!, (await card.locator("button b").boundingBox())!];
    expect(titleBox.width).toBeGreaterThan(cardBox.width * 0.6);
    for (const tag of await card.locator("[data-source]").all()) {
      expect(await tag.evaluate((el) => el.scrollWidth <= el.clientWidth + 1), await tag.innerText()).toBe(true);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(400);
    expect(errors).toEqual([]);
    await page.close();
  });
});

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

  it("shows the facts a proposal cites before anyone accepts it, and names the finding on each button", async () => {
    const { page, errors } = await open();
    const title = "Proposals wait about a week for the Strategist";
    const r = row(page, title);
    expect(await r.locator("[data-cited]").count()).toBe(0);
    await r.locator("[data-cited-toggle]").click();
    expect(await r.locator("[data-cited-toggle]").getAttribute("aria-expanded")).toBe("true");
    expect(await r.locator("[data-cited]").innerText()).toContain("Work waits 6.2 working days for Audit & proposal.");
    for (const b of ["Accept", "Edit", "Dismiss"]) expect(await r.getByRole("button", { name: `${b}: ${title}`, exact: true }).count()).toBe(1);
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
    // Its words are now a person's: it says so, here and in its detail.
    expect(await page.locator("[data-insight] [data-source]").first().innerText()).toBe("AI, edited");
    await page.locator("[data-insight] button", { hasText: "Only the Strategist can price work" }).click();
    expect(await page.locator("[data-insight-dialog]").innerText()).toContain("AI, edited by your team");
    await page.keyboard.press("Escape");
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
