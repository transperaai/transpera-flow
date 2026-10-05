import { build } from "esbuild";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PROCESS_FILE_EXAMPLE } from "@transpera-flow/db/process-file";
import { claudePrompt2, PROCESS_FILE_EXAMPLE_2 } from "@transpera-flow/db/process-file-2-schema";
import type { HarnessCompany } from "./upload-harness/entry";

// The Upload process dialog in a real browser (issue #166, B13): choosing a file, the preview with its errors and
// warnings, mapping a role the company doesn't have, and the two helpers ("Copy prompt for Claude", "Download example").
// The server is stood in for by the real file checker and a fixed company (upload-harness/entry.tsx), so this is the
// dialog's own behaviour; the write itself is tested over PostgREST (packages/mcp/test/postgrest-import-file.test.ts).

let browser: Browser;
let context: BrowserContext;
let script: string;

const COMPANY: HarnessCompany = {
  roles: [
    { id: "10000000-0000-4000-8000-000000000001", name: "Account manager" },
    { id: "10000000-0000-4000-8000-000000000002", name: "Consultant" },
  ],
  processes: ["Existing process"],
};

const json = (o: unknown) => JSON.stringify(o, null, 2);
// Typed loosely on purpose: the tests break a file in one way at a time, by reaching into it.
const example = () => JSON.parse(JSON.stringify(PROCESS_FILE_EXAMPLE));
const file = (name: string, text: string) => ({ name, mimeType: "application/json", buffer: Buffer.from(text) });

beforeAll(async () => {
  const out = await build({
    entryPoints: [fileURLToPath(new URL("./upload-harness/entry.tsx", import.meta.url))],
    bundle: true,
    format: "iife",
    platform: "browser",
    write: false,
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' },
    alias: { "@": fileURLToPath(new URL("../src", import.meta.url)) },
    logLevel: "silent",
  });
  script = out.outputFiles[0]!.text;
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  context = await browser.newContext({ acceptDownloads: true, permissions: ["clipboard-read", "clipboard-write"] });
}, 120_000);

afterAll(async () => {
  await context?.close();
  await browser?.close();
});

async function mount(company: HarnessCompany = COMPANY): Promise<{ page: Page; errors: string[] }> {
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  // A secure origin (as the app is), so the clipboard exists.
  await page.route("https://upload.test/", (route) => route.fulfill({ contentType: "text/html", body: `<!doctype html><div id="root"></div>` }));
  await page.goto("https://upload.test/");
  await page.addScriptTag({ content: script });
  await page.evaluate((c) => window.mountUpload(c), company);
  await page.waitForSelector("[data-upload-dialog]");
  return { page, errors };
}

/** Choose a file in the open dialog and wait for the preview (or the error) to show. */
async function choose(page: Page, f: ReturnType<typeof file>, next: "preview" | "error" = "preview") {
  await page.setInputFiles("#upload-file", f);
  await page.waitForSelector(next === "preview" ? "[data-upload-step=preview]" : "[data-upload-error]");
}

