import { mkdirSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bundleHarness } from "./build-harness";
import type { ShareLinkRow } from "../src/lib/share/list";

// A share link's page (issue #32, B3) in a real browser: the real SharedView for an Overview, a process, an issue and a solution,
// built from the Northbeam fixture with People off and Financials off (and the toggles on, for contrast). It renders without
// console errors, makes no network request, has no control that changes anything, and shows the labels and "—" the toggles ask for.

let browser: Browser;
let script: string;
let workers: Record<string, string>;

const META = { "import.meta.url": JSON.stringify("http://harness.test/src/lib/x/") };
const SHOTS = process.env.SHARE_SHOTS_DIR;

beforeAll(async () => {
  [script, workers] = await Promise.all([
    bundleHarness(new URL("./share-harness/entry.tsx", import.meta.url), META),
    Promise.all(
      ["simulate.worker.ts", "impact.worker.ts", "absence.worker.ts", "issue-costs.worker.ts", "shadow-price.worker.ts", "verdict.worker.ts", "stress.worker.ts", "projection.worker.ts"].map(
        async (f) => [f, await bundleHarness(new URL(`../src/workers/${f}`, import.meta.url))] as const,
      ),
    ).then(Object.fromEntries),
  ]);
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  if (SHOTS) mkdirSync(SHOTS, { recursive: true });
}, 180_000);

afterAll(async () => {
  await browser?.close();
});

type Kind = "overview" | "process" | "issue" | "solution";
interface Mounted {
  page: Page;
  errors: string[];
  requests: string[];
  names: { clientNames: string[]; personNames: string[]; personFirst: string[] };
}

async function mount(kind: Kind, people: boolean, financials: boolean, size = { width: 1440, height: 1600 }, scheme: "light" | "dark" = "light"): Promise<Mounted> {
  const page = await browser.newPage({ viewport: size, colorScheme: scheme });
  const errors: string[] = [];
  const requests: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("request", (r) => requests.push(r.url()));
  // A secure origin (crypto.randomUUID needs one); the page is stood in for, so nothing leaves the machine.
  await page.route("https://share.test/", (route) => route.fulfill({ contentType: "text/html", body: `<!doctype html><div id="root"></div>` }));
  await page.goto("https://share.test/");
  await page.evaluate((w) => (window.workerScripts = w), workers);
  await page.addScriptTag({ content: script });
  const names = await page.evaluate(([k, p, f]) => window.mountShare(k as Kind, { people: p as boolean, financials: f as boolean }), [kind, people, financials]);
  await page.waitForSelector("[data-share-bar]");
  return { page, errors, requests, names };
}

/** Wait until the screen has drawn what it draws from a run. */
async function settled(page: Page, kind: Kind) {
  const ready: Record<Kind, string> = {
    overview: '[data-card="improvement"]',
    process: "[data-cost]",
    issue: "h1",
    solution: "[data-measure=mrrAdded]",
  };
  await page.waitForSelector(ready[kind], { timeout: 90_000, state: "attached" });
  // Let the workers' answers land.
  await page.waitForTimeout(kind === "overview" || kind === "process" ? 3000 : 1000);
}

/** The page's own markup, without the (i) texts: those hold fixed examples (they name the sample's people), not the workspace's data. */
const dataMarkup = (page: Page) =>
  page.evaluate(() => {
    const copy = document.body.cloneNode(true) as HTMLElement;
    copy.querySelectorAll('[data-slot="help"], .sr-only').forEach((el) => el.remove());
    return copy.innerHTML;
  });

const EDIT_CONTROLS = /^(Edit|Open in Editor|Analyse|Re-analyse|Accept|Dismiss|Log an issue|Build solution|Build|\+ Link|Link|Share|Save run|Acknowledge|Resolve|Reopen|Delete|Restore)\b/i;

async function editButtons(page: Page): Promise<string[]> {
  return page.evaluate((src) => {
    const re = new RegExp(src, "i");
    return [...document.querySelectorAll("button, a[href], [role=button]")]
      .map((el) => (el.getAttribute("aria-label") || el.textContent || "").trim())
      .filter((t) => re.test(t));
  }, EDIT_CONTROLS.source);
}

const KINDS: Kind[] = ["overview", "process", "issue", "solution"];

