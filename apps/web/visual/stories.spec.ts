// One screenshot per story and theme (and per story at 400 px when tagged `visual-phone`), compared with the committed baselines.
// The stories come from the built Storybook's index.json: build it first (`pnpm build-storybook`).
import { expect, test } from "@playwright/test";
import { canvasTypes, readShots, readStories } from "./names.mjs";

const shots = readShots();

// Every node and edge type the canvas registers must be drawn by at least one map story, so adding a type without a story fails here.
test("the map stories draw every node and edge type the canvas defines", async ({ page }) => {
  const { nodes, edges } = canvasTypes();
  expect(nodes.length).toBeGreaterThan(0);
  expect(edges.length).toBeGreaterThan(0);
  const drawn = new Set<string>();
  for (const story of readStories().filter((s) => s.id.startsWith("map-processcanvas--"))) {
    await page.goto(`/iframe.html?id=${story.id}&viewMode=story`);
    await page.waitForSelector(".react-flow__viewport", { state: "attached" });
    await page.waitForTimeout(500);
    const classes = await page.evaluate(() => [...document.querySelectorAll('[class*="react-flow__node-"], [class*="react-flow__edge-"]')].flatMap((el) => [...el.classList]));
    for (const c of classes) drawn.add(c);
  }
  const missing = [...nodes.map((n) => `react-flow__node-${n}`), ...edges.map((e) => `react-flow__edge-${e}`)].filter((c) => !drawn.has(c));
  expect(missing, `No map story draws: ${missing.join(", ")}`).toEqual([]);
});

for (const shot of shots) {
  test(`${shot.id} ${shot.theme}${shot.phone ? " 400" : ""}`, async ({ page }) => {
    const whole = shot.tags.includes("visual-page");
    await page.setViewportSize(shot.phone ? { width: 400, height: 900 } : { width: 1280, height: 800 });
    // prefers-color-scheme agrees with data-theme, so tokens, `dark:` variants and native controls all follow the theme.
    await page.emulateMedia({ colorScheme: shot.theme as "light" | "dark", reducedMotion: "reduce" });
    // Relative dates ("3 days ago") stay put; timers still run.
    await page.clock.setFixedTime(new Date("2026-10-05T09:00:00Z"));

    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => {
      // The browser asks for /favicon.ico by itself; the static Storybook has none, which is not the story's error.
      if (m.type() === "error" && !m.location().url.endsWith("/favicon.ico")) errors.push(`${m.text()} (${m.location().url})`);
    });

    await page.goto(`/iframe.html?id=${shot.id}&viewMode=story&globals=theme:${shot.theme}`);
    // An open modal locks the body's scroll and can leave it with no visible box, so a whole-page story waits for it to be attached.
    await page.waitForSelector(whole ? "body.sb-show-main" : "#storybook-root > *", { state: whole ? "attached" : "visible" });
    expect(await page.evaluate(() => document.body.classList.contains("sb-show-errordisplay"))).toBe(false);

    // A font that silently falls back is the commonest cross-machine difference.
    // Load it explicitly (a story with no text never asks for it), then check it is really there: `load` finds the font face
    // (none means the @fontsource CSS did not ship) and `check` says it is usable.
    const faces = await page.evaluate(async () => (await document.fonts.load('16px "Inter Variable"')).length);
    expect(faces).toBeGreaterThan(0);
    await page.evaluate(() => document.fonts.ready);
    expect(await page.evaluate(() => document.fonts.check('16px "Inter Variable"'))).toBe(true);

    // A story that needs time to reach its picture (a highlight applied after the map has framed) marks itself
    // `data-visual-pending` until it is ready.
    await page.waitForFunction(() => !document.querySelector("[data-visual-pending]"), undefined, { timeout: 15_000 });

    // React Flow fits its view with a short animation: wait until the viewport holds still for two frames.
    if (await page.locator(".react-flow__viewport").count()) {
      await page.waitForFunction(
        () =>
          new Promise<boolean>((resolve) => {
            const t = () => document.querySelector<HTMLElement>(".react-flow__viewport")?.style.transform ?? "";
            const before = t();
            requestAnimationFrame(() => requestAnimationFrame(() => resolve(t() === before)));
          }),
        undefined,
        { timeout: 10_000 },
      );
    }

    // At 400 px nothing may make the page scroll sideways (a chart's hidden table escaping its card did, in a story frame without the real Card).
    if (shot.phone) expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);

    await page.mouse.move(0, 0);
    const target = whole ? page : page.locator("#storybook-root");
    await expect(target).toHaveScreenshot(shot.name);
    expect(errors).toEqual([]);
  });
}