describe("the Upload process dialog", () => {
  it("offers a file drop, 'Copy prompt for Claude' and 'Download example'", async () => {
    const { page, errors } = await mount();
    await page.getByText("Drop a .json or .html file here, or choose one").waitFor();
    expect(await page.getByRole("button", { name: "Copy prompt for Claude" }).count()).toBe(1);
    expect(await page.getByRole("link", { name: "Download example" }).count()).toBe(1);
    expect(errors).toEqual([]);
    await page.close();
  }, 60_000);

  it("copies the prompt (with the schema and the example) to the clipboard", async () => {
    const { page, errors } = await mount();
    await page.getByRole("button", { name: "Copy prompt for Claude" }).click();
    await page.getByRole("button", { name: "Copied" }).waitFor();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(claudePrompt2());
    expect(errors).toEqual([]);
    await page.close();
  }, 60_000);

  it("downloads the example, which is the published worked example", async () => {
    const { page } = await mount();
    const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("link", { name: "Download example" }).click()]);
    expect(download.suggestedFilename()).toBe("transpera-process-example.json");
    const { readFile } = await import("node:fs/promises");
    expect(JSON.parse(await readFile((await download.path())!, "utf8"))).toEqual(PROCESS_FILE_EXAMPLE_2);
    await page.close();
  }, 60_000);

  it("previews a good file: name, counts, matched roles, and creates only when asked", async () => {
    const f = example();
    f.steps[1].role = "consultant";
    f.steps[3].role = "Account manager";
    const { page, errors } = await mount();
    await choose(page, file("process.json", json(f)));
    expect(await page.locator("#upload-name").inputValue()).toBe("Enquiry to signed client");
    expect(await page.locator("[data-upload-counts]").innerText()).toBe("8 steps · 7 links · a pipeline");
    expect(await page.locator("[data-upload-roles]").innerText()).toContain("Matched to your roles by name: Consultant");
    expect(await page.locator("[data-upload-problems]").count()).toBe(0);
    expect(await page.evaluate(() => window.uploads)).toEqual([]);
    await page.locator("#upload-name").fill("My renamed process");
    await page.locator("[data-upload-create]").click();
    await page.waitForFunction(() => window.uploads.length === 1);
    expect(await page.evaluate(() => window.uploads[0])).toMatchObject({ source: "process.json", name: "My renamed process", roleMap: [["Managing director", null]] });
    expect(errors).toEqual([]);
    await page.close();
  }, 60_000);

  it("asks for each unknown role to be mapped to one of the company's roles or left blank, and sends the choices", async () => {
    const f = example();
    f.steps[1].role = "Sales lead";
    f.steps[2].role = "Founder";
    const { page } = await mount();
    await choose(page, file("roles.json", json(f)));
    const text = await page.locator("[data-upload-roles]").innerText();
    expect(text).toContain("These roles aren't ones you have");
    expect(text).toContain("“Sales lead”");
    expect(text).toContain("“Founder”");
    // The company's roles are offered, and "no role" is the starting choice: nothing is created, and nothing is silent.
    const options = await page.locator("#upload-role-0 option").allInnerTexts();
    expect(options).toEqual(["No role (leave blank)", "Account manager", "Consultant"]);
    expect(await page.locator("#upload-role-0").inputValue()).toBe("");
    await page.selectOption("#upload-role-0", { label: "Consultant" });
    await page.locator("[data-upload-create]").click();
    await page.waitForFunction(() => window.uploads.length === 1);
    expect(await page.evaluate(() => window.uploads[0]!.roleMap)).toEqual([["Sales lead", COMPANY.roles[1]!.id], ["Founder", null]]);
    await page.close();
  }, 60_000);

  it("shows warnings in plain words and still allows creating", async () => {
    const f = example();
    f.links[5].probability = 0.5;
    f.colour = "red";
    const { page } = await mount();
    await choose(page, file("warn.json", json(f)));
    const warnings = await page.locator("[data-upload-problems=warning]").innerText();
    expect(warnings).toContain("Decision 'Client decides' branches add up to 0.9, not 1.");
    expect(warnings).toContain("The file has a field 'colour' that Transpera doesn't use. It was ignored.");
    expect(await page.locator("[data-upload-create]").isEnabled()).toBe(true);
    await page.close();
  }, 60_000);

  it("stops at errors, names the problem, and offers a different file", async () => {
    const f = example();
    f.links[1].to = "cal";
    const { page } = await mount();
    await choose(page, file("bad.json", json(f)));
    expect(await page.locator("[data-upload-problems=error]").innerText()).toContain("Link from 'review' goes to 'cal', which isn't a step. Did you mean 'call'?");
    expect(await page.locator("[data-upload-create]").count()).toBe(0);
    expect(await page.locator("#upload-name").count()).toBe(0);
    await page.getByRole("button", { name: "Choose a different file" }).click();
    await page.getByText("Drop a .json or .html file here, or choose one").waitFor();
    // The same file name can be chosen again after fixing it.
    f.links[1].to = "call";
    await choose(page, file("bad.json", json(f)));
    expect(await page.locator("[data-upload-create]").isEnabled()).toBe(true);
    await page.close();
  }, 60_000);

  it("says plainly when the file isn't JSON, or isn't this format", async () => {
    const { page } = await mount();
    await choose(page, file("notes.json", "Step 1: do a thing"));
    expect(await page.locator("[data-upload-problems=error]").innerText()).toMatch(/isn't valid JSON/);
    await page.getByRole("button", { name: "Choose a different file" }).click();
    await choose(page, file("other.json", json({ ...example(), format: "bpmn" })));
    expect(await page.locator("[data-upload-problems=error]").innerText()).toContain("says its format is 'bpmn', but Transpera reads 'transpera-process/1'");
    await page.close();
  }, 60_000);

  it("refuses a file that is far too big without sending it", async () => {
    const { page } = await mount();
    await choose(page, file("huge.json", `{"pad":"${"x".repeat(600_000)}"}`), "error");
    expect(await page.locator("[data-upload-error]").innerText()).toMatch(/probably the wrong file/);
    expect(await page.evaluate(() => window.previews)).toBe(0);
    await page.close();
  }, 60_000);

  it("won't create a process with a name that is taken, and says so next to the name", async () => {
    const f = example();
    f.name = "Existing process";
    const { page } = await mount();
    await choose(page, file("taken.json", json(f)));
    expect(await page.locator("[data-upload-taken]").innerText()).toBe("You already have a process called 'Existing process'. Give this one a different name.");
    expect(await page.locator("[data-upload-create]").isDisabled()).toBe(true);
    await page.locator("#upload-name").fill("Existing process 2");
    expect(await page.locator("[data-upload-taken]").count()).toBe(0);
    expect(await page.locator("[data-upload-create]").isEnabled()).toBe(true);
    await page.close();
  }, 60_000);

  it("shows an error from the server and stays open", async () => {
    const { page } = await mount({ ...COMPANY, createError: "You don't have permission to add processes here." });
    await choose(page, file("process.json", json(example())));
    await page.locator("[data-upload-create]").click();
    await page.waitForSelector("[data-upload-error]");
    expect(await page.locator("[data-upload-error]").innerText()).toBe("You don't have permission to add processes here.");
    expect(await page.locator("[data-upload-create]").isEnabled()).toBe(true);
    await page.close();
  }, 60_000);

  it("keeps a role choice per role even when roles are called constructor or __proto__", async () => {
    const f = example();
    f.steps[1].role = "constructor";
    f.steps[2].role = "__proto__";
    f.steps[3].role = "toString";
    const { page } = await mount();
    await choose(page, file("odd-roles.json", json(f)));
    expect(await page.locator("[data-upload-roles] label").allInnerTexts()).toEqual(["“constructor”", "“__proto__”", "“toString”"]);
    expect(await page.locator("#upload-role-0").inputValue()).toBe("");
    await page.selectOption("#upload-role-1", { label: "Consultant" });
    expect(await page.locator("#upload-role-0").inputValue()).toBe("");
    expect(await page.locator("#upload-role-2").inputValue()).toBe("");
    await page.locator("[data-upload-create]").click();
    await page.waitForFunction(() => window.uploads.length === 1);
    expect(await page.evaluate(() => window.uploads[0]!.roleMap)).toEqual([["constructor", null], ["__proto__", COMPANY.roles[1]!.id], ["toString", null]]);
    await page.close();
  }, 60_000);

  it("says plainly when creating fails, and does not mistake the redirect to the editor for a failure", async () => {
    const failing = await mount({ ...COMPANY, createThrows: "failure" });
    await choose(failing.page, file("process.json", json(example())));
    await failing.page.locator("[data-upload-create]").click();
    await failing.page.waitForSelector("[data-upload-error]");
    expect(await failing.page.locator("[data-upload-error]").innerText()).toBe("Couldn't create it. Try again.");
    await failing.page.close();

    const redirecting = await mount({ ...COMPANY, createThrows: "redirect" });
    await choose(redirecting.page, file("process.json", json(example())));
    await redirecting.page.locator("[data-upload-create]").click();
    await redirecting.page.waitForFunction(() => window.uploads.length === 1);
    await redirecting.page.waitForTimeout(300);
    expect(await redirecting.page.locator("[data-upload-error]").count()).toBe(0);
    await redirecting.page.close();
  }, 60_000);

  it("lists the first 20 warnings and counts the rest", async () => {
    const f = example();
    for (let i = 0; i < 30; i++) f[`extra${i}`] = i;
    const { page } = await mount();
    await choose(page, file("noisy.json", json(f)));
    const items = await page.locator("[data-upload-problems=warning] li").allInnerTexts();
    expect(items).toHaveLength(21);
    expect(items.at(-1)).toBe("…and 10 more.");
    await page.close();
  }, 60_000);

  it("takes an HTML file, reading only its embedded process block", async () => {
    const html = `<!doctype html><html><head><script>var decoy = {"format":"transpera-process/1","name":"Decoy"};</script></head><body><svg></svg><script type="application/vnd.transpera-process+json">${json(example())}</script></body></html>`;
    const { page, errors } = await mount();
    await page.setInputFiles("#upload-file", { name: "design.html", mimeType: "text/html", buffer: Buffer.from(html) });
    await page.waitForSelector("[data-upload-step=preview]");
    expect(await page.locator("#upload-name").inputValue()).toBe("Enquiry to signed client");
    expect(await page.locator("[data-upload-counts]").innerText()).toBe("8 steps · 7 links · a pipeline");
    await page.locator("[data-upload-create]").click();
    await page.waitForFunction(() => window.uploads.length === 1);
    // What is sent on is the process text, not the page, and the change log names the file.
    expect(await page.evaluate(() => window.uploads[0])).toMatchObject({ source: "design.html" });
    expect(JSON.parse(await page.evaluate(() => window.uploads[0]!.text)).name).toBe("Enquiry to signed client");
    expect(errors).toEqual([]);
    await page.close();
  }, 60_000);

  it("says plainly when an HTML file has no process block, and points to the prompt", async () => {
    const { page } = await mount();
    await page.setInputFiles("#upload-file", { name: "plain.html", mimeType: "text/html", buffer: Buffer.from("<html><body><svg></svg></body></html>") });
    await page.waitForSelector("[data-upload-error]");
    const text = await page.locator("[data-upload-error]").innerText();
    expect(text).toContain("This page has no Transpera process in it");
    expect(text).toContain("Copy prompt for Claude");
    expect(await page.evaluate(() => window.previews)).toBe(0);
    await page.close();
  }, 60_000);

  it("takes a link: the server fetches it, and the preview is the same as for a file, with the link as the source", async () => {
    const url = "https://claude.example/design/abc";
    const page$ = `<html><body><script type="application/vnd.transpera-process+json">${json(example())}</script></body></html>`;
    const { page } = await mount({ ...COMPANY, links: { [url]: page$ } });
    expect(await page.locator("[data-upload-fetch]").isDisabled()).toBe(true);
    await page.locator("#upload-link").fill(url);
    await page.locator("#upload-link").press("Enter");
    await page.waitForSelector("[data-upload-step=preview]");
    expect(await page.locator("[data-upload-counts]").innerText()).toBe("8 steps · 7 links · a pipeline");
    expect(await page.locator("[data-upload-step=preview]").innerText()).toContain(url);
    await page.locator("[data-upload-create]").click();
    await page.waitForFunction(() => window.uploads.length === 1);
    expect(await page.evaluate(() => window.uploads[0])).toMatchObject({ source: url, name: "Enquiry to signed client" });
    await page.close();
  }, 60_000);

  it("shows what is wrong with a link in plain words: not found, and a page with no block", async () => {
    const page$ = "<html><body>Just a drawing</body></html>";
    const { page } = await mount({ ...COMPANY, links: { "https://claude.example/blank": page$ } });
    await page.locator("#upload-link").fill("https://nowhere.example/x");
    await page.locator("[data-upload-fetch]").click();
    await page.waitForSelector("[data-upload-error]");
    expect(await page.locator("[data-upload-error]").innerText()).toContain("Couldn't find that web address");
    await page.locator("#upload-link").fill("https://claude.example/blank");
    await page.locator("[data-upload-fetch]").click();
    await page.waitForFunction(() => document.querySelector("[data-upload-error]")?.textContent?.includes("no Transpera process"));
    expect(await page.locator("[data-upload-step=preview]").count()).toBe(0);
    await page.close();
  }, 60_000);
});