describe("a shared view, People off and Financials off", () => {
  for (const kind of KINDS) {
    it(`${kind}: no console error, no network request, no edit control; labels, and money hidden; the revenue is shown`, async () => {
      const { page, errors, requests, names } = await mount(kind, false, false);
      await settled(page, kind);

      const text = await page.locator("body").innerText();
      // The page's own markup (page.content() would include the harness script, which holds the fixtures).
      const html = await dataMarkup(page);
      // The frame.
      expect(text).toContain("Shared view · read only");
      expect(text).toContain("As of 5 Oct 2026");
      expect(text).not.toContain("Link works until");
      expect(text).toContain("People are shown as Team member 1, 2, 3.");
      expect(text).toContain("Costs, margins and overhead are hidden. Revenue is shown.");
      expect(text).toContain("Made with Transpera Flow");
      // Nothing that changes anything.
      expect(await editButtons(page)).toEqual([]);
      // No hidden data on the page: not in the text, not in the markup.
      for (const c of names.clientNames) expect(html, `client ${c}`).not.toContain(c);
      for (const p of names.personNames) expect(html, `person ${p}`).not.toContain(p);
      expect(html).not.toMatch(/@northbeam\.example/);
      expect(text).not.toMatch(/[£$€]\s?4,100|£9,000/);
      // Links to other pages are plain text.
      const live = await page.evaluate(() => [...document.querySelectorAll("a[href]")].filter((a) => !a.hasAttribute("data-share-inert") && /^(\/|$)/.test(a.getAttribute("href") ?? "")).map((a) => a.outerHTML.slice(0, 120)));
      expect(live).toEqual([]);

      if (kind === "process") {
        // Every cost an insight carries reads "—" with the money (i); none is printed.
        expect(await page.locator("[data-money-hidden]").count()).toBeGreaterThan(0);
        expect(text).not.toMatch(/a month \(estimate\)/);
      }
      if (kind === "solution") {
        // Revenue stays: New MRR is on the page with its numbers; the labour cost, which needs role rates, reads "—" with the (i).
        const mrr = await page.locator("[data-measure=mrrAdded]").innerText();
        expect(mrr).toMatch(/£\s?[\d,.]+[kKmM]?/);
        expect(await page.locator("[data-measure=labour] [data-money-hidden]").count()).toBe(1);
      }
      if (kind === "overview" || kind === "process" || kind === "issue") expect(text).toMatch(/Team member \d+/);
      if (kind === "issue") {
        // The issue's cost: "—" with the money (i), and its words carry the label and no money.
        expect(text).toContain("Audits take too long for Client");
        expect(text).toContain("[amount hidden]");
      }
      // Only the harness page itself: no request to any server (the workers are blob scripts).
      expect(requests.filter((u) => !/^(blob:|data:|about:)/.test(u))).toEqual(["https://share.test/"]);
      expect(errors).toEqual([]);
      if (SHOTS) {
        await page.screenshot({ path: `${SHOTS}/${kind}-light-1440.png`, fullPage: false });
      }
      await page.close();
    }, 240_000);
  }

  it("the measures a visitor reads don't change with the toggles: New MRR, wins, cycle time and the bottleneck are the same", async () => {
    const read = async (people: boolean, financials: boolean) => {
      const { page } = await mount("solution", people, financials);
      await settled(page, "solution");
      const rows = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll("[data-measure]")].map((r) => [r.getAttribute("data-measure")!, (r as HTMLElement).innerText.replace(/\s+/g, " ").trim()])));
      await page.close();
      return rows;
    };
    const off = await read(false, false);
    const on = await read(true, true);
    expect(Object.keys(off).length).toBeGreaterThanOrEqual(4);
    expect(off.mrrAdded).toMatch(/£/);
    // Everything but the labour cost (which needs role rates) is equal, to the last digit.
    for (const [metric, value] of Object.entries(off)) {
      if (metric === "labour") continue;
      expect(on[metric], metric).toBe(value);
    }
  }, 240_000);
});

describe("a shared view with the toggles on", () => {
  it("People on shows names (with the line gone), Financials on shows costs and no money hiding", async () => {
    const { page, errors, names } = await mount("process", true, true);
    await settled(page, "process");
    const text = await page.locator("body").innerText();
    expect(text).not.toContain("People are shown as Team member");
    expect(text).not.toContain("Costs, margins and overhead are hidden");
    expect(text).toContain("Link works until 5 Nov 2026");
    expect(names.personNames.some((n) => text.includes(n))).toBe(true);
    expect(await page.locator("[data-money-hidden]").count()).toBe(0);
    // The costs of insights are printed (the toggle shows them); anything that needs one person's pay would still read "—" (no such issue here).
    expect(text).toMatch(/About £[\d,]+ a month \(estimate\)/);
    expect(errors).toEqual([]);
    await page.close();
  }, 240_000);
});

