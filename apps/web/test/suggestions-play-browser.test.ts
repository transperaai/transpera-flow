import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bundleHarness } from "./build-harness";

// A visitor's idea on the Suggestions page (issue #33, B4) in a real browser: the card for owners and editors (the visitor's name, note
// and changes, their email, Build it, Dismiss with a reply, and the wording held from members) and for members and viewers (the
// stand-ins, no email, no buttons). The database side is tested in packages/db/test/play-links.test.ts.

let browser: Browser;
let script: string;

beforeAll(async () => {
  script = await bundleHarness(new URL("./suggestions-play-harness/entry.tsx", import.meta.url));
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
}, 120_000);

afterAll(async () => {
  await browser?.close();
});

async function open(options: { editor: boolean; held?: boolean; issue?: boolean }, width = 1280): Promise<{ page: Page; errors: string[] }> {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.route("https://suggestions.test/", (route) => route.fulfill({ contentType: "text/html", body: `<!doctype html><div id="root"></div>` }));
  await page.goto("https://suggestions.test/");
  await page.addScriptTag({ content: script });
  await page.evaluate((o) => window.mountPlayIdea(o), options);
  await page.waitForSelector("[data-kind=solution_idea]");
  return { page, errors };
}

const card = (page: Page) => page.locator("[data-kind=solution_idea]");

describe("a visitor's idea, read by an owner or editor", { timeout: 60_000 }, () => {
  it("shows the badge, the visitor's name, note and changes in words, their email and Build it for no issue", async () => {
    const { page, errors } = await open({ editor: true });
    expect(await card(page).locator("[data-badge]").innerText()).toMatch(/^Visitor's idea/);
    expect(await card(page).locator("[data-from]").innerText()).toBe("Marta Okoye (play link)");
    const text = await card(page).innerText();
    expect(text).toContain("One more strategist");
    expect(text).toContain("With 3 strategists, leads wait under a day.");
    const changes = await card(page).locator("[data-idea-changes] li").allInnerTexts();
    expect(changes).toEqual(["Leads per week: 12", "Strategist: 3 people", "Hands-on time on Check fit: −20%"]);
    expect(text).toContain("Sent from a link to Lead to live.");
    expect(text).not.toContain("for issue");
    expect(text).not.toMatch(/Proposed steps/);
    expect(await card(page).locator("[data-contact] a").getAttribute("href")).toBe("mailto:marta@example.com");
    const href = (await card(page).getByRole("link", { name: /Build it/ }).getAttribute("href"))!;
    const url = new URL(href, "https://x.test");
    expect(url.pathname).toBe("/w/northbeam/p/00000000-0000-4000-8000-0000000000c1/edit");
    expect(url.searchParams.get("mode")).toBe("solution");
    expect(url.searchParams.get("idea")).toBe("00000000-0000-4000-8000-0000000000f1");
    expect(url.searchParams.has("issue")).toBe(false);
    // The (i) beside the badge and the changes.
    expect(await card(page).getByRole("button", { name: "About Visitor's idea" }).count()).toBe(1);
    expect(errors).toEqual([]);
    await page.close();
  });

  it("names the issue when the visitor picked one, and Build it carries it", async () => {
    const { page } = await open({ editor: true, issue: true });
    expect(await card(page).innerText()).toContain("#4 Leads wait too long");
    const url = new URL((await card(page).getByRole("link", { name: /Build it/ }).getAttribute("href"))!, "https://x.test");
    expect(url.searchParams.get("issue")).toBe("00000000-0000-4000-8000-0000000000e1");
    await page.close();
  });

  it("Dismiss opens a Reply box with an (i); Cancel closes it; Dismiss sends the reply with the review", async () => {
    const { page } = await open({ editor: true });
    expect(await page.locator("[data-reply]").count()).toBe(0);
    await card(page).getByRole("button", { name: "Dismiss", exact: true }).click();
    await page.waitForSelector("[data-reply]");
    expect(await page.locator("[data-reply]").getByRole("button", { name: "About Reply" }).count()).toBe(1);
    await page.getByRole("button", { name: "Cancel" }).click();
    expect(await page.locator("[data-reply]").count()).toBe(0);
    await card(page).getByRole("button", { name: "Dismiss", exact: true }).click();
    await page.fill("[data-reply-text]", "Thanks Marta: we're hiring for this in January.");
    await page.click("[data-reply-dismiss]");
    await page.waitForFunction(() => window.playReviews.length === 1);
    expect(await page.evaluate(() => window.playReviews)).toEqual([[["00000000-0000-4000-8000-0000000000f1"], "reject", "Thanks Marta: we're hiring for this in January."]]);
    await page.close();
  });

  it("an empty reply is sent as none", async () => {
    const { page } = await open({ editor: true });
    await card(page).getByRole("button", { name: "Dismiss", exact: true }).click();
    await page.click("[data-reply-dismiss]");
    await page.waitForFunction(() => window.playReviews.length === 1);
    expect((await page.evaluate(() => window.playReviews))[0]![2]).toBeNull();
    await page.close();
  });

  it("where the visitor's wording was held from members, the editor reads the original with the line explaining it", async () => {
    const { page } = await open({ editor: true, held: true });
    const text = await card(page).innerText();
    expect(text).toContain("Ask Priya Shah's team");
    expect(text).toContain("Priya Shah says it costs £4,100");
    expect(await card(page).locator("[data-from]").innerText()).toBe("Marta Okoye (play link)");
    expect(await card(page).locator("[data-held]").innerText()).toContain("Members and viewers see “A visitor's idea”, no note and “A visitor” as the name here: the visitor's wording names someone, gives an email address or an amount.");
    expect(await card(page).locator("[data-held]").getByRole("button", { name: /About What members and viewers see/ }).count()).toBe(1);
    await page.close();
  });
});

describe("a visitor's idea, read by a member or viewer", { timeout: 60_000 }, () => {
  it("shows the name, note and changes, but no email, no Build it and no Dismiss", async () => {
    const { page, errors } = await open({ editor: false });
    const text = await card(page).innerText();
    expect(text).toContain("Marta Okoye (play link)");
    expect(text).toContain("With 3 strategists, leads wait under a day.");
    expect(text).toContain("Leads per week: 12");
    expect(await card(page).locator("[data-contact]").count()).toBe(0);
    expect(text).not.toContain("marta@example.com");
    expect(await card(page).getByRole("link", { name: /Build it/ }).count()).toBe(0);
    expect(await card(page).getByRole("button", { name: "Dismiss" }).count()).toBe(0);
    expect(errors).toEqual([]);
    await page.close();
  });

  it("reads the stand-ins where the wording was held: 'A visitor's idea', no note, 'A visitor', and never the original", async () => {
    const { page } = await open({ editor: false, held: true });
    const text = await card(page).innerText();
    expect(text).toContain("A visitor's idea");
    expect(await card(page).locator("[data-from]").innerText()).toBe("A visitor (play link)");
    expect(text).not.toContain("Priya");
    expect(text).not.toContain("£4,100");
    expect(await card(page).locator("[data-held]").count()).toBe(0);
    await page.close();
  });
});
