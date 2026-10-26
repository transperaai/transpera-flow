import { expect, test, type Page } from "@playwright/test";
import { open, watchErrors } from "./checks";

// The company map's tall panel and the buttons on every map (Austin, 8 Oct: "make the company map bigger" and "add React Flow's
// buttons to centre the screen"), against the real CSS: the Overview's map is a tall share of the screen, and the zoom and fit
// buttons are on each demo map at 1280 px and on a phone, where they are reading actions and stay.
const PROCESS = "/demo/p/c0000000-0000-4000-8000-000000000001";
const MAPS = ["/demo/overview", PROCESS, "/demo/issues/1"];

/** The height of the Overview's company map canvas (the React Flow pane, without the bars above it). */
const companyMapHeight = (page: Page) => page.locator("[data-company-map] .react-flow").evaluate((el) => el.getBoundingClientRect().height);

test.describe("the company map's height", () => {
  for (const [name, viewport, least] of [
    // 75% of 800 px; it was 355 px for Northbeam, as tall as the map's cards needed.
    ["1280 x 800", { width: 1280, height: 800 }, 560],
    ["1440 x 900", { width: 1440, height: 900 }, 640],
    // On a phone 60% of the screen, at most 28 rem, so the page still scrolls past it.
    ["400 x 900", { width: 400, height: 900 }, 320],
  ] as const) {
    test(`is at least ${least} px tall at ${name}`, async ({ page }) => {
      await page.setViewportSize(viewport);
      const errors = watchErrors(page);
      await open(page, "/demo/overview");
      const height = await companyMapHeight(page);
      expect(height).toBeGreaterThanOrEqual(least);
      expect(height).toBeLessThanOrEqual(viewport.height);
      expect(errors.list()).toEqual([]);
    });
  }
});

for (const [name, viewport] of [["1280", { width: 1280, height: 800 }], ["400", { width: 400, height: 900 }]] as const) {
  test.describe(`the buttons on the map, ${name}px`, () => {
    test.use({ viewport });
    for (const path of MAPS) {
      test(path, async ({ page }) => {
        const errors = watchErrors(page);
        await open(page, path);
        const map = page.locator("[data-process-map]").first();
        for (const label of ["Zoom in", "Zoom out", "Fit the map to view"]) await expect(map.getByRole("button", { name: label, exact: true })).toBeVisible();
        await expect(map.locator(".react-flow__controls-interactive")).toHaveCount(0);
        // The buttons sit inside the map's frame.
        const frame = (await map.locator(".react-flow").boundingBox())!;
        const panel = (await map.locator(".react-flow__controls").boundingBox())!;
        expect(panel.x).toBeGreaterThanOrEqual(frame.x);
        expect(panel.x + panel.width).toBeLessThanOrEqual(frame.x + frame.width + 0.5);
        expect(panel.y).toBeGreaterThanOrEqual(frame.y);
        expect(panel.y + panel.height).toBeLessThanOrEqual(frame.y + frame.height + 0.5);
        // Zoom in changes the zoom, fit brings it back.
        const level = map.locator("[data-map-zoom-level]");
        const before = await level.textContent();
        await map.getByRole("button", { name: "Zoom in", exact: true }).click();
        await expect(level).not.toHaveText(before!);
        await map.getByRole("button", { name: "Fit the map to view", exact: true }).click();
        await expect(level).toHaveText(before!);
        expect(errors.list()).toEqual([]);
      });
    }
  });
}