async function mountBare(call: "mountShareDialog" | "mountShareList", arg?: unknown): Promise<{ page: Page; errors: string[] }> {
  const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.route("https://share.test/", (route) => route.fulfill({ contentType: "text/html", body: `<!doctype html><div id="root"></div>` }));
  await page.goto("https://share.test/");
  await page.evaluate((w) => (window.workerScripts = w), workers);
  await page.addScriptTag({ content: script });
  await page.evaluate(([c, a]) => (c === "mountShareDialog" ? window.mountShareDialog() : window.mountShareList(a as never)), [call, arg] as const);
  return { page, errors };
}

describe("the Share dialog", () => {
  it("has an (i) on every field, defaults both switches off, and a switch makes the email field required", async () => {
    const { page, errors } = await mountBare("mountShareDialog");
    await page.click("[data-share-open]");
    await page.waitForSelector("[data-share-dialog]");
    const dialog = page.locator("[data-share-dialog]");
    expect(await dialog.locator("[data-share-what]").innerText()).toBe("Lead to live");
    expect(await dialog.locator("[data-share-people]").getAttribute("aria-checked")).toBe("false");
    expect(await dialog.locator("[data-share-financials]").getAttribute("aria-checked")).toBe("false");
    // Neither switch on: no email field, the date is pre-filled 30 days on, and no end date is allowed.
    expect(await dialog.locator("[data-share-emails]").count()).toBe(0);
    const until = await dialog.locator("[data-share-until]").inputValue();
    expect(until).toBe(new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10));
    expect(await dialog.locator("[data-share-no-end]").isEnabled()).toBe(true);
    // One (i) per field: what is shared, names, costs, until, name (the email field appears with a switch).
    for (const label of ["What's shared", "Show people's names", "Show costs and margins", "Link works until", "Name"]) {
      expect(await dialog.getByRole("button", { name: `About ${label}` }).count(), label).toBe(1);
    }
    await dialog.locator("[data-share-people]").click();
    expect(await dialog.locator("[data-share-emails]").count()).toBe(1);
    expect(await dialog.locator("[data-share-emails]").getAttribute("aria-required")).toBe("true");
    expect(await dialog.getByRole("button", { name: "About Who can open it" }).count()).toBe(1);
    // With a switch on, "No end date" is off the table.
    expect(await dialog.locator("[data-share-no-end]").isDisabled()).toBe(true);
    expect(errors).toEqual([]);
    await page.close();
  });

  it("refuses a link that shows names or costs with no email, and nothing is sent; with one, it makes the link and shows it once", async () => {
    const { page, errors } = await mountBare("mountShareDialog");
    await page.click("[data-share-open]");
    await page.waitForSelector("[data-share-dialog]");
    await page.locator("[data-share-people]").click();
    await page.click("[data-share-create]");
    expect(await page.locator("[data-share-error]").innerText()).toBe("Add at least one email address.");
    expect(await page.evaluate(() => window.shareCreates.length)).toBe(0);
    // A bad address.
    await page.fill("[data-share-emails]", "sam@northbeam.co, not-an-email");
    await page.click("[data-share-create]");
    expect(await page.locator("[data-share-error]").innerText()).toMatch(/not-an-email.*isn.t an email address/);
    // Right: two addresses, once each (case and spacing don't matter).
    await page.fill("[data-share-emails]", "Sam@Northbeam.co,\n ops@northbeam.co  sam@northbeam.co");
    await page.fill("[data-share-name]", "For the board");
    await page.click("[data-share-create]");
    await page.waitForSelector("[data-share-done]");
    const sent = await page.evaluate(() => window.shareCreates);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ kind: "process", targetId: "00000000-0000-4000-8000-0000000000c1", people: true, financials: false, label: "For the board" });
    expect(await page.locator("[data-share-url]").inputValue()).toBe("https://flow.example/s/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcde");
    const done = await page.locator("[data-share-done]").innerText();
    expect(done).toContain("Copy link");
    expect(done).toContain("Copy it now: you won't see this link again. You can turn it off any time on Share links.");
    expect(await page.locator("[data-share-done] a").getAttribute("href")).toBe("/w/northbeam/share");
    expect(errors).toEqual([]);
    await page.close();
  });

  it("'Let people try changes' is off by default, has an (i), and a process link made with it on is a play link; the done text says where the ideas go (B4)", async () => {
    const { page, errors } = await mountBare("mountShareDialog");
    await page.click("[data-share-open]");
    await page.waitForSelector("[data-share-dialog]");
    expect(await page.locator("[data-share-play]").getAttribute("aria-checked")).toBe("false");
    expect(await page.getByRole("button", { name: "About Let people try changes" }).count()).toBe(1);
    expect(await page.locator("[data-share-dialog]").innerText()).toContain("Let people try changes");
    await page.locator("[data-share-no-end]").check();
    await page.click("[data-share-create]");
    await page.waitForSelector("[data-share-done]");
    expect((await page.evaluate(() => window.shareCreates))[0]).toMatchObject({ play: false });
    expect(await page.locator("[data-share-play-done]").count()).toBe(0);
    await page.close();

    const again = await mountBare("mountShareDialog");
    await again.page.click("[data-share-open]");
    await again.page.waitForSelector("[data-share-dialog]");
    await again.page.click("[data-share-play]");
    await again.page.locator("[data-share-no-end]").check();
    await again.page.click("[data-share-create]");
    await again.page.waitForSelector("[data-share-done]");
    expect((await again.page.evaluate(() => window.shareCreates))[0]).toMatchObject({ kind: "process", play: true });
    expect(await again.page.locator("[data-share-play-done]").innerText()).toBe("People who open it can send you ideas. You'll find them in Suggestions.");
    expect(errors).toEqual([]);
    await again.page.close();
  });

  it("a play link in the Share links table says 'Try changes' and how many ideas were sent, linking to Suggestions; a view link shows —", async () => {
    const view: ShareLinkRow = { id: "00000000-0000-4000-8000-00000000f010", kind: "process", mode: "view", ideas: null, what: "Lead to live", label: null, showPeople: false, showFinancials: false, emails: [], expiresAt: null, snapshotAt: "2026-10-01T09:00:00Z", createdAt: "2026-10-01T09:00:00Z", madeBy: "Maya Collins", opens: 0, lastOpenedAt: null, status: "active" };
    const play: ShareLinkRow = { ...view, id: "00000000-0000-4000-8000-00000000f011", mode: "play", ideas: 3 };
    const none: ShareLinkRow = { ...view, id: "00000000-0000-4000-8000-00000000f012", mode: "play", ideas: 0 };
    const { page, errors } = await mountBare("mountShareList", [view, play, none]);
    await page.waitForSelector("[data-share-links]");
    const rows = page.locator("[data-share-link]");
    expect(await rows.nth(0).locator("[data-share-play]").count()).toBe(0);
    expect(await rows.nth(0).locator("[data-share-ideas]").innerText()).toBe("—");
    expect(await rows.nth(1).locator("[data-share-play]").innerText()).toBe("Try changes");
    expect(await rows.nth(1).locator("[data-share-ideas]").innerText()).toBe("3 sent");
    expect(await rows.nth(1).locator("[data-share-ideas] a").getAttribute("href")).toBe("/w/northbeam/suggestions");
    expect(await rows.nth(2).locator("[data-share-ideas]").innerText()).toBe("None sent");
    expect(await page.getByRole("button", { name: "About Ideas" }).count()).toBe(1);
    expect(errors).toEqual([]);
    await page.close();
  });

  it("an open link needs no emails and no end date: Create works with both switches off", async () => {
    const { page } = await mountBare("mountShareDialog");
    await page.click("[data-share-open]");
    await page.waitForSelector("[data-share-dialog]");
    await page.locator("[data-share-no-end]").check();
    await page.click("[data-share-create]");
    await page.waitForSelector("[data-share-done]");
    expect((await page.evaluate(() => window.shareCreates))[0]).toMatchObject({ people: false, financials: false, expiresOn: null });
    await page.close();
  });

  it("shows the server's refusal in plain words, inline", async () => {
    const { page } = await mountBare("mountShareDialog");
    await page.evaluate(() => (window.shareAnswer = { status: "error", message: "Couldn't make a safe copy of this page. Nothing was shared." }));
    await page.click("[data-share-open]");
    await page.waitForSelector("[data-share-dialog]");
    await page.click("[data-share-create]");
    await page.waitForSelector("[data-share-error]");
    expect(await page.locator("[data-share-error]").innerText()).toBe("Couldn't make a safe copy of this page. Nothing was shared.");
    expect(await page.locator("[data-share-url]").count()).toBe(0);
    await page.close();
  });
});