// A /2 file (issue #167): counts per section, what waits for review, conflicts, and "Missing for simulation".
describe("the Upload process dialog with a transpera-process/2 file", () => {
  const v2 = () => JSON.parse(JSON.stringify(PROCESS_FILE_EXAMPLE_2));
  /** The company has the example's roles, so only roles a test changes are unknown. */
  const WITH_MD: HarnessCompany = { ...COMPANY, roles: [...COMPANY.roles, { id: "10000000-0000-4000-8000-000000000003", name: "Managing director" }] };

  it("shows the counts per section, what waits in Suggestions, and says nothing is applied", async () => {
    const { page, errors } = await mount();
    await choose(page, file("v2.json", json(v2())));
    expect(await page.locator("[data-upload-counts]").innerText()).toBe("8 steps · 7 links · a pipeline");
    expect(await page.locator("[data-upload-extra-counts]").innerText()).toBe("3 sources · 4 suggestions · 1 proposal · first principles: 3 parts");
    const extras = await page.locator("[data-upload-extras]").innerText();
    expect(extras).toContain("Interview with Maya Chen, managing director");
    expect(extras).toContain("Nothing about your company changes until then.");
    expect(extras).toContain("The file suggests adding service Monthly retainer");
    expect(extras).toContain("Issue: Proposals sit for a day before review");
    expect(await page.locator("[data-upload-problems=error]").count()).toBe(0);
    expect(errors).toEqual([]);
    await page.close();
  }, 60_000);

  it("lists the conflicts between the file's sources, and goes ahead", async () => {
    const f = v2();
    f.sources.push({ id: "lead-notes", title: "Sales call notes", kind: "notes", speakers: [] });
    f.steps.find((s: { id: string }) => s.id === "proposal").evidence.hands_on_hours.push({ source: "lead-notes", time: "page 1", quote: "A proposal takes a day.", value: 7.5 });
    const { page } = await mount();
    await choose(page, file("conflict.json", json(f)));
    const conflicts = await page.locator("[data-upload-problems=conflicts]").innerText();
    expect(conflicts).toContain("Conflicts (nothing is changed for you)");
    expect(conflicts).toContain("Step 'Write proposal': the sources disagree on hands-on time");
    expect(await page.locator("[data-upload-create]").isEnabled()).toBe(true);
    await page.close();
  }, 60_000);

  it("says what is wrong with a v2 file in plain words and stops: a quote from a source that isn't listed", async () => {
    const f = v2();
    f.steps[1].evidence.hands_on_hours[0].source = "interview-mayo";
    const { page } = await mount();
    await choose(page, file("bad.json", json(f)));
    const text = await page.locator("[data-upload-problems=error]").innerText();
    expect(text).toContain("cites the source 'interview-mayo', which isn't in the file's sources. Did you mean 'interview-maya'?");
    expect(await page.locator("[data-upload-create]").count()).toBe(0);
    await page.close();
  }, 60_000);

  it("lists what is missing for simulation, by step, in plain words, and never blocks the upload", async () => {
    const f = v2();
    delete f.steps[3].hands_on_hours;
    delete f.steps[3].evidence;
    delete f.links[5].probability;
    delete f.links[6].probability;
    f.steps[2].role = "Sales lead";
    const { page } = await mount(WITH_MD);
    await choose(page, file("gaps.json", json(f)));
    const gaps = await page.locator("[data-upload-gaps]").innerText();
    expect(gaps).toContain("Missing for simulation (4)");
    expect(gaps).toContain("Discovery call has no role");
    expect(gaps).toContain("Write proposal has no hands-on time");
    expect(gaps).toContain("Client decides: branch odds missing");
    expect(gaps).toContain("No incoming volume yet: accept the lead volume suggestion, or add it in Settings");
    expect(await page.locator("[data-upload-create]").isEnabled()).toBe(true);
    // Mapping the unknown role to one of the company's clears that gap, live; a role left blank keeps it.
    await page.locator("#upload-role-0").selectOption({ label: "Consultant" });
    const after = await page.locator("[data-upload-gaps]").innerText();
    expect(after).toContain("Missing for simulation (3)");
    expect(after).not.toContain("Discovery call has no role");
    await page.close();
  }, 60_000);

  it("shows no Missing for simulation group when nothing is missing", async () => {
    const f = v2();
    f.company.demand = undefined;
    const { page } = await mount({ ...WITH_MD, hasVolume: true });
    await choose(page, file("whole.json", json(f)));
    await page.waitForSelector("[data-upload-counts]");
    expect(await page.locator("[data-upload-gaps]").count()).toBe(0);
    await page.close();
  }, 60_000);
});