describe("the Share links table", () => {
  const link = (over: Partial<ShareLinkRow>): ShareLinkRow => ({
    id: "00000000-0000-4000-8000-00000000f001",
    kind: "overview",
    mode: "view",
    ideas: null,
    what: "The Overview",
    label: null,
    showPeople: false,
    showFinancials: false,
    emails: [],
    expiresAt: null,
    snapshotAt: "2026-10-01T09:00:00Z",
    createdAt: "2026-10-01T09:00:00Z",
    madeBy: "Maya Collins",
    opens: 0,
    lastOpenedAt: null,
    status: "active",
    ...over,
  });

  it("lists each link with what it shows, who, until when, opens and status; each action has an (i); nothing about the copy", async () => {
    const links = [
      link({}),
      link({ id: "00000000-0000-4000-8000-00000000f002", kind: "process", what: "Lead to live", label: "For the board", showPeople: true, showFinancials: true, emails: ["sam@northbeam.co", "ops@northbeam.co"], expiresAt: "2026-11-05T23:59:59Z", opens: 3, lastOpenedAt: "2026-10-05T10:00:00Z" }),
      link({ id: "00000000-0000-4000-8000-00000000f003", kind: "issue", what: null, status: "expired", expiresAt: "2026-09-01T23:59:59Z" }),
      link({ id: "00000000-0000-4000-8000-00000000f004", status: "off" }),
    ];
    const { page, errors } = await mountBare("mountShareList", links);
    await page.waitForSelector("[data-share-links]");
    const rows = page.locator("[data-share-link]");
    expect(await rows.count()).toBe(4);
    const second = (await rows.nth(1).innerText()).replace(/\s+/g, " ");
    expect(second).toContain("Lead to live");
    expect(second).toContain("For the board");
    expect(second).toContain("Names");
    expect(second).toContain("Costs and margins");
    expect(second).toContain("2 people");
    expect(second).toContain("5 Nov 2026");
    expect(second).toContain("3 times, last 5 Oct");
    expect(await rows.nth(1).locator("td[title]").getAttribute("title")).toBe("sam@northbeam.co, ops@northbeam.co");
    const first = (await rows.nth(0).innerText()).replace(/\s+/g, " ");
    expect(first).toContain("Team member labels");
    expect(first).toContain("Revenue only");
    expect(first).toContain("Anyone with the link");
    expect(first).toContain("No end date");
    expect(first).toContain("Not yet");
    expect(first).toContain("Maya Collins");
    expect(await rows.nth(2).innerText()).toContain("(deleted)");
    expect(await rows.nth(0).getAttribute("data-status")).toBe("active");
    expect(await rows.nth(2).getAttribute("data-status")).toBe("expired");
    expect(await rows.nth(3).getAttribute("data-status")).toBe("off");
    // A turned-off link has no actions; the rest have both, each with its (i).
    expect(await rows.nth(3).locator("button").count()).toBe(0);
    expect(await rows.nth(0).getByRole("button", { name: "About Update copy" }).count()).toBe(1);
    expect(await rows.nth(0).getByRole("button", { name: "About Turn off" }).count()).toBe(1);
    expect(errors).toEqual([]);
    await page.close();
  });

  it("Update copy asks for the update; Turn off asks to confirm first, then turns it off", async () => {
    const { page } = await mountBare("mountShareList", [link({})]);
    await page.waitForSelector("[data-share-links]");
    await page.click("[data-share-update]");
    await page.waitForSelector("[data-share-message]");
    expect(await page.evaluate(() => window.shareRefreshes)).toEqual(["00000000-0000-4000-8000-00000000f001"]);
    expect(await page.locator("[data-share-message]").innerText()).toBe("The copy is up to date.");
    await page.click("[data-share-off]");
    expect(await page.evaluate(() => window.shareRevokes)).toEqual([]);
    expect(await page.locator("[data-share-confirm]").innerText()).toContain("Turn it off for good?");
    await page.click("[data-share-off-yes]");
    await page.waitForFunction(() => window.shareRevokes.length === 1);
    expect(await page.locator("[data-share-message]").innerText()).toBe("The link is turned off.");
    await page.close();
  });

  it("says what to do when nothing is shared yet", async () => {
    const { page } = await mountBare("mountShareList", []);
    await page.waitForSelector("[data-share-empty]");
    expect(await page.locator("[data-share-empty]").innerText()).toBe("Nothing shared yet. Use Share on the Overview, a process, an issue or a solution.");
    await page.close();
  });
});

describe("screenshots (set SHARE_SHOTS_DIR)", () => {
  it.skipIf(!SHOTS)("light and dark, at 1440 and 400 px", async () => {
    for (const kind of KINDS) {
      for (const scheme of ["light", "dark"] as const) {
        for (const width of [1440, 400]) {
          const { page, errors } = await mount(kind, false, false, { width, height: width === 400 ? 900 : 1100 }, scheme);
          await settled(page, kind);
          await page.screenshot({ path: `${SHOTS}/${kind}-${scheme}-${width}.png`, fullPage: false });
          expect(errors).toEqual([]);
          await page.close();
        }
      }
    }
  }, 600_000);
});
